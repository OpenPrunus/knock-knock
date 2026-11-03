<?php

declare(strict_types=1);

namespace Knock\Game;

use Knock\Engine\Game;
use Knock\Engine\Layout;
use Knock\Engine\Rules;
use Knock\Engine\Side;
use Knock\Ranking\Participant;
use Knock\Ranking\RankedMatch;
use Arcade\Fair\RankingGuard;
use Psr\Clock\ClockInterface;
use Psr\Log\LoggerInterface;
use Random\Randomizer;

/** Cycle de vie des matchs : création, tours de jeu, délais, résultat, forfait et revanche. */
final class MatchService
{
    final public const int MAX_IDLE_TURNS = 2;          // tours laissés expirer de suite avant le forfait

    /** @var list<Room> */
    private array $rooms = [];

    public function __construct(
        private readonly HubConfig $config,
        private readonly Lobby $lobby,
        private readonly MatchQueue $queue,
        private readonly Invitations $invitations,
        private readonly RankingBook $book,
        private readonly ClockInterface $clock,
        private readonly LoggerInterface $logger,
        private readonly Randomizer $randomizer,
        private readonly RankingGuard $guard,
    ) {
    }

    public function count(): int
    {
        return count($this->rooms);
    }

    private function now(): float
    {
        return (float) $this->clock->now()->format('U.u');
    }

    /** Lance un match ; l'ordre des joueurs (le premier commence) est tiré au hasard. */
    public function start(Client $a, Client $b, string $size = Rules::DEFAULT_SIZE): Room
    {
        foreach ([$a, $b] as $client) {
            $this->queue->leave($client);
            $this->cancelInvitation($client);
        }
        [$first, $second] = $this->randomizer->getInt(0, 1) === 0 ? [$a, $b] : [$b, $a];
        [$ranked, $why] = $this->decideRanked($a, $b);
        $room = new Room([$first, $second], $ranked, $this->newGame($size), $size);
        $room->why = $why;
        $this->begin($room);
        $this->logger->info("Match {$first->name} vs {$second->name} (" . ($ranked ? 'ranked' : 'friendly' . ($why !== null ? ": $why" : '')) . ')');

        return $room;
    }

    private function newGame(string $size): Game
    {
        $o = Rules::SIZES[$size] ?? Rules::SIZES[Rules::DEFAULT_SIZE];

        return new Game(Layout::generate($o['cols'], $o['rows'], $o['bandits'], $o['detectives'], $this->randomizer->getInt(1, 0x7FFFFFFF)), 2);
    }

    /**
     * Une partie est classée si les deux joueurs ont un jeton différent ET si les adresses IP le permettent
     * (même adresse, trop de comptes depuis une adresse, mêmes deux adresses qui se rencontrent trop souvent).
     *
     * @return array{bool, ?string} classée ?, raison du refus le cas échéant
     */
    private function decideRanked(Client $a, Client $b): array
    {
        if (!($a->hasToken && $b->hasToken && $a->tokenHash !== $b->tokenHash)) {
            return [false, null];
        }
        $why = $this->guard->check($a->ip, $a->tokenHash, $b->ip, $b->tokenHash, $this->clock->now()->getTimestamp());

        return [$why === null, $why];
    }

    /** Annonce le match : la grille (cases et aspect des portes, jamais ce qu'elles cachent) et celui qui commence. */
    private function begin(Room $room): void
    {
        $this->rooms[] = $room;
        $layout = $room->game->layout;
        $room->deadline = $this->now() + $this->config->turnSeconds;
        foreach ([Side::Left, Side::Right] as $side) {
            $player = $room->players[$side->value];
            $opponent = $room->opponentOf($side);
            $player->room = $room;
            $player->status = ClientStatus::Playing;
            $player->send(Event::Match, [
                'side' => $side->value,
                'ranked' => $room->ranked,
                'size' => $room->size,
                ...($room->why !== null ? ['why' => $room->why] : []),
                'grid' => ['cols' => $layout->cols, 'rows' => $layout->rows, 'skins' => $layout->skins, 'pairs' => $layout->pairs()],
                'turn' => $room->game->turn,
                'left' => $this->config->turnSeconds,
                'opp' => ['name' => $opponent->name, 'rating' => $this->book->ranking->ratingOf((string) $opponent->name)],
            ]);
        }
        $this->lobby->dirty = true;
    }

    /** Un joueur ouvre une porte : seulement pendant son tour, et pas pendant l'affichage d'une erreur. */
    public function open(Client $client, int $cell): void
    {
        $room = $client->room;
        $side = $room?->sideOf($client);
        if ($room === null || $side === null || $room->finished) {
            return;
        }
        if ($room->phase !== RoomPhase::Playing || $room->game->turn !== $side->value) {
            $client->error('not_your_turn');

            return;
        }
        $events = $room->game->open($cell);
        if ($events === null) {
            $client->error('bad_cell');

            return;
        }
        $room->idleTurns[$side->value] = 0;
        $this->emit($room, $events);
    }

    /**
     * Diffuse les événements aux deux joueurs puis prépare la suite : fin de grille, erreur à refermer, ou main à reprendre.
     *
     * @param list<array<string, mixed>> $events
     */
    private function emit(Room $room, array $events): void
    {
        $now = $this->now();
        $this->broadcast($room, Event::Events, ['e' => $events, 'left' => $this->config->turnSeconds]);
        $room->deadline = $now + $this->config->turnSeconds;
        if ($room->game->over) {
            $this->finish($room, $room->game->winner(), false, $now);
        } elseif ($room->game->pending !== []) {
            $room->phase = RoomPhase::Settling;
            $room->resumeAt = $now + $this->config->settleSeconds;
        }
    }

    /** Délais : portes d'une erreur à refermer, temps de réflexion écoulé, fin de la revanche. */
    public function tick(float $now): void
    {
        foreach ($this->rooms as $room) {
            if ($room->finished) {
                if ($now >= $room->closeAt) {
                    $this->close($room);
                }
                continue;
            }
            if ($room->phase === RoomPhase::Settling && $now >= $room->resumeAt) {
                $room->phase = RoomPhase::Playing;
                $this->emit($room, $room->game->settle() ?? []);
            } elseif ($room->phase === RoomPhase::Playing && $now >= $room->deadline) {
                $this->timeout($room, $now);
            }
        }
    }

    /** Temps écoulé : la porte retournée est refermée et la main passe ; deux fois de suite, c'est forfait. */
    private function timeout(Room $room, float $now): void
    {
        $turn = $room->game->turn;
        if (++$room->idleTurns[$turn] >= self::MAX_IDLE_TURNS) {
            $this->finish($room, 1 - $turn, true, $now);

            return;
        }
        $this->emit($room, $room->game->skip());
    }

    /**
     * @param array<string, mixed> $data
     */
    private function broadcast(Room $room, Event $event, array $data): void
    {
        foreach ($room->players as $player) {
            $player->send($event, $data);
        }
    }

    /** Annonce le résultat et met à jour le classement. `$winner` : 0, 1 ou −1 (égalité). `$forfeit` : un joueur est parti ou a laissé le temps filer. */
    private function finish(Room $room, int $winner, bool $forfeit, float $now): void
    {
        if ($room->finished) {
            return;
        }
        $room->finished = true;
        $room->phase = RoomPhase::Over;
        $room->closeAt = $now + $this->config->rematchTtl;
        $cash = $room->game->cash;
        $result = null;
        if ($room->ranked && $winner !== -1 && (!$forfeit || array_sum($cash) >= 1)) {
            [$a, $b] = $room->players;
            $result = $this->book->settle(
                new RankedMatch(
                    new Participant((string) $a->name, $a->tokenHash, $cash[0]),
                    new Participant((string) $b->name, $b->tokenHash, $cash[1]),
                    $winner === 0,
                ),
                (int) $now,
            );
        }
        foreach ([Side::Left, Side::Right] as $side) {
            $room->players[$side->value]->send(Event::Result, [
                'winner' => $winner,
                'forfeit' => $forfeit,
                'cash' => $cash,
                'ranked' => $room->ranked,
                ...($result !== null ? ['delta' => $result->deltas[$side->value], 'rating' => $result->ratings[$side->value]] : []),
            ]);
        }
    }

    /** Un joueur quitte (volontairement ou parce qu'il est déconnecté) : forfait si le match n'était pas fini. */
    public function leave(Client $client, ?float $now = null): void
    {
        $room = $client->room;
        $side = $room?->sideOf($client);
        if ($room === null || $side === null) {
            return;
        }
        $now ??= $this->now();
        if (!$room->finished) {
            $this->finish($room, $side->opposite()->value, true, $now);
        }
        $opponent = $room->opponentOf($side);
        $client->room = null;
        $client->status = $client->isNamed ? ClientStatus::Lobby : ClientStatus::New;
        if ($opponent->room === $room) {
            $opponent->room = null;
            $opponent->status = ClientStatus::Lobby;
            $opponent->send(Event::OpponentLeft);
        }
        $this->remove($room);
    }

    /** Demande de revanche ; quand les deux la demandent, un nouveau match commence avec les mêmes joueurs. */
    public function requestRematch(Client $client): void
    {
        $room = $client->room;
        $side = $room?->sideOf($client);
        if ($room === null || $side === null || !$room->finished) {
            return;
        }
        $room->rematch[$side->value] = true;
        $room->opponentOf($side)->send(Event::RematchAsk);
        if ($room->rematch[0] && $room->rematch[1]) {
            $this->remove($room);
            [$ranked, $why] = $this->decideRanked($room->players[0], $room->players[1]);
            $next = new Room($room->players, $ranked, $this->newGame($room->size), $room->size);
            $next->why = $why;
            $this->begin($next);
        }
    }

    /** Fin de la fenêtre de revanche : les deux joueurs retournent au salon. */
    private function close(Room $room): void
    {
        foreach ($room->players as $player) {
            if ($player->room === $room) {
                $player->room = null;
                $player->status = ClientStatus::Lobby;
                $player->send(Event::Left);
            }
        }
        $this->remove($room);
    }

    private function remove(Room $room): void
    {
        $this->rooms = array_values(array_filter($this->rooms, static fn (Room $r): bool => $r !== $room));
        $this->lobby->dirty = true;
    }

    private function cancelInvitation(Client $client): void
    {
        $invitation = $this->invitations->cancel($client);
        if ($invitation !== null) {
            $invitation->other($client)->send(Event::InviteCancel, ['id' => $client->id]);
            $this->lobby->dirty = true;
        }
    }

    /** Pour les tests et le journal : le match est-il en cours ? */
    public function isRunning(Room $room): bool
    {
        return in_array($room, $this->rooms, true) && !$room->finished;
    }
}
