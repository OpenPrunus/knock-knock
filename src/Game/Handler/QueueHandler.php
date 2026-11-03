<?php

declare(strict_types=1);

namespace Knock\Game\Handler;

use Knock\Game\Client;
use Knock\Game\ClientStatus;
use Knock\Game\Event;
use Knock\Game\Lobby;
use Knock\Game\MatchQueue;
use Knock\Game\MatchService;

/** « Partie rapide » : on rejoint la file ; dès qu'un autre joueur attend, le match commence. */
final readonly class QueueHandler implements MessageHandler
{
    public function __construct(private Lobby $lobby, private MatchQueue $queue, private MatchService $matches)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        if ($client->status !== ClientStatus::Lobby || $client->invite !== null) {
            $client->error('busy');

            return;
        }
        $client->status = ClientStatus::Queued;
        $opponent = $this->queue->pairOrWait($client);
        if ($opponent !== null) {
            $this->matches->start($opponent, $client);
        } else {
            $client->send(Event::Queued);
        }
        $this->lobby->dirty = true;
    }
}
