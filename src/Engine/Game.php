<?php

declare(strict_types=1);

namespace Knock\Engine;

/**
 * Une grille en cours de partie, pour un ou deux joueurs. Machine à états pure : `open()` retourne les événements produits,
 * `settle()` referme les portes d'une erreur une fois le délai écoulé (c'est l'appelant qui mesure le temps).
 *
 * Portes : 0 fermée, 1 ouverte en attente (première porte ou erreur), 2 paire validée, 3 personnage révélé (définitif).
 * Événements (tableaux simples, identiques en JavaScript) :
 *   open {c, v}, match {a, b, p, cash}, miss {a, b, p, cash}, detective {c, p}, steal {c, p, amount},
 *   blocked {c, p}, close {cells}, turn {p}, end {}.
 */
final class Game
{
    final public const int CLOSED = 0;
    final public const int PENDING = 1;
    final public const int MATCHED = 2;
    final public const int SPECIAL = 3;

    /** @var array<int, int> */
    public array $state;
    /** @var array<int, int> cagnotte de chacun pour cette grille */
    public array $cash;
    /** @var array<int, int> détectives en réserve de chacun */
    public array $shield;
    public int $turn = 0;
    /** Première porte retournée du coup en cours, ou −1. */
    public int $first = -1;
    /** @var list<int> portes à refermer par `settle()` */
    public array $pending = [];
    public int $pairsLeft;
    public bool $over = false;

    public function __construct(public readonly Layout $layout, public readonly int $players = 1)
    {
        $this->state = array_fill(0, count($layout->items), self::CLOSED);
        $this->cash = array_fill(0, $players, 0);
        $this->shield = array_fill(0, $players, 0);
        $this->pairsLeft = $layout->pairs();
    }

    /**
     * @return ?list<array<string, mixed>> null : coup impossible (partie finie, erreur à refermer, porte déjà ouverte)
     */
    public function open(int $cell): ?array
    {
        if ($this->over || $this->pending !== [] || $cell < 0 || $cell >= count($this->state) || $this->state[$cell] !== self::CLOSED) {
            return null;
        }
        $value = $this->layout->items[$cell];
        $events = [['e' => 'open', 'c' => $cell, 'v' => $value]];
        $p = $this->turn;

        if ($value === Rules::DETECTIVE) {
            $this->state[$cell] = self::SPECIAL;
            $this->shield[$p]++;
            $events[] = ['e' => 'detective', 'c' => $cell, 'p' => $p];

            return $events;
        }
        if ($value === Rules::BANDIT) {
            $this->state[$cell] = self::SPECIAL;
            if ($this->shield[$p] > 0) {
                $this->shield[$p]--;
                $events[] = ['e' => 'blocked', 'c' => $cell, 'p' => $p];
            } else {
                $events[] = ['e' => 'steal', 'c' => $cell, 'p' => $p, 'amount' => $this->cash[$p]];
                $this->cash[$p] = 0;
            }
            if ($this->first !== -1) {
                $this->pending = [$this->first];
                $this->first = -1;
            } else {
                $this->passTurn($events);
            }

            return $events;
        }
        if ($this->first === -1) {
            $this->state[$cell] = self::PENDING;
            $this->first = $cell;

            return $events;
        }
        $first = $this->first;
        $this->first = -1;
        if ($this->layout->items[$first] === $value) {
            $this->state[$first] = $this->state[$cell] = self::MATCHED;
            $this->cash[$p] += Rules::PAIR_GAIN;
            $events[] = ['e' => 'match', 'a' => $first, 'b' => $cell, 'p' => $p, 'cash' => $this->cash[$p]];
            if (--$this->pairsLeft === 0) {
                $this->over = true;
                $events[] = ['e' => 'end'];
            }

            return $events;
        }
        $this->state[$cell] = self::PENDING;
        $this->cash[$p] = max(0, $this->cash[$p] - Rules::MISS_PENALTY);
        $this->pending = [$first, $cell];
        $events[] = ['e' => 'miss', 'a' => $first, 'b' => $cell, 'p' => $p, 'cash' => $this->cash[$p]];

        return $events;
    }

    /**
     * Referme les portes d'une erreur (ou la première porte si un bandit est sorti) puis passe la main.
     *
     * @return ?list<array<string, mixed>> null s'il n'y avait rien à refermer
     */
    public function settle(): ?array
    {
        if ($this->pending === []) {
            return null;
        }
        $cells = $this->pending;
        foreach ($cells as $cell) {
            $this->state[$cell] = self::CLOSED;
        }
        $this->pending = [];
        $events = [['e' => 'close', 'cells' => $cells]];
        $this->passTurn($events);

        return $events;
    }

    /**
     * Temps écoulé : la première porte retournée est refermée et la main passe.
     *
     * @return list<array<string, mixed>>
     */
    public function skip(): array
    {
        $events = [];
        if ($this->first !== -1) {
            $this->state[$this->first] = self::CLOSED;
            $events[] = ['e' => 'close', 'cells' => [$this->first]];
            $this->first = -1;
        }
        $this->passTurn($events);

        return $events;
    }

    /** Gagnant : 0 ou 1, −1 en cas d'égalité (toujours −1 à un seul joueur). */
    public function winner(): int
    {
        if ($this->players < 2 || $this->cash[0] === $this->cash[1]) {
            return -1;
        }

        return $this->cash[0] > $this->cash[1] ? 0 : 1;
    }

    /** @param list<array<string, mixed>> $events */
    private function passTurn(array &$events): void
    {
        if ($this->players < 2) {
            return;
        }
        $this->turn = 1 - $this->turn;
        $events[] = ['e' => 'turn', 'p' => $this->turn];
    }
}
