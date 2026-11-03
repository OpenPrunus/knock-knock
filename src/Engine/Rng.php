<?php

declare(strict_types=1);

namespace Knock\Engine;

/** xorshift32 : que des entiers sur 32 bits, donc exactement la même suite en JavaScript. */
final class Rng
{
    private int $state;

    public function __construct(int $seed)
    {
        $seed &= 0xFFFFFFFF;
        $this->state = $seed === 0 ? 1 : $seed;
    }

    public function next(): int
    {
        $x = $this->state;
        $x ^= ($x << 13) & 0xFFFFFFFF;
        $x ^= $x >> 17;
        $x ^= ($x << 5) & 0xFFFFFFFF;
        $this->state = $x;

        return $x;
    }

    /** Entier de 0 à `$n` − 1. */
    public function below(int $n): int
    {
        return $this->next() % $n;
    }

    /**
     * Mélange de Fisher-Yates.
     *
     * @param list<int> $items
     * @return list<int>
     */
    public function shuffle(array $items): array
    {
        for ($i = count($items) - 1; $i > 0; $i--) {
            $j = $this->below($i + 1);
            [$items[$i], $items[$j]] = [$items[$j], $items[$i]];
        }

        return array_values($items);
    }
}
