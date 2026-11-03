<?php

declare(strict_types=1);

namespace Knock\Game\Handler;

use Knock\Game\Client;
use Knock\Game\Event;
use Knock\Game\Invitations;
use Knock\Game\Lobby;

final readonly class DeclineHandler implements MessageHandler
{
    public function __construct(private Lobby $lobby, private Invitations $invitations)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $invitation = $client->invite;
        if ($invitation === null || $invitation->to !== $client || $invitation->from->id !== ($msg['id'] ?? null)) {
            return;
        }
        $this->invitations->cancel($client);
        $invitation->from->send(Event::Declined, ['name' => $client->name]);
        $this->lobby->dirty = true;
    }
}
