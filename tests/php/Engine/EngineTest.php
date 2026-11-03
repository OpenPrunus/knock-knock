<?php

declare(strict_types=1);

namespace Knock\Tests\Engine;

use InvalidArgumentException;
use Knock\Engine\Game;
use Knock\Engine\Layout;
use Knock\Engine\Rules;
use PHPUnit\Framework\TestCase;

final class EngineTest extends TestCase
{
    /** Une grille 2×3 : motifs 0 0 1 1, bandit, détective — dans cet ordre, pour que les tests soient lisibles. */
    private function game(int $players = 2, array $items = [0, 0, 1, 1, Rules::BANDIT, Rules::DETECTIVE]): Game
    {
        return new Game(new Layout(3, 2, $items, [0, 1, 2, 3, 0, 1]), $players);
    }

    public function testEveryLevelIsPlayableAndHasEnoughMotifs(): void
    {
        foreach ([...Rules::LEVELS, Rules::ONLINE, ...array_values(Rules::SIZES)] as $level) {
            $layout = Layout::generate($level['cols'], $level['rows'], $level['bandits'], $level['detectives'], 5);
            $this->assertCount($level['cols'] * $level['rows'], $layout->items);
            $this->assertCount($level['bandits'], array_filter($layout->items, static fn (int $v): bool => $v === Rules::BANDIT));
            $this->assertCount($level['detectives'], array_filter($layout->items, static fn (int $v): bool => $v === Rules::DETECTIVE));
            $counts = array_count_values(array_filter($layout->items, static fn (int $v): bool => $v >= 0));
            foreach ($counts as $n) {
                $this->assertSame(2, $n, 'chaque motif apparaît exactement deux fois');
            }
        }
    }

    public function testAnImpossibleGridIsRefused(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Layout::generate(3, 3, 0, 0, 1);       // 9 cases : impair
    }

    public function testTheSameSeedGivesTheSameGridAndAnotherSeedAnotherOne(): void
    {
        $a = Layout::generate(5, 5, 2, 1, 42);
        $this->assertEquals($a, Layout::generate(5, 5, 2, 1, 42));
        $this->assertNotEquals($a->items, Layout::generate(5, 5, 2, 1, 43)->items);
    }

    public function testDoorAppearanceIsIndependentOfWhatIsBehindIt(): void
    {
        $skinsOfPairs = [];
        for ($seed = 1; $seed <= 200; $seed++) {
            $layout = Layout::generate(4, 4, 1, 1, $seed);
            $byMotif = [];
            foreach ($layout->items as $cell => $motif) {
                if ($motif >= 0) {
                    $byMotif[$motif][] = $layout->skins[$cell];
                }
            }
            foreach ($byMotif as $skins) {
                $skinsOfPairs[] = $skins[0] === $skins[1];
            }
        }
        $same = count(array_filter($skinsOfPairs)) / count($skinsOfPairs);
        $this->assertGreaterThan(0.08, $same);
        $this->assertLessThan(0.3, $same, 'les deux portes d\'une paire n\'ont pas forcément le même style (environ 1 sur 6)');
    }

    public function testAMatchedPairStaysOpenAndPays(): void
    {
        $g = $this->game(1);
        $this->assertSame([['e' => 'open', 'c' => 0, 'v' => 0]], $g->open(0));
        $events = $g->open(1);
        $this->assertSame(['e' => 'match', 'a' => 0, 'b' => 1, 'p' => 0, 'cash' => 100], $events[1]);
        $this->assertSame([Game::MATCHED, Game::MATCHED], [$g->state[0], $g->state[1]]);
        $this->assertNull($g->open(0), 'une porte validée ne se rouvre pas');
    }

    public function testAMissCostsTenDollarsNeverBelowZeroAndBlocksUntilSettled(): void
    {
        $g = $this->game(2);
        $g->open(0);
        $events = $g->open(2);
        $this->assertSame(['e' => 'miss', 'a' => 0, 'b' => 2, 'p' => 0, 'cash' => 0], $events[1], 'jamais sous zéro');
        $this->assertNull($g->open(3), 'on ne joue pas pendant que les portes sont encore ouvertes');
        $settled = $g->settle();
        $this->assertSame([['e' => 'close', 'cells' => [0, 2]], ['e' => 'turn', 'p' => 1]], $settled);
        $this->assertSame([Game::CLOSED, Game::CLOSED], [$g->state[0], $g->state[2]]);
        $this->assertSame(1, $g->turn);
        $this->assertNull($g->settle());
    }

    public function testConsecutivePairsAddUpAndKeepTheTurn(): void
    {
        $g = $this->game(2);
        $g->open(0);
        $g->open(1);                                     // +100 pour le joueur 0, il rejoue
        $g->open(2);
        $events = $g->open(0 + 3);                       // porte 3 = motif 1 : paire ! (2 et 3)
        $this->assertSame('match', $events[1]['e']);
        $this->assertSame(200, $g->cash[0]);
        $this->assertSame(0, $g->turn, 'qui trouve une paire rejoue');
    }

    public function testTheBanditStealsTheWholeCashAndPassesTheTurn(): void
    {
        $g = $this->game(2);
        $g->open(0);
        $g->open(1);
        $events = $g->open(4);
        $this->assertSame(['e' => 'steal', 'c' => 4, 'p' => 0, 'amount' => 100], $events[1]);
        $this->assertSame(0, $g->cash[0]);
        $this->assertSame(['e' => 'turn', 'p' => 1], $events[2]);
        $this->assertSame(Game::SPECIAL, $g->state[4]);
    }

    public function testTheDetectiveBlocksTheNextBanditOnceAndIsConsumed(): void
    {
        $g = $this->game(2, [0, 0, 1, 1, Rules::BANDIT, Rules::DETECTIVE]);
        $g->open(0);
        $g->open(1);                                     // 100 $
        $events = $g->open(5);                           // le détective : on garde la main
        $this->assertSame(['e' => 'detective', 'c' => 5, 'p' => 0], $events[1]);
        $this->assertSame(0, $g->turn);
        $events = $g->open(4);                           // le bandit est arrêté
        $this->assertSame(['e' => 'blocked', 'c' => 4, 'p' => 0], $events[1]);
        $this->assertSame(100, $g->cash[0]);
        $this->assertSame(0, $g->shield[0], 'le détective est consommé');
    }

    public function testTheDetectiveOnlyProtectsItsFinder(): void
    {
        $g = $this->game(2, [Rules::DETECTIVE, 0, 0, 1, 1, Rules::BANDIT]);
        $g->open(0);                                     // le joueur 0 trouve le détective
        $g->open(1);
        $g->open(3);                                     // erreur : la main passe
        $g->settle();
        $this->assertSame(1, $g->turn);
        $events = $g->open(5);                           // le joueur 1 tombe sur le bandit, sans protection
        $this->assertSame('steal', $events[1]['e']);
        $this->assertSame(1, $g->shield[0]);
    }

    public function testABanditAsSecondPickClosesTheFirstDoorToo(): void
    {
        $g = $this->game(2);
        $g->open(0);
        $g->open(4);
        $this->assertSame([0], $g->pending);
        $this->assertNull($g->open(2));
        $this->assertSame([['e' => 'close', 'cells' => [0]], ['e' => 'turn', 'p' => 1]], $g->settle());
        $this->assertSame(Game::SPECIAL, $g->state[4], 'le bandit reste visible');
    }

    public function testTheGridEndsWhenAllPairsAreFoundAndTheRichestWins(): void
    {
        $g = $this->game(2);
        $g->open(0);
        $g->open(1);
        $g->open(2);
        $events = $g->open(3);
        $this->assertTrue($g->over);
        $this->assertSame(['e' => 'end'], $events[2]);
        $this->assertSame(0, $g->winner());
        $this->assertNull($g->open(4), 'plus de coup après la fin');
    }

    public function testATieIsADraw(): void
    {
        $g = $this->game(2, [0, 0, 1, 1, Rules::BANDIT, Rules::DETECTIVE]);
        $g->open(0);
        $g->open(1);
        $g->skip();                                      // il passe la main sans rien perdre
        $g->open(2);
        $g->open(3);
        $this->assertSame([100, 100], $g->cash);
        $this->assertSame(-1, $g->winner());
    }

    public function testSkipClosesTheFirstDoorAndPassesTheTurn(): void
    {
        $g = $this->game(2);
        $g->open(0);
        $this->assertSame([['e' => 'close', 'cells' => [0]], ['e' => 'turn', 'p' => 1]], $g->skip());
        $this->assertSame(Game::CLOSED, $g->state[0]);
        $solo = $this->game(1);
        $this->assertSame([], $solo->skip());
    }

    public function testSoloNeverPassesTheTurnAndOutOfRangeDoorsAreRefused(): void
    {
        $g = $this->game(1);
        $g->open(0);
        $g->open(2);
        $this->assertSame([['e' => 'close', 'cells' => [0, 2]]], $g->settle());
        $this->assertNull($g->open(-1));
        $this->assertNull($g->open(6));
    }
}
