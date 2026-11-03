// Navigateur : un vrai Chrome (headless) piloté par DevTools, sans dépendance. Le site est servi par `php -S`, le serveur de jeu
// est le vrai serveur PHP, et un robot Node joue l'adversaire en ligne.
//   npm run test:browser          (PHP_BIN et CHROME_BIN réglables ; SHOTS=/dossier enregistre des captures d'écran)
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, PHP, ROOT, freePort, sleep, startGameServer, token, waitFor } from './helpers.js';

let BASE, chrome, php, game, tmpDir, cdp, nextId = 0;
const pending = new Map();
const errors = [];

before(async () => {
  game = await startGameServer();
  const port = await freePort();
  php = spawn(PHP, ['-S', `127.0.0.1:${port}`, '-t', path.join(ROOT, 'web')], {
    env: { ...process.env, KNOCK_WS: game.url, KNOCK_DATA_DIR: game.dataDir }, stdio: 'ignore',
  });
  BASE = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${BASE}/`)).ok, 10000, 'site PHP');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knock-chrome-'));
  const dbg = await freePort();
  chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    `--remote-debugging-port=${dbg}`, `--user-data-dir=${tmpDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  const tab = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === 'page'), 15000, 'Chrome');
  cdp = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { cdp.onopen = resolve; cdp.onerror = () => reject(new Error('DevTools')); });
  cdp.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  };
  await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
});
after(() => {
  try { cdp.close(); } catch { /* déjà fermé */ }
  for (const p of [chrome, php]) { try { p?.kill(); } catch { /* déjà arrêté */ } }
  game?.stop();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignoré */ }
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    cdp.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page : ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function shot(name) {
  if (!process.env.SHOTS) return;
  fs.mkdirSync(process.env.SHOTS, { recursive: true });
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const DESKTOP = { w: 1100, h: 700, touch: false };
const PHONE_LANDSCAPE = { w: 844, h: 390, touch: true };
const PHONE_PORTRAIT = { w: 390, h: 844, touch: true };

async function open(device, lang = 'fr') {
  await call('Emulation.setDeviceMetricsOverride', { width: device.w, height: device.h, deviceScaleFactor: 1, mobile: !!device.touch });
  await call('Emulation.setTouchEmulationEnabled', device.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await call('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'local_storage' });
  await call('Page.navigate', { url: `${BASE}/` });
  await waitFor(() => ev('document.readyState === "complete" && !!window.__knock'), 10000, 'page chargée');
  await ev(`localStorage.setItem('knock.lang', ${JSON.stringify(lang)}); location.reload()`);
  await waitFor(() => ev('document.readyState === "complete" && !!window.__knock'), 10000, 'page rechargée');
}
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
const visible = (sel) => ev(`!document.querySelector(${JSON.stringify(sel)}).hidden`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const cls = (i) => ev(`document.querySelector('#board .cell[data-i="${i}"]').className`);
const state = () => ev('(() => { const a = window.__knock.app; return { mode: a.mode, turn: a.turn, cash: a.cash, shield: a.shield, locked: a.locked, over: !!a.over }; })()');
const items = () => ev('window.__knock.app.game.layout.items');

/** Un vrai clic de souris au centre de la porte numéro i. */
async function openCell(i) {
  const r = await rect(`#board .cell[data-i="${i}"]`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.cx, y: r.cy, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.cx, y: r.cy, button: 'left', clickCount: 1 });
}
const pairsOf = (list) => {
  const by = new Map();
  list.forEach((v, c) => { if (v >= 0) by.set(v, [...(by.get(v) ?? []), c]); });
  return [...by.values()];
};
/** Deux portes de motifs différents (pour se tromper exprès). */
const wrongPair = (list, skip = new Set()) => {
  const free = pairsOf(list).filter(([a]) => !skip.has(a));
  return [free[0][0], free[1][0]];
};
/** Trouve toutes les paires restantes (sans toucher aux personnages) : la grille se termine. */
async function findAll(list, skip = new Set()) {
  for (const [a, b] of pairsOf(list)) {
    if (skip.has(a)) continue;
    await openCell(a);
    await openCell(b);
  }
}

describe('page et modes hors ligne', () => {
  test('le menu s\'affiche, sans erreur, en français puis en anglais', async () => {
    errors.length = 0;
    await open(DESKTOP);
    assert.equal(await ev('document.title'), 'Knock Knock');
    assert.match(await text('#menu [data-action=ai]'), /ordinateur/);
    assert.equal(await ev('document.querySelectorAll("#menu [data-action]").length >= 4'), true);
    assert.equal(await ev('document.querySelector("#menu a.all").href'), 'https://games.prunus.dev/');
    await shot('menu');
    await open(DESKTOP, 'en');
    assert.match(await text('#menu [data-action=ai]'), /computer/i);
    assert.deepEqual(errors, []);
  });

  test('solo : paire, erreur, bandit, détective, puis la grille est réussie et la suivante plus grande', async () => {
    errors.length = 0;
    await open(DESKTOP);
    await click('#menu [data-action=solo]');
    await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 12'), 3000, 'grille 3×4');
    const list = await items();
    const [a, b] = pairsOf(list)[0];
    await openCell(a);
    assert.match(await cls(a), /open/);
    await openCell(b);
    assert.deepEqual((await state()).cash, [100, 0]);
    assert.match(await cls(a), /matched/);
    const skip = new Set([a]);
    const [w1, w2] = wrongPair(list, skip);
    await openCell(w1);
    await openCell(w2);
    assert.equal((await state()).cash[0], 90);
    assert.match(await cls(w1), /wrong/);
    await shot('solo-miss');
    await waitFor(async () => !(await state()).locked, 4000, 'portes refermées');
    assert.doesNotMatch(await cls(w1), /open/);
    const bandit = list.indexOf(-1);
    await openCell(bandit);
    assert.equal((await state()).cash[0], 0, 'le bandit vole toute la cagnotte');
    assert.match(await text('#banner'), /Bandit/);
    const detective = list.indexOf(-2);
    await openCell(detective);
    assert.equal((await state()).shield[0], 1);
    assert.equal(await ev('!document.querySelector("#hud .pl .shield").hidden'), true);
    await shot('solo-special');
    await waitFor(async () => !(await state()).locked, 4000, 'main rendue');
    await findAll(list, skip);
    await waitFor(() => visible('#over'), 5000, 'fin de manche');
    assert.match(await text('#over-title'), /réussie/);
    await shot('solo-level-done');
    await click('#over-again');
    await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 16'), 3000, 'grille 4×4');
    assert.match(await text('#info'), /2\/8/);
    assert.deepEqual(errors, []);
  });

  test('contre-la-montre : le temps s\'affiche et sa fin termine la campagne en gardant la banque', async () => {
    await open(DESKTOP);
    await click('#opt-time');
    await click('#menu [data-action=solo]');
    await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 12'), 3000, 'grille');
    assert.match(await text('#sub'), /\d+ s/);
    await ev('window.__knock.app.timeLeft = 1');
    await waitFor(() => visible('#over'), 4000, 'temps écoulé');
    assert.match(await text('#over-title'), /Temps écoulé/);
  });

  test('contre l\'ordinateur : on gagne en trouvant toutes les paires, l\'ordinateur joue quand on se trompe', async () => {
    errors.length = 0;
    await open(DESKTOP);
    await click('#menu [data-action=ai]');
    await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 25'), 3000, 'grille 5×5');
    const list = await items();
    const [w1, w2] = wrongPair(list);
    await openCell(w1);
    await openCell(w2);
    await waitFor(async () => (await state()).turn === 1, 4000, 'la main passe à l\'ordinateur');
    await waitFor(() => ev('document.querySelectorAll("#board .cell.open").length > 0'), 5000, 'l\'ordinateur ouvre une porte');
    await shot('ai-turn');
    // il se trompe ou trouve une paire ; on attend que ce soit de nouveau à nous
    await waitFor(async () => { const st = await state(); return st.turn === 0 && !st.locked; }, 30000, 'retour au joueur');
    const done = await ev('(() => { const a = window.__knock.app; return a.game.state.map((s, i) => (s === 2 ? i : -1)).filter((i) => i >= 0); })()');
    await findAll(list, new Set(done));
    await waitFor(() => visible('#over'), 8000, 'fin de partie');
    assert.match(await text('#over-detail'), /\$|\d+ \$/);
    assert.deepEqual(errors, []);
  });

  test('2 joueurs sur le même écran : la main passe après une erreur, la paire fait rejouer', async () => {
    await open(DESKTOP);
    await click('#menu [data-action=local]');
    await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 25'), 3000, 'grille');
    const list = await items();
    const [a, b] = pairsOf(list)[0];
    await openCell(a);
    await openCell(b);
    assert.equal((await state()).turn, 0, 'une paire fait rejouer');
    const [w1, w2] = wrongPair(list, new Set([a]));
    await openCell(w1);
    await openCell(w2);
    await waitFor(async () => (await state()).turn === 1, 4000, 'la main passe');
    assert.match(await text('#info'), /Joueur 2/);
    assert.equal(await ev('document.querySelector("#hud .pl[data-p=\'1\']").classList.contains("active")'), true);
  });

  test('Échap demande confirmation avant d\'abandonner la partie', async () => {
    await open(DESKTOP);
    await click('#menu [data-action=solo]');
    await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 12'), 3000, 'grille');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await visible('#quit-dialog'), true);
    await click('#quit-dialog [data-action=quit]');
    assert.equal(await visible('#menu'), true);
    assert.equal(await ev('document.querySelectorAll("#board .cell").length'), 0);
  });
});

describe('taille de la grille selon la difficulté', () => {
  for (const [level, cells, label] of [['easy', 16, '4×4'], ['normal', 25, '5×5'], ['hard', 36, '6×6']]) {
    test(`niveau ${level} : grille ${label} contre l'ordinateur et à deux`, async () => {
      for (const mode of ['ai', 'local']) {
        await open(DESKTOP);
        await ev(`(() => { const s = document.querySelector('#sel-level'); s.value = '${level}'; s.dispatchEvent(new Event('change')); })()`);
        await click(`#menu [data-action=${mode}]`);
        await waitFor(() => ev(`document.querySelectorAll("#board .cell").length === ${cells}`), 3000, `grille ${label}`);
        const box = await ev('(() => { const r = document.querySelector("#board").getBoundingClientRect(); const s = document.querySelector("#stage").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, stageTop: s.top, stageBottom: s.bottom, cell: getComputedStyle(document.documentElement).getPropertyValue("--cell"), hud: document.querySelector("#hud").hidden, iw: innerWidth, ih: innerHeight }; })()');
        assert.ok(box.bottom <= box.ih && box.right <= box.iw && box.top >= 0, `la grille tient à l'écran : ${JSON.stringify(box)}`);
      }
    });
  }

  test('les six styles de portes sont dessinés (une grille 6×6 les montre tous)', async () => {
    await open(DESKTOP);
    await ev(`(() => { const s = document.querySelector('#sel-level'); s.value = 'hard'; s.dispatchEvent(new Event('change')); })()`);
    await click('#menu [data-action=ai]');
    await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 36'), 3000, 'grille 6×6');
    const styles = await ev('[...new Set([...document.querySelectorAll("#board .cell")].map((c) => c.className.match(/skin-(\\d)/)[1]))].length');
    assert.ok(styles >= 4, `${styles} styles visibles`);
    await shot('hard-grid');
  });
});

describe('téléphone : tout tient à l\'écran', () => {
  for (const [name, device] of [['portrait', PHONE_PORTRAIT], ['paysage', PHONE_LANDSCAPE]]) {
    test(`${name} : la grille 5×5 est entière, sans défilement, avec de grandes portes`, async () => {
      await open(device);
      await click('#menu [data-action=ai]');
      await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 25'), 3000, 'grille');
      const box = await ev(`(() => {
        const cells = [...document.querySelectorAll('#board .cell')].map((c) => c.getBoundingClientRect());
        return { minX: Math.min(...cells.map((r) => r.left)), maxX: Math.max(...cells.map((r) => r.right)), minY: Math.min(...cells.map((r) => r.top)), maxY: Math.max(...cells.map((r) => r.bottom)), w: cells[0].width, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight };
      })()`);
      assert.ok(box.minX >= 0 && box.maxX <= device.w + 0.5, `largeur : ${box.minX}..${box.maxX}`);
      assert.ok(box.minY >= 0 && box.maxY <= device.h + 0.5, `hauteur : ${box.minY}..${box.maxY}`);
      assert.ok(box.w >= 36, `porte de ${box.w}px`);
      assert.ok(box.sw <= device.w && box.sh <= device.h, `pas de défilement (${box.sw}×${box.sh})`);
      await shot(`phone-${name}`);
      await openCell(0);
      assert.match(await cls(0), /open/, 'on ouvre une porte au doigt');
    });
  }
});

describe('mode en ligne : un robot joue l\'adversaire', () => {
  test('salon, partie rapide, la grille s\'affiche sans rien révéler, les ouvertures se synchronisent', async () => {
    errors.length = 0;
    await open(DESKTOP);
    await click('#menu [data-action=online]');
    await waitFor(() => visible('#join'), 5000, 'connexion au serveur');
    await ev('document.querySelector("#nick").value = "Navigateur"');
    await ev('document.querySelector("#join").requestSubmit()');
    await waitFor(() => visible('#lobby'), 5000, 'salon');
    const robot = await new Bot(game.url).open();
    try {
      await robot.hello('Robot', token('robot'));
      await click('#quick');
      await waitFor(() => ev('document.querySelector("#quick").textContent.length > 0 && window.__knock.online.status === "queued"'), 3000, 'file d\'attente');
      robot.send({ t: 'queue' });
      const m = await robot.next('match');
      await waitFor(() => ev('window.__knock.app.mode === "online" && document.querySelectorAll("#board .cell").length === 25'), 5000, 'grille en ligne');
      assert.equal(await ev('[...document.querySelectorAll("#board .motif")].every((e) => e.textContent === "")'), true, 'aucune porte ne révèle son contenu');
      assert.equal(await ev('window.__knock.app.game'), null, 'le navigateur ne connaît pas la grille');
      const myTurn = m.side === 1 ? 0 : 1;                      // le robot est du côté m.side ; le navigateur est l'autre
      if (m.turn === m.side) {
        robot.send({ t: 'open', c: 7 });
        await waitFor(async () => /open/.test(await cls(7)), 3000, 'la porte du robot s\'ouvre chez nous');
        assert.notEqual(await ev('document.querySelector("#board .cell[data-i=\'7\'] .motif").textContent'), '');
      } else {
        await openCell(3);
        await waitFor(async () => /open/.test(await cls(3)), 3000, 'notre porte s\'ouvre');
        const seen = await robot.next('ev', 3000, true);
        assert.equal(seen.e[0].c, 3);
      }
      assert.ok(myTurn === 0 || myTurn === 1);
      await shot('online');
      robot.send({ t: 'leave' });
      await waitFor(() => visible('#over'), 5000, 'victoire par forfait');
      assert.match(await text('#over-title'), /gagnez/);
      assert.deepEqual(errors.filter((e) => !/WebSocket/.test(e)), []);
    } finally { robot.close(); }
  });
});

describe('hors ligne (PWA)', () => {
  test('après une première visite, la page se charge sans réseau et le solo se joue', async () => {
    await open(DESKTOP);
    assert.equal(await ev('navigator.serviceWorker.ready.then(() => true)'), true);
    await call('Page.navigate', { url: `${BASE}/` });                       // la page est maintenant contrôlée et ses fichiers en cache
    await waitFor(() => ev('!!window.__knock && !!navigator.serviceWorker.controller'), 10000, 'page contrôlée par le service worker');
    await call('Network.enable');
    await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
      await call('Page.navigate', { url: `${BASE}/` });
      await waitFor(() => ev('!!window.__knock'), 8000, 'page chargée hors ligne');
      await click('#menu [data-action=solo]');
      await waitFor(() => ev('document.querySelectorAll("#board .cell").length === 12'), 3000, 'solo hors ligne');
      await click('#quit-btn');
      await click('#quit-dialog [data-action=quit]');
      await click('#menu [data-action=online]');
      await waitFor(() => ev('document.querySelector("#online-status").textContent.length > 0'), 5000, 'message hors ligne');
      assert.match(await text('#online-status'), /Hors ligne|injoignable/);
    } finally {
      await call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  });
});
