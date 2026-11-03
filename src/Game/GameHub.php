<?php

declare(strict_types=1);

namespace Knock\Game;

use Arcade\Server\Hub;
use Arcade\Server\Session;
use Arcade\Server\Transport;
use Knock\Game\Handler\AcceptHandler;
use Knock\Game\Handler\CancelHandler;
use Knock\Game\Handler\ChallengeHandler;
use Knock\Game\Handler\DeclineHandler;
use Knock\Game\Handler\OpenHandler;
use Knock\Game\Handler\HelloHandler;
use Knock\Game\Handler\LeaveHandler;
use Knock\Game\Handler\MessageHandler;
use Knock\Game\Handler\PingHandler;
use Knock\Game\Handler\QueueHandler;
use Knock\Game\Handler\RematchHandler;
use Knock\Game\Handler\UnqueueHandler;
use Knock\Ranking\RankingStore;
use Arcade\Fair\RankingGuard;
use Psr\Clock\ClockInterface;
use Psr\Log\LoggerInterface;
use Random\Randomizer;

/**
 * Façade du serveur de jeu : le réseau lui donne des connexions, des messages texte et des battements de quelques dixièmes de seconde.
 * Il route chaque message vers son handler et fait avancer les matchs.
 */
final class GameHub implements Hub
{
    final public const int HOUSEKEEPING_EVERY = 10;   // ticks (0,1 s) entre deux entretiens (invitations, salon)

    /** @var array<string, MessageHandler> indexés par ClientMessage::value */
    private readonly array $handlers;
    private int $ticks = 0;

    public function __construct(
        public readonly Lobby $lobby,
        private readonly Invitations $invitations,
        private readonly MatchQueue $queue,
        private readonly MatchService $matches,
        private readonly RankingBook $book,
        private readonly HubConfig $config,
        private readonly ClockInterface $clock,
    ) {
        $this->handlers = [
            ClientMessage::Ping->value => new PingHandler(),
            ClientMessage::Hello->value => new HelloHandler($lobby, $book),
            ClientMessage::Open->value => new OpenHandler($matches),
            ClientMessage::Queue->value => new QueueHandler($lobby, $queue, $matches),
            ClientMessage::Unqueue->value => new UnqueueHandler($lobby, $queue),
            ClientMessage::Challenge->value => new ChallengeHandler($lobby, $invitations, $clock),
            ClientMessage::Accept->value => new AcceptHandler($invitations, $matches),
            ClientMessage::Decline->value => new DeclineHandler($lobby, $invitations),
            ClientMessage::Cancel->value => new CancelHandler($lobby, $invitations),
            ClientMessage::Leave->value => new LeaveHandler($matches),
            ClientMessage::Rematch->value => new RematchHandler($matches),
        ];
    }

    /** Fabrique : assemble le serveur avec ses dépendances (patron Factory). */
    public static function create(
        HubConfig $config,
        RankingStore $store,
        ClockInterface $clock,
        LoggerInterface $logger,
        Randomizer $randomizer = new Randomizer(),
        ?RankingGuard $guard = null,
    ): self {
        $lobby = new Lobby();
        $invitations = new Invitations($config->inviteTtl);
        $queue = new MatchQueue();
        $book = new RankingBook($store, $logger);
        $guard ??= RankingGuard::fromEnvironment('KNOCK');
        $matches = new MatchService($config, $lobby, $queue, $invitations, $book, $clock, $logger, $randomizer, $guard);

        return new self($lobby, $invitations, $queue, $matches, $book, $config, $clock);
    }

    public function ranking(): RankingBook
    {
        return $this->book;
    }

    public function matchCount(): int
    {
        return $this->matches->count();
    }

    #[\Override]
    public function accept(Transport $transport): Client
    {
        return $this->lobby->create($transport, $this->clock->now()->getTimestamp());
    }

    /** Un message texte complet reçu d'un client. */
    #[\Override]
    public function receive(Session $session, string $raw): void
    {
        $client = $this->clientOf($session);
        if (!$client->allow($this->clock->now()->getTimestamp(), $this->config->rateLimit)) {
            return;                                                   // au-delà de la cadence : ignoré
        }
        if (strlen($raw) > 2048 || !json_validate($raw)) {
            return;
        }
        $msg = json_decode($raw, true);
        $type = is_array($msg) && is_string($msg['t'] ?? null) ? ClientMessage::tryFrom($msg['t']) : null;
        if ($type === null) {
            return;
        }
        if ($type->needsName() && !$client->isNamed) {
            $client->error('not_ready');

            return;
        }
        /** @var array<string, mixed> $msg */
        $this->handlers[$type->value]->handle($client, $msg);
    }

    #[\Override]
    public function disconnect(Session $session): void
    {
        $client = $this->clientOf($session);
        $this->queue->leave($client);
        $invitation = $this->invitations->cancel($client);
        $invitation?->other($client)->send(Event::InviteCancel, ['id' => $client->id]);
        $this->matches->leave($client);
        $this->lobby->remove($client);
    }

    #[\Override]
    public function population(): int
    {
        return $this->lobby->count();
    }

    private function clientOf(Session $session): Client
    {
        return $session instanceof Client ? $session : throw new \InvalidArgumentException('unknown session');
    }

    /** Un battement : avance les matchs ; de temps en temps, expire les défis et rafraîchit le salon. */
    #[\Override]
    public function tick(): void
    {
        $now = $this->clock->now()->getTimestamp();
        $this->ticks++;
        $this->matches->tick((float) $this->clock->now()->format('U.u'));
        if ($this->ticks % self::HOUSEKEEPING_EVERY !== 0) {
            return;
        }
        foreach ($this->invitations->expired($now) as $invitation) {
            $this->invitations->cancel($invitation->from);
            $invitation->from->send(Event::InviteCancel, ['id' => $invitation->to->id]);
            $invitation->to->send(Event::InviteCancel, ['id' => $invitation->from->id]);
            $this->lobby->dirty = true;
        }
        if ($this->lobby->dirty) {
            $this->lobby->dirty = false;
            $list = $this->lobby->snapshot($this->book->ranking->ratingOf(...));
            foreach ($this->lobby->named() as $client) {
                if ($client->status !== ClientStatus::Playing) {
                    $client->send(Event::Lobby, ['players' => array_values(array_filter($list, static fn (array $p): bool => $p['id'] !== $client->id))]);
                }
            }
        }
    }
}
