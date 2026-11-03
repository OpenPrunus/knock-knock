<?php

declare(strict_types=1);

namespace Knock\Game\Handler;

use Knock\Game\Client;
use Knock\Game\ClientStatus;
use Knock\Game\Event;
use Knock\Game\Invitations;
use Knock\Game\Lobby;
use Psr\Clock\ClockInterface;

/** Défie un joueur du salon. */
final readonly class ChallengeHandler implements MessageHandler
{
    public function __construct(private Lobby $lobby, private Invitations $invitations, private ClockInterface $clock)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $target = is_int($msg['id'] ?? null) ? $this->lobby->get($msg['id']) : null;
        $available = $target !== null
            && $target !== $client
            && $target->isNamed
            && $target->invite === null
            && $client->invite === null
            && $client->status === ClientStatus::Lobby
            && in_array($target->status, [ClientStatus::Lobby, ClientStatus::Queued], true);
        if (!$available) {
            $client->error('busy');

            return;
        }
        $this->invitations->create($client, $target, $this->clock->now()->getTimestamp());
        $client->send(Event::Waiting, ['id' => $target->id, 'name' => $target->name]);
        $target->send(Event::Invite, ['id' => $client->id, 'name' => $client->name]);
        $this->lobby->dirty = true;
    }
}
