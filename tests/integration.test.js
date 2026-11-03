// Intégration : le VRAI serveur PHP (server/server.php) sur un vrai port, avec de vrais clients WebSocket.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, startGameServer, token, waitFor } from './helpers.js';

let server;
const bots = [];
const bot = async (name, tok, srv = server) => {
  const b = await new Bot(srv.url).open();
  bots.push(b);
  if (name) await b.hello(name, tok);
  return b;
};

before(async () => { server = await startGameServer({ KNOCK_REMATCH_TTL: '3', KNOCK_SETTLE_SECONDS: '0.4' }); });
after(() => { for (const b of bots) b.close(); server?.stop(); });

/** Deux joueurs appariés ; renvoie leurs robots et l'annonce du match de chacun. */
async function match(prefix, tokens = true) {
  const a = await bot(`${prefix}1`, tokens ? token(`${prefix}1`) : null);
  const b = await bot(`${prefix}2`, tokens ? token(`${prefix}2`) : null);
  a.send({ t: 'queue' });
  await a.next('queued');
  b.send({ t: 'queue' });
  const [ma, mb] = await Promise.all([a.next('match'), b.next('match')]);
  return { a, b, ma, mb };
}

/** Le robot dont c'est le tour (le premier joueur, `side` 0, commence). */
const mover = (m) => (m.a && m.ma.side === 0 ? m.a : m.b);
const other = (m) => (mover(m) === m.a ? m.b : m.a);

describe('serveur de jeu', () => {
  test('poignée de main, pseudo, salon', async () => {
    const a = await bot('Ana', token('ana'));
    assert.equal(a.last('welcome').name, 'Ana');
    const b = await bot('Ben', token('ben'));
    const lobby = await a.next('lobby');
    assert.ok(lobby.players.some((p) => p.name === 'Ben'));
    b.close();
  });

  test('un pseudo déjà pris ou invalide est refusé', async () => {
    await bot('Cleo', token('cleo'));
    const dup = await bot(null);
    dup.send({ t: 'hello', name: 'Cleo', token: token('autre') });
    assert.equal((await dup.next('error')).code, 'name_taken');
    dup.send({ t: 'hello', name: '   ' });
    assert.equal((await dup.next('error')).code, 'bad_name');
  });

  test('partie rapide : la grille est annoncée aux deux, sans ce qui se cache derrière les portes', async () => {
    const { ma, mb } = await match('Rapide');
    assert.equal(ma.side + mb.side, 1);
    assert.equal(ma.ranked, true);
    assert.deepEqual(ma.grid, mb.grid);
    assert.equal(ma.grid.skins.length, 25);
    assert.equal(ma.grid.pairs, 11);
    assert.ok(ma.grid.skins.every((s) => s >= 0 && s <= 5));
    assert.doesNotMatch(JSON.stringify(ma), /items/);
  });

  test('ouvrir une porte : les deux joueurs voient la même chose, et seul celui dont c\'est le tour peut jouer', async () => {
    const m = await match('Tour');
    const first = mover(m);
    const second = other(m);
    second.send({ t: 'open', c: 0 });
    assert.equal((await second.next('error')).code, 'not_your_turn');
    first.send({ t: 'open', c: 4 });
    const [e1, e2] = await Promise.all([first.next('ev'), second.next('ev')]);
    assert.deepEqual(e1.e, e2.e);
    assert.equal(e1.e[0].e, 'open');
    assert.equal(e1.e[0].c, 4);
    assert.ok(Number.isInteger(e1.e[0].v));
    first.send({ t: 'open', c: 4 });
    assert.equal((await first.next('error')).code, 'bad_cell');
    first.send({ t: 'open', c: 'x' });
    assert.equal((await first.next('error')).code, 'bad_cell');
  });

  test('une erreur : les deux portes se referment puis la main passe', async () => {
    const m = await match('Erreur');
    const first = mover(m);
    const second = other(m);
    // on ouvre des portes jusqu'à une erreur (le serveur seul connaît la grille : on joue à l'aveugle)
    let miss = null;
    for (let c = 0; c < 24 && !miss; c += 2) {
      first.send({ t: 'open', c });
      first.send({ t: 'open', c: c + 1 });
      await first.next('ev');
      await new Promise((r) => setTimeout(r, 40));
      const evs = first.of('ev').flatMap((x) => x.e);
      miss = evs.find((e) => e.e === 'miss') ?? null;
      if (!miss && evs.some((e) => e.e === 'turn')) break;                // un bandit a passé la main : on arrête
    }
    if (miss) {
      const close = await second.next('ev', 3000, true).catch(() => null);
      assert.ok(close);
      await new Promise((r) => setTimeout(r, 700));
      const all = second.of('ev').flatMap((x) => x.e);
      assert.ok(all.some((e) => e.e === 'close'), 'les portes se referment');
      assert.ok(all.some((e) => e.e === 'turn'), 'la main passe');
    }
  });

  test('forfait : quitter en cours de partie donne la victoire à l\'autre', async () => {
    const m = await match('Forfait');
    m.a.send({ t: 'leave' });
    const r = await m.b.next('result');
    assert.equal(r.forfeit, true);
    assert.equal(r.winner, m.mb.side);
    await waitFor(() => m.b.last('oppleft'), 3000, 'oppleft');
  });

  test('temps écoulé trois fois de suite : forfait du plus lent, puis revanche avec une nouvelle grille', async () => {
    const quick = await startGameServer({ KNOCK_TURN_SECONDS: '1', KNOCK_REMATCH_TTL: '5' });
    try {
      const a = await bot('Lent1', token('lent1'), quick);
      const b = await bot('Lent2', token('lent2'), quick);
      a.send({ t: 'queue' });
      await a.next('queued');
      b.send({ t: 'queue' });
      const ma = await a.next('match');
      const r = await a.next('result');
      assert.equal(r.forfeit, true);
      assert.ok(r.winner === 0 || r.winner === 1, 'un vainqueur, pas une égalité');
      a.send({ t: 'rematch' });
      await b.next('rematch_ask');
      b.send({ t: 'rematch' });
      const again = await a.next('match');
      assert.notDeepEqual(again.grid.skins, ma.grid.skins);
    } finally { quick.stop(); }
  });

  test('défi : invitation, refus, puis acceptation', async () => {
    const a = await bot('DefiA', token('defia'));
    const b = await bot('DefiB', token('defib'));
    const idB = (await waitFor(() => a.last('lobby')?.players.find((p) => p.name === 'DefiB'), 4000, 'DefiB dans le salon')).id;
    a.send({ t: 'challenge', id: idB });
    const inv = await b.next('invite');
    b.send({ t: 'decline', id: inv.id });
    assert.equal((await a.next('declined')).name, 'DefiB');
    a.send({ t: 'challenge', id: idB });
    const inv2 = await b.next('invite');
    b.send({ t: 'accept', id: inv2.id });
    await waitFor(() => a.last('match') && b.last('match'), 3000, 'match du défi');
  });

  test('défi avec une taille de grille : petite, grande, ou valeur inconnue (retombe sur la moyenne) ; la revanche garde la taille', async () => {
    const sizes = [['s', 16], ['l', 36], ['grosse', 25], [undefined, 25]];
    for (const [i, [size, cells]] of sizes.entries()) {
      const a = await bot(`Taille${i}a`, token(`taille${i}a`));
      const b = await bot(`Taille${i}b`, token(`taille${i}b`));
      const idB = (await waitFor(() => a.last('lobby')?.players.find((p) => p.name === `Taille${i}b`), 4000, 'adversaire dans le salon')).id;
      a.send({ t: 'challenge', id: idB, ...(size ? { size } : {}) });
      const inv = await b.next('invite');
      assert.equal(inv.size, size === 's' || size === 'l' ? size : 'm');
      b.send({ t: 'accept', id: inv.id });
      const m = await waitFor(() => a.last('match'), 3000, 'match');
      assert.equal(m.grid.skins.length, cells);
      assert.equal(m.size, inv.size);
      a.send({ t: 'leave' });
    }
  });

  test('messages invalides : refusés ou ignorés, la connexion survit', async () => {
    const a = await bot('Junk', token('junk'));
    a.ws.send('pas du json');
    a.ws.send(JSON.stringify({ t: 'inconnu' }));
    a.ws.send(JSON.stringify([1, 2]));
    a.send({ t: 'open', c: 0 });
    a.send({ t: 'ping', c: 5 });
    assert.equal((await a.next('pong')).c, 5);
  });

  test('même adresse IP : partie amicale non classée, avec le motif', async () => {
    const a = await new Bot(server.url, undefined, '192.0.2.77').open();
    const b = await new Bot(server.url, undefined, '192.0.2.77').open();
    bots.push(a, b);
    await a.hello('MemeIp1', token('MemeIp1'));
    await b.hello('MemeIp2', token('MemeIp2'));
    a.send({ t: 'queue' });
    await a.next('queued');
    b.send({ t: 'queue' });
    const m = await a.next('match');
    assert.equal(m.ranked, false);
    assert.equal(m.why, 'same_ip');
    a.send({ t: 'leave' });
  });

  test('trop de connexions depuis une même adresse : refus HTTP 429', async () => {
    const small = await startGameServer({ KNOCK_MAX_CONN_PER_IP: '2' });
    const open = [];
    try {
      for (let i = 0; i < 2; i++) open.push(await new Bot(small.url, undefined, '192.0.2.88').open());
      await assert.rejects(() => new Bot(small.url, undefined, '192.0.2.88').open());
      open.push(await new Bot(small.url, undefined, '192.0.2.89').open());
    } finally {
      for (const b of open) b.close();
      small.stop();
    }
  });

  test('un client qui n\'est pas WebSocket reçoit un refus HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`).catch(() => null);
    assert.ok(res === null || res.status === 400);
  });
});
