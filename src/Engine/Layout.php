<?php

declare(strict_types=1);

namespace Knock\Engine;

use InvalidArgumentException;

/**
 * La grille : ce qui se cache derrière chaque porte (un motif 0..17, `Rules::BANDIT` ou `Rules::DETECTIVE`) et l'apparence
 * de chaque porte. Les deux sont tirés indépendamment : l'aspect d'une porte ne dit rien de son motif.
 */
final readonly class Layout
{
    /**
     * @param array<int, int> $items derrière chaque porte
     * @param list<int> $skins style de chaque porte (0..3)
     */
    public function __construct(public int $cols, public int $rows, public array $items, public array $skins)
    {
    }

    public static function generate(int $cols, int $rows, int $bandits, int $detectives, int $seed): self
    {
        $cells = $cols * $rows;
        $specials = $bandits + $detectives;
        if ($cols < 1 || $rows < 1 || $bandits < 0 || $detectives < 0 || ($cells - $specials) % 2 !== 0 || ($cells - $specials) / 2 > Rules::MOTIFS) {
            throw new InvalidArgumentException('Grille impossible');
        }
        $pairs = intdiv($cells - $specials, 2);
        $rng = new Rng($seed);
        $items = [];
        foreach (array_slice($rng->shuffle(range(0, Rules::MOTIFS - 1)), 0, $pairs) as $motif) {
            $items[] = $motif;
            $items[] = $motif;
        }
        for ($i = 0; $i < $bandits; $i++) {
            $items[] = Rules::BANDIT;
        }
        for ($i = 0; $i < $detectives; $i++) {
            $items[] = Rules::DETECTIVE;
        }
        $items = $rng->shuffle($items);
        $skins = [];
        for ($i = 0; $i < $cells; $i++) {
            $skins[] = $rng->below(Rules::SKINS);
        }

        return new self($cols, $rows, $items, $skins);
    }

    public function pairs(): int
    {
        return intdiv(count(array_filter($this->items, static fn (int $v): bool => $v >= 0)), 2);
    }
}
