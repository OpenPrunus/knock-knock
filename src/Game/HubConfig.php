<?php

declare(strict_types=1);

namespace Knock\Game;

use Arcade\Support\Env;

/** Réglages du serveur de jeu (durées en secondes). */
final readonly class HubConfig
{
    public function __construct(
        public int $turnSeconds = 30,
        public int $maxClients = 300,
        public int $inviteTtl = 20,
        public int $rematchTtl = 30,
        public int $rateLimit = 60,
        public float $settleSeconds = 1.5,
    ) {
    }

    public static function fromEnvironment(): self
    {
        return new self(
            turnSeconds: (int) Env::number('KNOCK_TURN_SECONDS', 30),
            inviteTtl: (int) Env::number('KNOCK_INVITE_TTL', 20),
            rematchTtl: (int) Env::number('KNOCK_REMATCH_TTL', 30),
            settleSeconds: Env::number('KNOCK_SETTLE_SECONDS', 1.5),
        );
    }
}
