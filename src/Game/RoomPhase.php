<?php

declare(strict_types=1);

namespace Knock\Game;

/** Où en est le match : un joueur choisit ses portes, une erreur est affichée (puis refermée), ou c'est terminé. */
enum RoomPhase
{
    case Playing;
    case Settling;
    case Over;
}
