import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { Game, generate, Rng, RULES, CLOSED, MATCHED, SPECIAL } from '../web/js/engine.js';

const mk = (items, players = 2) => new Game({ cols: 3, rows: 2, items, skins: [0, 1, 2, 3, 0, 1], pairs: items.filter((v) => v >= 0).length / 2 }, players);
const ITEMS = [0, 0, 1, 1, RULES.BANDIT, RULES.DETECTIVE];

test('xorshift32 : suite connue, 0 remplacé par 1', () => {
  const r = new Rng(1);
  assert.deepEqual([r.next(), r.next(), r.next()], [270369, 67634689, 2647435461]);
  assert.equal(new Rng(0).next(), new Rng(1).next());
});

test('chaque niveau est jouable : motifs en double, bandits et détectives comptés', () => {
  for (const l of [...RULES.LEVELS, RULES.ONLINE]) {
    const g = generate(l.cols, l.rows, l.bandits, l.detectives, 5);
    assert.equal(g.items.length, l.cols * l.rows);
    assert.equal(g.items.filter((v) => v === RULES.BANDIT).length, l.bandits);
    assert.equal(g.items.filter((v) => v === RULES.DETECTIVE).length, l.detectives);
    const counts = new Map();
    for (const v of g.items.filter((x) => x >= 0)) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const n of counts.values()) assert.equal(n, 2);
  }
  assert.throws(() => generate(3, 3, 0, 0, 1));
});

test('l\'aspect d\'une porte est indépendant de ce qu\'elle cache', () => {
  let same = 0; let total = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const g = generate(4, 4, 1, 1, seed);
    const by = new Map();
    g.items.forEach((m, c) => { if (m >= 0) by.set(m, [...(by.get(m) ?? []), g.skins[c]]); });
    for (const [a, b] of by.values()) { total++; if (a === b) same++; }
  }
  assert.ok(same / total > 0.1 && same / total < 0.4, `${same / total}`);
});

test('une paire trouvée reste ouverte, rapporte 100 $ et fait rejouer', () => {
  const g = mk(ITEMS);
  g.open(0);
  const ev = g.open(1);
  assert.deepEqual(ev[1], { e: 'match', a: 0, b: 1, p: 0, cash: 100 });
  assert.equal(g.state[0], MATCHED);
  assert.equal(g.turn, 0);
  assert.equal(g.open(0), null);
});

test('une erreur coûte 10 $ (jamais sous zéro), bloque le jeu puis la main passe au délai', () => {
  const g = mk(ITEMS);
  g.open(0);
  assert.deepEqual(g.open(2)[1], { e: 'miss', a: 0, b: 2, p: 0, cash: 0 });
  assert.equal(g.open(3), null);
  assert.deepEqual(g.settle(), [{ e: 'close', cells: [0, 2] }, { e: 'turn', p: 1 }]);
  assert.equal(g.state[0], CLOSED);
  assert.equal(g.settle(), null);
  const g2 = mk(ITEMS);
  g2.open(0); g2.open(1); g2.open(2);
  assert.equal(g2.open(0 + 4 - 1)[1].e, 'match');
});

test('le bandit vole toute la cagnotte, le détective l\'arrête une fois', () => {
  const g = mk(ITEMS);
  g.open(0); g.open(1);
  assert.deepEqual(g.open(4)[1], { e: 'steal', c: 4, p: 0, amount: 100 });
  assert.equal(g.cash[0], 0);
  assert.equal(g.state[4], SPECIAL);
  const h = mk(ITEMS);
  h.open(0); h.open(1);
  assert.deepEqual(h.open(5)[1], { e: 'detective', c: 5, p: 0 });
  assert.equal(h.turn, 0);
  assert.deepEqual(h.open(4)[1], { e: 'blocked', c: 4, p: 0 });
  assert.equal(h.cash[0], 100);
  assert.equal(h.shield[0], 0);
});

test('le détective ne protège que celui qui l\'a trouvé', () => {
  const g = mk([RULES.DETECTIVE, 0, 0, 1, 1, RULES.BANDIT]);
  g.open(0); g.open(1); g.open(3); g.settle();
  assert.equal(g.turn, 1);
  assert.equal(g.open(5)[1].e, 'steal');
  assert.equal(g.shield[0], 1);
});

test('un bandit en deuxième porte referme aussi la première', () => {
  const g = mk(ITEMS);
  g.open(0); g.open(4);
  assert.deepEqual(g.pending, [0]);
  assert.deepEqual(g.settle(), [{ e: 'close', cells: [0] }, { e: 'turn', p: 1 }]);
});

test('fin de grille : le plus riche gagne, égalité possible, solo sans passage de main', () => {
  const g = mk(ITEMS);
  g.open(0); g.open(1); g.open(2);
  assert.equal(g.open(3)[2].e, 'end');
  assert.equal(g.over, true);
  assert.equal(g.winner(), 0);
  assert.equal(g.open(4), null);
  const t = mk(ITEMS);
  t.open(0); t.open(1); t.skip(); t.open(2); t.open(3);
  assert.deepEqual(t.cash, [100, 100]);
  assert.equal(t.winner(), -1);
  const s = mk(ITEMS, 1);
  s.open(0); s.open(2);
  assert.deepEqual(s.settle(), [{ e: 'close', cells: [0, 2] }]);
  assert.deepEqual(s.skip(), []);
});

test('les vecteurs enregistrés se rejouent à l\'identique', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/engine-vectors.json'), 'utf8'));
  for (const v of data.games) {
    const c = v.config;
    const layout = generate(c.cols, c.rows, c.bandits, c.detectives, c.seed);
    assert.deepEqual(layout.items, v.layout.items);
    const g = new Game(layout, c.players);
    v.actions.forEach((a, i) => {
      const ev = a.a === 'settle' ? g.settle() : a.a === 'skip' ? g.skip() : g.open(a.c);
      assert.deepEqual(ev, v.events[i]);
    });
    assert.deepEqual(g.state, v.final.state);
  }
});
