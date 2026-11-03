<?php

declare(strict_types=1);

namespace Knock\Engine;

/** Joueur : le premier (0) ou le second (1). */
enum Side: int
{
    case Left = 0;
    case Right = 1;

    public function opposite(): self
    {
        return match ($this) {
            self::Left => self::Right,
            self::Right => self::Left,
        };
    }
}
