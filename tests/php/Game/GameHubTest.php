<?php

declare(strict_types=1);

namespace Knock\Tests\Game;

use Arcade\Support\StdoutLogger;
use Knock\Engine\Rules;
use Knock\Game\Client;
use Knock\Game\ClientStatus;
use Knock\Game\GameHub;
use Knock\Game\HubConfig;
use Knock\Game\MatchService;
use Knock\Ranking\RankingStore;
use Knock\Tests\Game\Support\FakeTransport;
use Knock\Tests\Game\Support\MutableClock;
use PHPUnit\Framework\TestCase;
use Random\Engine\Mt19937;
use Random\Randomizer;

/** Le serveur de jeu sans réseau : salon, défis, partie rapide, tours de jeu, délais, matchs classés, forfaits et revanches. */
final class GameHubTest extends TestCase
{
    private GameHub $hub;
    private MutableClock $clock;
    private string $dir;
    private int $ipCounter = 0;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/knock-hub-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->clock = new MutableClock();
        $this->hub = $this->makeHub();
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->dir . '/*') ?: []);
        rmdir($this->dir);
    }

    private function makeHub(): GameHub
    {
        $silent = new StdoutLogger(fopen('php://memory', 'w'));

        return GameHub::create(
            new HubConfig(turnSeconds: 30, settleSeconds: 1.5),
            new RankingStore($this->dir . '/ratings.json'),
            $this->clock,
            $silent,
            new Randomizer(new Mt19937(7)),
        );
    }


    /** @return array{Client, FakeTransport} */
    private function connect(?string $name = null, ?string $token = null, ?string $ip = null): array
    {
        $transport = new FakeTransport();
        $client = $this->hub->accept($transport);
        $client->setAddress($ip ?? '203.0.113.' . (++$this->ipCounter));        // une adresse différente par navigateur, sauf demande contraire
        if ($name !== null) {
            $this->say($client, ['t' => 'hello', 'name' => $name, 'token' => $token]);
        }

        return [$client, $transport];
    }

    /** @param array<string, mixed> $msg */
    private function say(Client $client, array $msg): void
    {
        $this->hub->receive($client, json_encode($msg, JSON_THROW_ON_ERROR));
    }

    private function ticks(int $n): void
    {
        for ($i = 0; $i < $n; $i++) {
            $this->hub->tick();
        }
    }

    private static function token(string $seed): string
    {
        return substr(str_repeat($seed, 30), 0, 32);
    }

    /** @return array{Client, FakeTransport, Client, FakeTransport} deux joueurs en match (jetons différents => classé) */
    private function startRankedMatch(string $a = 'Alice', string $b = 'Bob'): array
    {
        [$ca, $ta] = $this->connect($a, self::token($a));
        [$cb, $tb] = $this->connect($b, self::token($b));
        $this->say($ca, ['t' => 'queue']);
        $this->say($cb, ['t' => 'queue']);

        return [$ca, $ta, $cb, $tb];
    }

    /** Le client dont c'est le tour. */
    private function active(Client $a): Client
    {
        $room = $a->room ?? throw new \LogicException('pas de match');

        return $room->players[$room->game->turn];
    }

    /** @return list<int> les cases qui cachent ce contenu (le test lit la grille du serveur, pas le client) */
    private function cellsOf(Client $a, int $value): array
    {
        $items = ($a->room ?? throw new \LogicException('pas de match'))->game->layout->items;

        return array_keys(array_filter($items, static fn (int $v): bool => $v === $value));
    }

    private function open(Client $client, int $cell): void
    {
        $this->say($client, ['t' => 'open', 'c' => $cell]);
    }

    /** Le joueur actif trouve toutes les paires d'affilée (une paire trouvée fait rejouer) : la grille se termine. */
    private function findAllPairs(Client $a): void
    {
        $client = $this->active($a);
        $room = $a->room ?? throw new \LogicException('pas de match');
        $byMotif = [];
        foreach ($room->game->layout->items as $cell => $v) {
            if ($v >= 0) {
                $byMotif[$v][] = $cell;
            }
        }
        foreach ($byMotif as $cells) {
            $this->open($client, $cells[0]);
            $this->open($client, $cells[1]);
        }
    }

    /** Une erreur volontaire du joueur actif : deux portes de motifs différents. */
    private function missOnPurpose(Client $a): void
    {
        $room = $a->room ?? throw new \LogicException('pas de match');
        $seen = [];
        foreach ($room->game->layout->items as $cell => $v) {
            if ($v >= 0 && !isset($seen[$v]) && count($seen) < 2) {
                $seen[$v] = $cell;
            }
        }
        $cells = array_values($seen);
        $this->open($this->active($a), $cells[0]);
        $this->open($this->active($a), $cells[1]);
    }

    /** Laisse passer le délai d'une erreur affichée (puis les portes se referment). */
    private function letSettle(): void
    {
        $this->clock->advance(1.6);
        $this->ticks(1);
    }

    /** Termine un match : le joueur actif trouve toutes les paires. */
    private function finishMatch(Client $a): void
    {
        $this->findAllPairs($a);
    }

    public function testHelloRegistersThePlayerAndAnnouncesTheLobby(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('  Bob  ');
        $this->assertSame('Alice', $ta->last('welcome')['name']);
        $this->assertSame('Bob', $tb->last('welcome')['name'], 'espaces retirés');
        $this->assertFalse($ta->last('welcome')['ranked'], 'sans jeton : invité');
        $this->assertSame(ClientStatus::Lobby, $a->status);
        $this->ticks(GameHub::HOUSEKEEPING_EVERY);
        $this->assertSame(['Bob'], array_column($ta->last('lobby')['players'], 'name'), 'chacun voit les autres, pas lui-même');
        $this->assertSame(['Alice'], array_column($tb->last('lobby')['players'], 'name'));
    }

    public function testInvalidAndDuplicateNicknamesAreRefused(): void
    {
        foreach (['', '   ', '<>!?', null] as $bad) {
            [, $t] = $this->connect($bad ?? '');
            $this->assertSame('bad_name', $t->last('error')['code'] ?? null, var_export($bad, true));
        }
        $this->connect('Alice');
        [, $t] = $this->connect('ALICE');
        $this->assertSame('name_taken', $t->last('error')['code'], 'pseudo déjà connecté, sans tenir compte de la casse');
        [, $long] = $this->connect(str_repeat('x', 40));
        $this->assertSame(15, mb_strlen($long->last('welcome')['name']));
    }

    public function testEverythingButPingAndHelloNeedsANickname(): void
    {
        [$c, $t] = $this->connect();
        $this->say($c, ['t' => 'queue']);
        $this->say($c, ['t' => 'challenge', 'id' => 1]);
        $this->assertSame(['error', 'error'], $t->types());
        $this->assertSame('not_ready', $t->last('error')['code']);
        $this->say($c, ['t' => 'ping', 'c' => 5]);
        $this->assertSame(5, $t->last('pong')['c']);
    }

    public function testLeavingTheQueueAndQueueingTwiceDoNotMatchAPlayerWithHimself(): void
    {
        [$a, $ta] = $this->connect('Alice');
        $this->say($a, ['t' => 'queue']);
        $this->say($a, ['t' => 'queue']);
        $this->assertSame('busy', $ta->last('error')['code']);
        $this->say($a, ['t' => 'unqueue']);
        $this->assertNotNull($ta->last('unqueued'));
        [$b, $tb] = $this->connect('Bob');
        $this->say($b, ['t' => 'queue']);
        $this->assertNull($tb->last('match'), 'Alice a quitté la file');
        $this->assertSame(0, $this->hub->matchCount());
    }

    public function testChallengeAcceptStartsAMatch(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->assertSame('Bob', $ta->last('waiting')['name']);
        $this->assertSame(['id' => $a->id, 'name' => 'Alice'], array_intersect_key($tb->last('invite'), ['id' => 1, 'name' => 1]));
        $this->say($b, ['t' => 'accept', 'id' => $a->id]);
        $this->assertNotNull($ta->last('match'));
        $this->assertNotNull($tb->last('match'));
        $this->assertNull($a->invite);
    }

    public function testDeclineCancelAndInvalidAnswers(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        [$c, $tc] = $this->connect('Carl');
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->say($c, ['t' => 'accept', 'id' => $a->id]);
        $this->assertSame('busy', $tc->last('error')['code'], 'seul le défié peut accepter');
        $this->say($b, ['t' => 'accept', 'id' => 999]);
        $this->assertSame('busy', $tb->last('error')['code'], 'mauvais défieur');
        $this->say($b, ['t' => 'decline', 'id' => $a->id]);
        $this->assertSame('Bob', $ta->last('declined')['name']);
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->say($a, ['t' => 'cancel']);
        $this->assertNotNull($tb->last('invite_cancel'));
        $this->say($b, ['t' => 'accept', 'id' => $a->id]);
        $this->assertNull($tb->last('match'), 'défi retiré : plus rien à accepter');
    }

    public function testChallengeRefusedWhenTheTargetIsBusyOrInvalid(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b] = $this->connect('Bob');
        [$c, $tc] = $this->connect('Carl');
        $this->say($a, ['t' => 'challenge', 'id' => $a->id]);
        $this->say($a, ['t' => 'challenge', 'id' => 4242]);
        $this->say($a, ['t' => 'challenge', 'id' => 'x']);
        $this->assertSame(['busy', 'busy', 'busy'], array_column($ta->of('error'), 'code'));
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->say($c, ['t' => 'challenge', 'id' => $b->id]);
        $this->assertSame('busy', $tc->last('error')['code'], 'Bob a déjà un défi en attente');
    }

    public function testExpiredInvitationsAreCancelledForBothSides(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->clock->advance(21);
        $this->ticks(GameHub::HOUSEKEEPING_EVERY);
        $this->assertNotNull($ta->last('invite_cancel'));
        $this->assertNotNull($tb->last('invite_cancel'));
        $this->assertNull($a->invite);
    }

    public function testTwoTabsOfTheSameBrowserNeverRankAgainstEachOther(): void
    {
        $same = self::token('z');
        [$a, $ta] = $this->connect('Tab1', $same);
        [$b] = $this->connect('Tab2', $same);
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertFalse($ta->last('match')['ranked']);
    }

    public function testLeavingMidMatchIsAForfeitForTheLeaver(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $this->ticks(5);
        $this->say($a, ['t' => 'leave']);
        $rb = $tb->last('result');
        $this->assertTrue($rb['forfeit']);
        $this->assertNotNull($tb->last('oppleft'));
        $this->assertSame($b->room, null);
        $this->assertSame(ClientStatus::Lobby, $b->status);
        $this->assertSame(ClientStatus::Lobby, $a->status);
        $this->assertArrayNotHasKey('delta', $rb, 'forfait sans aucun point joué : pas de classement');
        $this->assertSame(0, $this->hub->matchCount());
    }

    public function testDisconnectDuringAMatchNotifiesTheOpponent(): void
    {
        [$a, , , $tb] = $this->startRankedMatch();
        $this->hub->disconnect($a);
        $this->assertNotNull($tb->last('oppleft'));
        $this->assertSame(0, $this->hub->matchCount());
        $this->assertCount(1, $this->hub->lobby);
    }


    public function testQuickMatchPairsTwoPlayersAndAnnouncesTheGridWithoutItsSecrets(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        $this->say($a, ['t' => 'queue']);
        $this->assertNotNull($ta->last('queued'));
        $this->assertSame(ClientStatus::Queued, $a->status);
        $this->say($b, ['t' => 'queue']);
        $ma = $ta->last('match');
        $mb = $tb->last('match');
        $this->assertNotNull($ma);
        $this->assertNotNull($mb);
        $this->assertSame(1, $ma['side'] + $mb['side'], 'un premier joueur, un second');
        $this->assertSame('Bob', $ma['opp']['name']);
        $this->assertSame('Alice', $mb['opp']['name']);
        $this->assertFalse($ma['ranked'], 'invités : amical');
        $this->assertSame($ma['grid'], $mb['grid'], 'la même grille des deux côtés');
        $this->assertSame(['cols', 'rows', 'skins', 'pairs'], array_keys($ma['grid']));
        $this->assertCount(25, $ma['grid']['skins']);
        $this->assertSame(11, $ma['grid']['pairs']);
        $this->assertSame(0, $ma['turn']);
        $this->assertStringNotContainsString('items', (string) json_encode($ma), 'jamais ce qui se cache derrière les portes');
        $this->assertSame([ClientStatus::Playing, ClientStatus::Playing], [$a->status, $b->status]);
        $this->assertSame(1, $this->hub->matchCount());
    }

    public function testOnlyThePlayerWhoseTurnItIsCanOpenAndBothSeeWhatIsRevealed(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $mover = $this->active($a);
        $other = $mover === $a ? $b : $a;
        $tOther = $other === $a ? $ta : $tb;
        $tMover = $mover === $a ? $ta : $tb;
        $this->open($other, 0);
        $this->assertSame('not_your_turn', $tOther->last('error')['code']);
        $this->assertNull($tOther->last('ev'));
        $this->open($mover, 3);
        $expected = $mover->room->game->layout->items[3];
        foreach ([$ta, $tb] as $t) {
            $this->assertSame([['e' => 'open', 'c' => 3, 'v' => $expected]], $t->last('ev')['e']);
        }
        $this->open($mover, 3);
        $this->assertSame('bad_cell', $tMover->last('error')['code'], 'une porte déjà ouverte');
        $this->say($mover, ['t' => 'open', 'c' => 'trois']);
        $this->assertSame('bad_cell', $tMover->last('error')['code']);
        $this->say($mover, ['t' => 'open', 'c' => 99]);
        $this->assertSame('bad_cell', $tMover->last('error')['code']);
    }

    public function testOpeningWithoutAMatchIsIgnored(): void
    {
        [$a, $ta] = $this->connect('Alice');
        $this->open($a, 0);
        $this->assertNull($ta->last('ev'));
        $this->assertNull($ta->last('error'));
    }

    public function testAMissShowsBothDoorsThenClosesThemAndPassesTheTurnAfterTheDelay(): void
    {
        [$a, $ta] = $this->startRankedMatch();
        $first = $this->active($a);
        $firstSide = $a->room?->sideOf($first)?->value;
        $this->missOnPurpose($a);
        $miss = $ta->last('ev')['e'][1];
        $this->assertSame('miss', $miss['e']);
        $this->open($first, 0);
        $this->assertSame('not_your_turn', $this->transportOf($first)->last('error')['code'], 'pas de coup pendant l\'affichage de l\'erreur');
        $this->assertSame($first, $this->active($a), 'la main ne passe qu\'après le délai');
        $this->letSettle();
        $this->assertSame(
            [['e' => 'close', 'cells' => [$miss['a'], $miss['b']]], ['e' => 'turn', 'p' => 1 - $firstSide]],
            $ta->last('ev')['e'],
        );
        $this->assertNotSame($first, $this->active($a));
    }

    public function testAPairKeepsTheTurnAndTheBanditStealsInFrontOfBothPlayers(): void
    {
        [$a, $ta, $b] = $this->startRankedMatch();
        $player = $this->active($a);
        [$c1, $c2] = [$this->firstPair($a)[0], $this->firstPair($a)[1]];
        $this->open($player, $c1);
        $this->open($player, $c2);
        $this->assertSame('match', $ta->last('ev')['e'][1]['e']);
        $this->assertSame($player, $this->active($a), 'une paire trouvée : on rejoue');
        $bandit = $this->cellsOf($a, Rules::BANDIT)[0];
        $this->open($player, $bandit);
        $events = $ta->last('ev')['e'];
        $this->assertSame(['e' => 'steal', 'c' => $bandit, 'p' => $player->room->sideOf($player)->value, 'amount' => 100], $events[1]);
        $this->assertNotSame($player, $this->active($a), 'le bandit fait perdre la main');
    }

    /** @return array{int, int} */
    private function firstPair(Client $a): array
    {
        $room = $a->room ?? throw new \LogicException('pas de match');
        foreach ($room->game->layout->items as $cell => $v) {
            if ($v >= 0) {
                $mate = array_values(array_diff($this->cellsOf($a, $v), [$cell]))[0];

                return [$cell, $mate];
            }
        }
        throw new \LogicException('aucune paire');
    }

    private function transportOf(Client $client): FakeTransport
    {
        $reflection = new \ReflectionProperty($client, 'transport');

        return $reflection->getValue($client);
    }

    public function testMessageRateIsLimitedPerSecond(): void
    {
        [$a, $ta] = $this->connect('Alice');
        for ($i = 0; $i < 400; $i++) {
            $this->say($a, ['t' => 'ping', 'c' => $i]);
        }
        $this->assertCount(60 - 1, $ta->of('pong'), 'hello compte aussi dans la seconde');
        $this->clock->advance(1);
        $this->say($a, ['t' => 'ping', 'c' => 1]);
        $this->assertCount(60, $ta->of('pong'), 'la seconde suivante repart de zéro');
    }

    public function testRankedMatchReportsTheResultAfterTheLastPairAndUpdatesTheRating(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $this->assertTrue($ta->last('match')['ranked']);
        $winner = $this->active($a);
        $this->finishMatch($a);
        $this->assertSame('end', end($ta->last('ev')['e'])['e'], 'la dernière paire termine la grille');
        $ra = $ta->last('result');
        $rb = $tb->last('result');
        $this->assertNotNull($ra);
        $this->assertFalse($ra['forfeit']);
        $this->assertSame($ra['winner'], $rb['winner']);
        $this->assertSame($winner->room?->sideOf($winner)?->value, $ra['winner']);
        $this->assertSame(1100 > 0 ? 1100 : 0, array_sum($ra['cash']), '11 paires à 100 $, toutes pour le même joueur');
        $this->assertSame(1000 + $ra['delta'], $ra['rating']);
        $this->assertSame(0, $ra['delta'] + $rb['delta'], 'Elo à somme nulle entre deux débutants');
        $ranking = $this->hub->ranking()->ranking;
        $this->assertCount(2, $ranking);
        $this->assertFileExists($this->dir . '/ratings.json');
        $this->assertSame($ra['winner'] === $ta->last('match')['side'], $ra['delta'] > 0, 'le vainqueur gagne des points');
    }

    public function testFriendlyMatchesDoNotTouchTheRanking(): void
    {
        [$a, $ta] = $this->connect('Alice', self::token('a'));
        [$b] = $this->connect('Bob');                          // invité : pas de jeton
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertFalse($ta->last('match')['ranked']);
        $this->finishMatch($a);
        $this->assertNotNull($ta->last('result'));
        $this->assertArrayNotHasKey('delta', $ta->last('result'));
        $this->assertSame(0, $this->hub->ranking()->ranking->count());
    }

    public function testReservedNicknamesBelongToTheirToken(): void
    {
        [$a, , $b] = $this->startRankedMatch();
        $this->finishMatch($a);
        $this->say($a, ['t' => 'leave']);
        $this->say($b, ['t' => 'leave']);
        $this->hub->disconnect($a);
        $this->hub->disconnect($b);
        [, $t] = $this->connect('Alice', self::token('x'));
        $this->assertSame('name_taken', $t->last('error')['code'], 'un autre jeton ne peut pas prendre Alice');
        [, $g] = $this->connect('Alice');
        $this->assertSame('name_taken', $g->last('error')['code'], 'ni un invité sans jeton');
        [, $ok] = $this->connect('Alice', self::token('Alice'));
        $this->assertNotNull($ok->last('welcome'), 'le propriétaire revient avec son jeton');
        $this->assertNotNull($ok->last('welcome')['rating']);
    }

    public function testRematchStartsANewMatchWithANewGridWhenBothAsk(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $firstGrid = $ta->last('match')['grid'];
        $this->finishMatch($a);
        $this->assertNotNull($ta->last('result'));
        $this->say($a, ['t' => 'rematch']);
        $this->assertNotNull($tb->last('rematch_ask'));
        $matches = count($ta->of('match'));
        $this->say($b, ['t' => 'rematch']);
        $this->assertCount($matches + 1, $ta->of('match'));
        $this->assertSame(1, $this->hub->matchCount());
        $this->assertNotSame($firstGrid['skins'], $ta->last('match')['grid']['skins'], 'une grille neuve');
        $this->assertSame(0, array_sum($a->room->game->cash));
    }

    public function testRematchWindowClosesAndSendsPlayersBackToTheLobby(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $this->finishMatch($a);
        $this->clock->advance(31);
        $this->ticks(1);
        $this->assertNotNull($ta->last('left'));
        $this->assertNotNull($tb->last('left'));
        $this->assertSame(ClientStatus::Lobby, $a->status);
        $this->assertSame(0, $this->hub->matchCount());
        $this->say($a, ['t' => 'rematch']);
        $this->assertCount(1, $ta->of('match'), 'plus de revanche possible');
    }

    public function testAnExpiredTurnClosesTheOpenDoorAndPassesTheTurn(): void
    {
        [$a, $ta] = $this->startRankedMatch();
        $slow = $this->active($a);
        $this->open($slow, $this->firstPair($a)[0]);
        $this->clock->advance(31);
        $this->ticks(1);
        $events = $ta->last('ev')['e'];
        $this->assertSame('close', $events[0]['e']);
        $this->assertSame('turn', $events[1]['e']);
        $this->assertNotSame($slow, $this->active($a));
    }

    public function testLettingTwoOfYourTurnsExpireForfeitsTheMatch(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $slow = $this->active($a);
        for ($i = 0; $i < 3; $i++) {                    // lent, autre, lent : le lent perd par forfait
            $this->clock->advance(31);
            $this->ticks(1);
        }
        $result = $ta->last('result');
        $this->assertNotNull($result);
        $this->assertTrue($result['forfeit']);
        $this->assertSame($slow->room?->sideOf($slow)?->opposite()->value ?? null, $result['winner']);
    }

    public function testPlayingInBetweenResetsTheExpiryCounter(): void
    {
        [$a, $ta] = $this->startRankedMatch();
        $slow = $this->active($a);
        $this->clock->advance(31);
        $this->ticks(1);                                // le lent laisse passer son tour (1)
        $this->open($this->active($a), $this->firstPair($a)[0]);   // l'autre joue
        $this->clock->advance(31);
        $this->ticks(1);                                // l'autre laisse passer, la main revient au lent
        $this->open($slow, $this->firstPair($a)[0]);    // le lent se réveille
        $this->clock->advance(31);
        $this->ticks(1);                                // son compteur était remis à zéro : pas de forfait
        $this->assertNull($ta->last('result'));
    }

    public function testMatchServiceConstantsAreSane(): void
    {
        $this->assertGreaterThanOrEqual(2, MatchService::MAX_IDLE_TURNS);
    }

    public function testPlayersOnTheSameAddressPlayAFriendlyMatchWithAReason(): void
    {
        [$a, $ta] = $this->connect('Alice', self::token('a'), '198.51.100.5');
        [$b, $tb] = $this->connect('Bob', self::token('b'), '198.51.100.5');
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertFalse($ta->last('match')['ranked']);
        $this->assertSame('same_ip', $ta->last('match')['why']);
        $this->assertSame('same_ip', $tb->last('match')['why']);
    }

    public function testPlayersOnDifferentAddressesAreRankedWithoutAnyReason(): void
    {
        [$a, $ta] = $this->connect('Alice', self::token('a'), '198.51.100.5');
        [$b] = $this->connect('Bob', self::token('b'), '198.51.100.6');
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertTrue($ta->last('match')['ranked']);
        $this->assertArrayNotHasKey('why', $ta->last('match'));
    }

    public function testAMatchWithoutAnyKnownAddressIsNeverRefused(): void
    {
        $ta = new FakeTransport();
        $tb = new FakeTransport();
        $a = $this->hub->accept($ta);
        $b = $this->hub->accept($tb);
        $this->say($a, ['t' => 'hello', 'name' => 'Alice', 'token' => self::token('a')]);
        $this->say($b, ['t' => 'hello', 'name' => 'Bob', 'token' => self::token('b')]);
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertTrue($ta->last('match')['ranked']);
    }

    public function testAFourthAccountFromOneAddressIsNotRanked(): void
    {
        $results = [];
        for ($i = 1; $i <= 4; $i++) {
            [$a, $ta] = $this->connect("Farm$i", self::token("farm$i"), '198.51.100.50');
            [$b] = $this->connect("Real$i", self::token("real$i"), "198.51.100.1$i");
            $this->say($a, ['t' => 'queue']);
            $this->say($b, ['t' => 'queue']);
            $results[] = [$ta->last('match')['ranked'], $ta->last('match')['why'] ?? null];
            $this->hub->disconnect($a);
            $this->hub->disconnect($b);
        }
        $this->assertSame([[true, null], [true, null], [true, null], [false, 'too_many_accounts']], $results);
    }

    public function testTwoAddressesCannotSwapVictoriesMoreThanAFewTimesEvenAfterReconnecting(): void
    {
        $results = [];
        for ($i = 1; $i <= 5; $i++) {
            [$a, $ta] = $this->connect('Alice', self::token('a'), '198.51.100.7');
            [$b] = $this->connect('Bob', self::token('b'), '198.51.100.8');
            $this->say($a, ['t' => 'queue']);
            $this->say($b, ['t' => 'queue']);
            $results[] = $ta->last('match')['why'] ?? 'ranked';
            $this->hub->disconnect($a);
            $this->hub->disconnect($b);
        }
        $this->assertSame(['ranked', 'ranked', 'ranked', 'ranked', 'pair_limit'], $results);
    }

    public function testAClientKnowsItsAddressOnceTheServerHasResolvedIt(): void
    {
        [$a] = $this->connect('Alice', null, '203.0.113.99');
        $this->assertSame('203.0.113.99', $a->ip);
    }
}
