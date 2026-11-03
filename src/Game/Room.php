<?php

declare(strict_types=1);

namespace Knock\Game;

use Knock\Engine\Game;
use Knock\Engine\Side;

/** Un match en cours entre deux clients : la grille (moteur), la phase, les délais, le résultat et la revanche. */
final class Room
{
    public RoomPhase $phase = RoomPhase::Playing;
    /** Fin du temps de réflexion du joueur dont c'est le tour (secondes, horloge du serveur). */
    public float $deadline = 0.0;
    /** Moment où les portes d'une erreur sont refermées. */
    public float $resumeAt = 0.0;
    /** @var array<int, int> tours consécutifs laissés expirer, par joueur */
    public array $idleTurns = [0, 0];
    /** Pourquoi la partie n'est pas classée alors que les deux joueurs avaient un jeton (same_ip, too_many_accounts, pair_limit). */
    public ?string $why = null;
    /** Le résultat a été communiqué aux joueurs. */
    public bool $finished = false;
    /** Fin de la fenêtre de revanche, une fois le résultat connu. */
    public float $closeAt = 0.0;
    /** @var array{bool, bool} */
    public array $rematch = [false, false];

    /** @param array{Client, Client} $players premier joueur, second joueur */
    public function __construct(public readonly array $players, public readonly bool $ranked, public readonly Game $game)
    {
    }

    public function sideOf(Client $client): ?Side
    {
        return match ($client) {
            $this->players[0] => Side::Left,
            $this->players[1] => Side::Right,
            default => null,
        };
    }

    public function opponentOf(Side $side): Client
    {
        return $this->players[$side->opposite()->value];
    }
}
