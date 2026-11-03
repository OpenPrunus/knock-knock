<?php

declare(strict_types=1);

namespace Knock\Engine;

/** Constantes du jeu, identiques côté JavaScript (`web/js/engine.js`). */
final class Rules
{
    final public const int PAIR_GAIN = 100;            // $ par paire trouvée
    final public const int MISS_PENALTY = 10;          // $ perdus par erreur (jamais sous zéro)
    final public const int MOTIFS = 18;                // motifs différents (une paire chacun)
    final public const int SETTLE_MS = 1500;           // portes d'une erreur refermées après ce délai
    final public const int SKINS = 4;                  // styles de portes : placard, garage, coffre, cercueil

    final public const int BANDIT = -1;
    final public const int DETECTIVE = -2;

    /** Grille des parties en ligne : 5×5, 2 bandits, 1 détective, donc 11 paires. */
    final public const array ONLINE = ['cols' => 5, 'rows' => 5, 'bandits' => 2, 'detectives' => 1];

    /**
     * Campagne solo : une grille de plus en plus grande, de plus en plus de bandits.
     * Chaque grille a (cases − bandits − détectives) pair et au plus 18 paires.
     *
     * @var list<array{cols: int, rows: int, bandits: int, detectives: int}>
     */
    final public const array LEVELS = [
        ['cols' => 3, 'rows' => 4, 'bandits' => 1, 'detectives' => 1],
        ['cols' => 4, 'rows' => 4, 'bandits' => 1, 'detectives' => 1],
        ['cols' => 4, 'rows' => 4, 'bandits' => 2, 'detectives' => 0],
        ['cols' => 4, 'rows' => 5, 'bandits' => 2, 'detectives' => 2],
        ['cols' => 5, 'rows' => 5, 'bandits' => 2, 'detectives' => 1],
        ['cols' => 5, 'rows' => 6, 'bandits' => 3, 'detectives' => 1],
        ['cols' => 6, 'rows' => 6, 'bandits' => 4, 'detectives' => 2],
        ['cols' => 6, 'rows' => 7, 'bandits' => 4, 'detectives' => 2],
    ];
}
