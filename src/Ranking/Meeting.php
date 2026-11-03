<?php

declare(strict_types=1);

namespace Knock\Ranking;

final readonly class Meeting
{
    public function __construct(public float $factor, public PairLimiter $limiter)
    {
    }
}
