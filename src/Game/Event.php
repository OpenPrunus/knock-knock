<?php

declare(strict_types=1);

namespace Knock\Game;

/** Messages que le serveur envoie (champ `t`). */
enum Event: string
{
    case Welcome = 'welcome';
    case Lobby = 'lobby';
    case Queued = 'queued';
    case Unqueued = 'unqueued';
    case Invite = 'invite';
    case InviteCancel = 'invite_cancel';
    case Waiting = 'waiting';
    case Declined = 'declined';
    case Match = 'match';
    case Events = 'ev';
    case Result = 'result';
    case OpponentLeft = 'oppleft';
    case Left = 'left';
    case RematchAsk = 'rematch_ask';
    case Pong = 'pong';
    case Error = 'error';
}
