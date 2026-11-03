<?php

declare(strict_types=1);

namespace Knock\Ranking;

final readonly class RankedMatch
{
    public function __construct(public Participant $a, public Participant $b, public bool $aWon)
    {
    }
}
