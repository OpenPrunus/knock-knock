// Knock Knock — l'ordinateur ne triche pas : il ne connaît que ce qu'il a vu, et n'en retient qu'une partie.
import { Rng, RULES, CLOSED } from './engine.js';

/** Probabilité de mémoriser une porte découverte, selon le niveau (cahier des charges : 30 %, 60 %, 95 %). */
export const MEMORY = { easy: 0.3, normal: 0.6, hard: 0.95 };

export function createAI(level, seed) {
  const p = Math.round((MEMORY[level] ?? MEMORY.normal) * 100);
  const rng = new Rng(seed);
  /** case → ce qu'on y a vu (et retenu) */
  const known = new Map();
  const pickFrom = (cells) => cells[rng.below(cells.length)];

  return {
    /** Les événements vus : chaque porte ouverte est retenue avec la probabilité du niveau (la première porte du coup en cours, elle, est sous ses yeux). */
    observe(events) {
      for (const ev of events) if (ev.e === 'open' && rng.below(100) < p) known.set(ev.c, ev.v);
    },

    /** La porte à ouvrir maintenant. */
    pick(game) {
      const closed = [];
      game.state.forEach((s, i) => { if (s === CLOSED) closed.push(i); });
      const first = game.first;
      const remembered = closed.filter((i) => known.has(i) && i !== first);
      if (first !== -1) {
        const mate = remembered.find((i) => known.get(i) === game.layout.items[first]);
        if (mate !== undefined) return mate;
      } else {
        const seen = new Map();
        for (const i of remembered) {
          const v = known.get(i);
          if (v < 0) continue;
          if (seen.has(v)) return seen.get(v);
          seen.set(v, i);
        }
        const detective = remembered.find((i) => known.get(i) === RULES.DETECTIVE);
        if (detective !== undefined) return detective;
      }
      const unknown = closed.filter((i) => !known.has(i) && i !== first);
      if (unknown.length > 0) return pickFrom(unknown);
      const safe = remembered.filter((i) => known.get(i) !== RULES.BANDIT);
      if (safe.length > 0) return pickFrom(safe);
      return pickFrom(closed.filter((i) => i !== first));
    },
  };
}
