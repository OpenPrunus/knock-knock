// Génère les vecteurs de référence : des parties jouées par le moteur JavaScript, rejouées ensuite par le moteur PHP.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, Rng, generate, RULES } from '../../web/js/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configs = [
  { cols: 3, rows: 4, bandits: 1, detectives: 1, seed: 1, players: 1 },
  { cols: 4, rows: 4, bandits: 2, detectives: 0, seed: 7, players: 2 },
  { cols: 4, rows: 5, bandits: 2, detectives: 2, seed: 424242, players: 2 },
  { cols: 5, rows: 5, bandits: 2, detectives: 1, seed: 2147483647, players: 2 },
  { cols: 6, rows: 7, bandits: 4, detectives: 2, seed: 99, players: 1 },
  { cols: 6, rows: 6, bandits: 4, detectives: 2, seed: 31337, players: 2 },
];

const games = configs.map((c) => {
  const layout = generate(c.cols, c.rows, c.bandits, c.detectives, c.seed);
  const game = new Game(layout, c.players);
  const rng = new Rng(c.seed ^ 0x5bd1e995);
  const actions = [];
  const log = [];
  for (let guard = 0; guard < 4000 && !game.over; guard++) {
    // des coups variés : portes tirées au hasard, parfois la bonne paire, parfois « temps écoulé »
    let act;
    if (game.pending.length > 0) act = { a: 'settle' };
    else if (rng.below(12) === 0) act = { a: 'skip' };
    else if (game.first !== -1 && rng.below(3) === 0) {
      const partner = layout.items.findIndex((v, i) => i !== game.first && v === layout.items[game.first] && game.state[i] === 0);
      act = { a: 'open', c: partner >= 0 ? partner : rng.below(layout.items.length) };
    } else act = { a: 'open', c: rng.below(layout.items.length) };
    const events = act.a === 'settle' ? game.settle() : act.a === 'skip' ? game.skip() : game.open(act.c);
    actions.push(act);
    log.push(events);
  }
  return { config: c, layout, actions, events: log, final: { state: game.state, cash: game.cash, shield: game.shield, turn: game.turn, over: game.over, winner: game.winner() } };
});
fs.writeFileSync(path.join(here, 'engine-vectors.json'), JSON.stringify({ rules: { levels: RULES.LEVELS }, games }));
console.log(`${games.length} parties, ${games.reduce((n, g) => n + g.actions.length, 0)} actions`);
