<?php

declare(strict_types=1);

namespace Knock\Game\Handler;

use Knock\Game\Client;
use Knock\Game\MatchService;

/** Le joueur dont c'est le tour ouvre une porte (`c` : numéro de la case). */
final readonly class OpenHandler implements MessageHandler
{
    public function __construct(private MatchService $matches)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $cell = $msg['c'] ?? null;
        if (!is_int($cell)) {
            $client->error('bad_cell');

            return;
        }
        $this->matches->open($client, $cell);
    }
}
