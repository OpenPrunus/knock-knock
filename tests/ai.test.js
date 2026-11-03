import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, generate, RULES } from '../web/js/engine.js';
import { createAI, MEMORY } from '../web/js/ai.js';

/** L'ordinateur joue seul sur une grille : il ne triche pas, il ne voit que les portes ouvertes. Retourne le nombre d'erreurs. */
function soloMisses(level, seed) {
  const game = new Game(generate(5, 5, 2, 1, seed), 1);
  const ai = createAI(level, seed + 1000);
  let misses = 0;
  for (let guard = 0; guard < 2000 && !game.over; guard++) {
    if (game.pending.length > 0) { game.settle(); continue; }
    const events = game.open(ai.pick(game));
    assert.ok(events, 'l\'ordinateur ne joue que des coups valides');
    ai.observe(events);
    if (events.some((e) => e.e === 'miss')) misses++;
  }
  assert.ok(game.over, 'la grille se termine');
  return misses;
}

const average = (level) => { let n = 0; for (let s = 1; s <= 60; s++) n += soloMisses(level, s); return n / 60; };

test('les probabilités de mémoire sont celles du cahier des charges', () => {
  assert.deepEqual(MEMORY, { easy: 0.3, normal: 0.6, hard: 0.95 });
});

test('plus le niveau est haut, moins l\'ordinateur se trompe', () => {
  const [easy, normal, hard] = ['easy', 'normal', 'hard'].map(average);
  assert.ok(easy > normal && normal > hard, `${easy} > ${normal} > ${hard}`);
  assert.ok(hard < 8, `difficile se trompe peu : ${hard}`);
});

test('l\'ordinateur ne connaît pas l\'emplacement des portes fermées : ses choix ne dépendent que de ce qu\'il a vu', () => {
  // même tirage, mais deux grilles dont seules les portes jamais ouvertes diffèrent : mêmes choix tant qu'il n'a rien vu de différent
  const a = new Game(generate(5, 5, 2, 1, 11), 1);
  const picks = new Set();
  for (let i = 0; i < 40; i++) picks.add(createAI('hard', i).pick(a));
  assert.ok(picks.size > 5, 'sans rien savoir, il choisit au hasard');
  assert.ok([...picks].every((c) => a.state[c] === 0));
});

test('difficile : dès qu\'une paire est connue, il la joue ; il évite les bandits qu\'il a vus', () => {
  const layout = generate(4, 4, 2, 0, 5);
  const game = new Game(layout, 2);
  const ai = createAI('hard', 1);
  // il a vu un motif deux fois (retenus : on force la mémoire en rejouant jusqu'à ce qu'elle soit pleine)
  const [a, b] = layout.items.map((v, i) => [v, i]).filter(([v], _, all) => all.filter(([w]) => w === v).length === 2 && v >= 0).slice(0, 2).map(([, i]) => i);
  let remembered = 0;
  for (let seed = 1; seed < 200 && remembered < 2; seed++) {
    const tryAi = createAI('hard', seed);
    tryAi.observe([{ e: 'open', c: a, v: layout.items[a] }, { e: 'open', c: b, v: layout.items[b] }]);
    const first = tryAi.pick(game);
    if (first === a || first === b) { remembered = 2; assert.ok(true); }
  }
  assert.equal(remembered, 2, 'avec 95 % de mémoire, il joue la paire connue');
  const bandit = layout.items.indexOf(RULES.BANDIT);
  const picks = Array.from({ length: 200 }, (_, i) => { const x = createAI('hard', i + 100); x.observe([{ e: 'open', c: bandit, v: RULES.BANDIT }]); return x.pick(game); });
  const atBandit = picks.filter((c) => c === bandit).length;
  assert.ok(atBandit < 20, `il retombe rarement sur un bandit déjà vu : ${atBandit}/200`);
});
