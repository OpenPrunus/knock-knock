<?php

declare(strict_types=1);

namespace Knock\Game\Handler;

use Knock\Game\Client;
use Knock\Game\ClientStatus;
use Knock\Game\Event;
use Knock\Game\Lobby;
use Knock\Game\MatchQueue;

final readonly class UnqueueHandler implements MessageHandler
{
    public function __construct(private Lobby $lobby, private MatchQueue $queue)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $this->queue->leave($client);
        if ($client->status === ClientStatus::Queued) {
            $client->status = ClientStatus::Lobby;
            $client->send(Event::Unqueued);
            $this->lobby->dirty = true;
        }
    }
}
