// Knock Knock — interface et boucle de jeu : campagne solo, contre l'ordinateur, à deux sur le même écran, en ligne.
import { RULES, Game, generate, CLOSED } from './engine.js';
import { createAI } from './ai.js';
import * as audio from './audio.js';
import * as i18n from './i18n.js';
import { Net, playerToken } from './net.js';

const { t } = i18n;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const MOTIFS = ['🍎', '🍌', '🍒', '🐟', '🐱', '🐶', '🎸', '🚗', '⭐', '🔑', '🎈', '🍕', '🌵', '🚀', '🦆', '🍩', '🎲', '🧲'];
const BANDIT_ICON = '🦹';
const DETECTIVE_ICON = '🕵️';
const iconOf = (v) => (v === RULES.BANDIT ? BANDIT_ICON : v === RULES.DETECTIVE ? DETECTIVE_ICON : MOTIFS[v]);

// ---------------------------------------------------------------- options (gardées dans le navigateur)
const opts = { level: 'normal', time: false, names: ['', ''], nick: '', best: 0 };
try { Object.assign(opts, JSON.parse(localStorage.getItem('knock.opts') ?? '{}')); } catch { /* stockage indisponible */ }
const saveOpts = () => { try { localStorage.setItem('knock.opts', JSON.stringify(opts)); } catch { /* ignoré */ } };

// ---------------------------------------------------------------- état
const app = {
  mode: null,          // solo | ai | local | online
  game: null,          // moteur (hors ligne seulement : en ligne, le serveur seul connaît les portes)
  grid: null,          // { cols, rows, skins }
  names: ['', ''],
  nameKeys: [null, null],
  cash: [0, 0],
  shield: [0, 0],
  turn: 0,
  locked: false,       // pas de clic : erreur affichée, tour de l'ordinateur, partie finie…
  over: null,
  level: 0,
  bank: 0,
  timeLeft: null,
  ai: null,
  aiBusy: false,
  mySide: 0,
  deadline: 0,
  timers: [],
  tick: null,
};
const online = { status: 'idle', me: null, players: [], invite: null, ranked: false, why: null, oppLeft: false };

const later = (fn, ms) => { const id = setTimeout(fn, ms); app.timers.push(id); return id; };
function clearTimers() {
  app.timers.forEach(clearTimeout);
  app.timers = [];
  clearInterval(app.tick);
  app.tick = null;
}

const randomSeed = () => 1 + Math.floor(Math.random() * 0x7FFFFFFF);
const nameOf = (p) => app.names[p] || (app.nameKeys[p] ? t(app.nameKeys[p]) : '');
/** Le joueur p est-il « moi » (celui qui tient la souris) ? */
const isMe = (p) => (app.mode === 'online' ? p === app.mySide : app.mode === 'solo' || (app.mode === 'ai' && p === 0));

// ---------------------------------------------------------------- panneaux
const PANELS = ['menu', 'online', 'names-dialog', 'help', 'leaders', 'quit-dialog', 'over'];
function showPanel(name) {
  for (const id of PANELS) $(`#${id}`).hidden = id !== name;
  const open = name !== '';
  $('#board').style.pointerEvents = open ? 'none' : '';
  fit();
}
const hidePanels = () => showPanel('');

function refreshLabels() {
  i18n.apply();
  $('#opt-sound').textContent = t(audio.isMuted() ? 'toggleSoundOff' : 'toggleSoundOn');
  $('#opt-lang').textContent = t('toggleLang');
  $('#sel-level').value = opts.level;
  $('#opt-time').checked = !!opts.time;
  $('#nick').value = opts.nick ?? '';
  $('#name1').value = opts.names[0] ?? '';
  $('#name2').value = opts.names[1] ?? '';
  renderHud();
}

// ---------------------------------------------------------------- tableau de portes
function buildBoard(grid) {
  app.grid = grid;
  const board = $('#board');
  board.replaceChildren();
  board.style.setProperty('--cols', String(grid.cols));
  board.setAttribute('aria-rowcount', String(grid.rows));
  grid.skins.forEach((skin, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `cell skin-${skin}`;
    b.dataset.i = String(i);
    b.setAttribute('role', 'gridcell');
    b.setAttribute('aria-label', t('door', { n: i + 1 }));
    b.innerHTML = '<span class="slot"><span class="recess"></span><span class="motif"></span><span class="door"></span></span>';
    board.append(b);
  });
  fit();
}

const cellEl = (i) => $(`#board .cell[data-i="${i}"]`);

/** Ajuste la taille d'une porte pour que toute la grille tienne dans la scène. */
function fit() {
  if (!app.grid) return;
  const stage = $('#stage');
  const gap = window.innerWidth <= 520 ? 4 : 6;
  const w = stage.clientWidth - 16;
  const h = stage.clientHeight - 16;
  const cell = Math.floor(Math.min((w - gap * (app.grid.cols - 1)) / app.grid.cols, (h - gap * (app.grid.rows - 1)) / app.grid.rows));
  document.documentElement.style.setProperty('--cell', `${Math.max(36, Math.min(130, cell))}px`);
}

// ---------------------------------------------------------------- affichage : bandeau, cagnottes, tour
let bannerTimer = null;
function banner(text, kind = '', ms = 1800) {
  const el = $('#banner');
  el.textContent = text;
  el.className = kind;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function renderHud() {
  const hud = $('#hud');
  const wasHidden = hud.hidden;
  hud.hidden = app.mode === null;
  if (app.mode === null) return;
  const solo = app.mode === 'solo';
  $$('#hud .pl').forEach((el, p) => {
    el.classList.toggle('solo-hidden', solo && p === 1);
    el.classList.toggle('active', !solo && app.turn === p && !app.over);
    el.querySelector('.pname').textContent = solo ? '' : nameOf(p);
    el.querySelector('.cash').textContent = t('cash', { amount: app.cash[p] });
    el.querySelector('.shield').hidden = app.shield[p] === 0;
    el.querySelector('.shield').textContent = app.shield[p] > 1 ? `${DETECTIVE_ICON}×${app.shield[p]}` : DETECTIVE_ICON;
  });
  if (solo) {
    $('#info').textContent = t('level_n', { n: app.level + 1, total: RULES.LEVELS.length });
    $('#sub').textContent = [t('bank', { amount: app.bank }), app.timeLeft !== null ? t('timeLeft', { s: app.timeLeft }) : ''].filter(Boolean).join(' · ');
  } else {
    const mine = isMe(app.turn);
    $('#info').textContent = app.over ? '' : app.mode === 'ai' ? (mine ? t('yourTurn') : t('thinking', { name: nameOf(app.turn) }))
      : app.mode === 'online' ? (mine ? t('yourTurn') : t('turnOf', { name: nameOf(app.turn) })) : t('turnOf', { name: nameOf(app.turn) });
    const left = app.mode === 'online' && !app.over ? Math.max(0, Math.ceil((app.deadline - performance.now()) / 1000)) : null;
    $('#sub').textContent = left !== null ? t('timeLeft', { s: left }) : '';
  }
  if (wasHidden) fit();                                  // le tableau de bord vient d'apparaître : la scène est plus basse
}

function popCash(p) {
  const el = $(`#hud .pl[data-p="${p}"] .cash`);
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

// ---------------------------------------------------------------- événements du moteur (les mêmes hors ligne et en ligne)
function applyEvents(events) {
  for (const ev of events) applyEvent(ev);
  renderHud();
}

function applyEvent(ev) {
  switch (ev.e) {
    case 'open': {
      const el = cellEl(ev.c);
      el.querySelector('.motif').textContent = iconOf(ev.v);
      el.classList.add('open');
      if (ev.v < 0) el.classList.add('special');
      audio.play('open');
      break;
    }
    case 'match':
      for (const c of [ev.a, ev.b]) { const el = cellEl(c); el.classList.remove('open'); el.classList.add('matched'); el.disabled = true; }
      app.cash[ev.p] = ev.cash;
      popCash(ev.p);
      banner(`${t('pairFound')} ${t('plus100', { amount: RULES.PAIR_GAIN })}`, 'good', 1200);
      audio.play('match');
      break;
    case 'miss':
      for (const c of [ev.a, ev.b]) cellEl(c).classList.add('wrong');
      app.cash[ev.p] = ev.cash;
      banner(`${t('miss')} ${t('minus10', { amount: RULES.MISS_PENALTY })}`, 'bad', 1200);
      audio.play('miss');
      if (app.mode === 'online') app.locked = true;
      break;
    case 'detective':
      app.shield[ev.p]++;
      cellEl(ev.c).classList.add('good');
      cellEl(ev.c).disabled = true;
      banner(t(isMe(ev.p) && app.mode !== 'local' ? 'detectiveFoundYou' : 'detectiveFound', { name: nameOf(ev.p) }), 'good');
      audio.play('detective');
      break;
    case 'blocked':
      app.shield[ev.p]--;
      cellEl(ev.c).disabled = true;
      banner(t('banditBlocked'), 'good');
      audio.play('blocked');
      if (app.mode === 'online' && $('#board .cell.open:not(.special)')) app.locked = true;
      break;
    case 'steal':
      app.cash[ev.p] = 0;
      cellEl(ev.c).disabled = true;
      banner(ev.amount === 0 ? t('banditNothing')
        : isMe(ev.p) && app.mode !== 'local' ? t('banditStealsYou', { amount: ev.amount }) : t('banditSteals', { amount: ev.amount, name: nameOf(ev.p) }), 'bad', 2200);
      audio.play('steal');
      if (app.mode === 'online' && $('#board .cell.open:not(.special)')) app.locked = true;
      break;
    case 'close':
      for (const c of ev.cells) cellEl(c)?.classList.remove('open', 'wrong');
      audio.play('close');
      app.locked = false;
      break;
    case 'turn':
      app.turn = ev.p;
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- parties hors ligne
function resetBoard() {
  clearTimers();
  app.mode = null;
  app.game = null;
  app.grid = null;
  app.over = null;
  app.locked = false;
  app.aiBusy = false;
  app.ai = null;
  app.cash = [0, 0];
  app.shield = [0, 0];
  app.turn = 0;
  app.timeLeft = null;
  $('#board').replaceChildren();
  $('#banner').hidden = true;
  renderHud();
}

function newGame(config, players) {
  const layout = generate(config.cols, config.rows, config.bandits, config.detectives, randomSeed());
  app.game = new Game(layout, players);
  app.cash = new Array(2).fill(0);
  app.shield = new Array(2).fill(0);
  app.turn = 0;
  app.over = null;
  app.locked = false;
  buildBoard({ cols: layout.cols, rows: layout.rows, skins: layout.skins });
}

function startSolo() {
  resetBoard();
  app.mode = 'solo';
  app.level = 0;
  app.bank = 0;
  hidePanels();
  audio.unlock();
  startLevel();
}

function startLevel() {
  clearTimers();
  const config = RULES.LEVELS[app.level];
  newGame(config, 1);
  app.timeLeft = null;
  if (opts.time) {
    app.timeLeft = 15 + 10 * app.game.layout.pairs;
    app.tick = setInterval(() => {
      if (app.over) return;
      app.timeLeft -= 1;
      renderHud();
      if (app.timeLeft <= 0) endSolo(false, true);
    }, 1000);
  }
  hidePanels();
  renderHud();
}

function startVersus(mode) {
  resetBoard();
  app.mode = mode;
  audio.unlock();
  if (mode === 'ai') {
    app.names = ['', ''];
    app.nameKeys = ['you', 'computer'];
    app.ai = createAI(opts.level, randomSeed());
  } else {
    app.names = [opts.names[0] || t('player1'), opts.names[1] || t('player2')];
    app.nameKeys = [null, null];
  }
  newGame(RULES.SIZES[RULES.SIZE_OF_LEVEL[opts.level] ?? 'm'], 2);
  hidePanels();
  renderHud();
  if (mode === 'local') banner(t('turnOf', { name: nameOf(0) }), '', 1200);
}

function onCell(i) {
  audio.unlock();
  if (app.over || app.locked || !app.mode) return;
  if (app.mode === 'online') {
    if (app.turn === app.mySide) net.sendOpen(i);
    return;
  }
  if (app.mode === 'ai' && app.game.turn !== 0) return;
  const events = app.game.open(i);
  if (!events) return;
  app.ai?.observe(events);
  applyEvents(events);
  afterLocal();
}

/** Après un coup hors ligne : fin de grille, erreur à refermer, ou au tour de l'ordinateur. */
function afterLocal() {
  const g = app.game;
  if (g.over) {
    app.locked = true;
    later(finishLocal, 900);
    return;
  }
  if (g.pending.length > 0) {
    app.locked = true;
    later(() => {
      const events = g.settle();
      if (!events) return;
      const before = app.turn;
      applyEvents(events);
      afterLocal();
      if (app.mode === 'local' && app.turn !== before) banner(t('turnOf', { name: nameOf(app.turn) }), '', 1200);
    }, RULES.SETTLE_MS);
    return;
  }
  app.locked = false;
  if (app.mode === 'ai' && g.turn === 1 && !app.aiBusy) {
    app.locked = true;
    app.aiBusy = true;
    later(aiMove, 800);
  }
}

function aiMove() {
  app.aiBusy = false;
  if (app.mode !== 'ai' || app.over) return;
  const g = app.game;
  const events = g.open(app.ai.pick(g));
  if (!events) return;
  app.ai.observe(events);
  applyEvents(events);
  if (g.first !== -1) {
    app.aiBusy = true;
    later(aiMove, 700);                       // la deuxième porte
    return;
  }
  afterLocal();
}

function finishLocal() {
  const g = app.game;
  app.over = true;
  if (app.mode === 'solo') return endSolo(true, false);
  const winner = g.winner();
  const mine = app.mode === 'ai' && winner === 0;
  $('#over-title').textContent = winner === -1 ? t('draw') : app.mode === 'ai' ? t(mine ? 'youWin' : 'youLose') : t('playerWins', { name: nameOf(winner) });
  $('#over-detail').textContent = t('finalCash', { a: g.cash[0], b: g.cash[1] });
  $('#over-again').textContent = t('again');
  $('#over-again').dataset.action = app.mode === 'ai' ? 'ai' : 'local';
  audio.play(winner === -1 || mine || app.mode === 'local' ? 'win' : 'lose');
  renderHud();
  showPanel('over');
  return undefined;
}

/** Fin d'une manche de campagne : réussie (grille terminée) ou temps écoulé. */
function endSolo(cleared, timeUp) {
  clearInterval(app.tick);
  app.over = true;
  app.locked = true;
  if (cleared) app.bank += app.cash[0];
  const lastLevel = app.level === RULES.LEVELS.length - 1;
  let title;
  let detail;
  if (cleared && !lastLevel) {
    title = t('levelDone');
    detail = t('levelDoneDetail', { cash: app.cash[0], total: app.bank });
    $('#over-again').textContent = t('next');
    $('#over-again').dataset.action = 'next';
  } else {
    title = t(timeUp ? 'timeUp' : 'campaignDone');
    detail = t(timeUp ? 'timeUpDetail' : 'campaignDetail', { total: app.bank });
    const record = app.bank > (opts.best ?? 0);
    if (record) { opts.best = app.bank; saveOpts(); }
    detail += ` ${record && app.bank > 0 ? t('newBest') : t('bestScore', { best: opts.best })}`;
    $('#over-again').textContent = t('again');
    $('#over-again').dataset.action = 'solo';
  }
  $('#over-title').textContent = title;
  $('#over-detail').textContent = detail;
  audio.play(timeUp ? 'lose' : 'win');
  renderHud();
  later(() => showPanel('over'), timeUp ? 300 : 0);
}

// ---------------------------------------------------------------- quitter
function endSession() {
  if (app.mode === 'online') {
    net.send({ t: 'leave' });
    backToLobby();
    return;
  }
  resetBoard();
  showPanel('menu');
}

// ---------------------------------------------------------------- mode en ligne
const net = new Net({
  onopen: () => {
    online.status = 'hello';
    setOnlineStatus('');
    $('#join').hidden = false;
    $('#lobby').hidden = true;
    $('#nick').focus();
  },
  onmessage: (m) => handle(m),
  onclose: (wasOpen) => {
    const inMatch = app.mode === 'online';
    closeOnlineSession();
    online.status = 'idle';
    if (inMatch || !$('#online').hidden || wasOpen) {
      resetBoard();
      showPanel('online');
      $('#join').hidden = true;
      $('#lobby').hidden = true;
      setOnlineStatus(t(wasOpen ? 'disconnected' : navigator.onLine === false ? 'offline' : 'unreachable'), true);
    }
  },
});

function setOnlineStatus(text, error = false) {
  const el = $('#online-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function openOnline() {
  closeOnlineSession();
  resetBoard();
  showPanel('online');
  online.status = 'connecting';
  $('#join').hidden = true;
  $('#lobby').hidden = true;
  $('#invite').hidden = true;
  setOnlineStatus(t('connecting'));
  net.connect();
}

function closeOnlineSession() {
  if (app.mode === 'online') app.mode = null;
  online.invite = null;
}

function leaveOnline() {
  net.close();
  closeOnlineSession();
  online.status = 'idle';
  showPanel('menu');
}

const ERRORS = { bad_name: 'errName', name_taken: 'errTaken', busy: 'errBusy', rate: 'errRate', full: 'errFull', not_ready: 'errGeneric', not_your_turn: 'errTurn', bad_cell: 'errCell' };

function handle(m) {
  switch (m.t) {
    case 'welcome':
      online.me = m;
      online.status = 'lobby';
      opts.nick = m.name;
      saveOpts();
      $('#join').hidden = true;
      $('#lobby').hidden = false;
      setOnlineStatus('');
      renderLobby();
      loadBoard($('#board-online'), 4);
      break;
    case 'lobby':
      online.players = m.players;
      if (['lobby', 'queued', 'waiting'].includes(online.status)) renderLobby();
      break;
    case 'queued': online.status = 'queued'; renderLobby(); break;
    case 'unqueued': online.status = 'lobby'; renderLobby(); break;
    case 'waiting': online.status = 'waiting'; setOnlineStatus(t('waitingAnswer', { name: m.name })); break;
    case 'invite':
      online.invite = m;
      $('#invite-text').textContent = t('invitedYou', { name: m.name, size: t(`size_${m.size ?? 'm'}`) });
      $('#invite').hidden = false;
      audio.play('click');
      break;
    case 'invite_cancel':
      online.invite = null;
      $('#invite').hidden = true;
      if (online.status === 'waiting') online.status = 'lobby';
      renderLobby();
      break;
    case 'declined': online.status = 'lobby'; renderLobby(); setOnlineStatus(t('declined', { name: m.name })); break;
    case 'match': startOnlineMatch(m); break;
    case 'ev': onEvents(m); break;
    case 'result': onResult(m); break;
    case 'oppleft': online.oppLeft = true; $('#over-again').disabled = true; break;
    case 'left': backToLobby(); break;
    case 'error':
      if (app.mode === 'online') break;          // un clic de trop pendant l'affichage d'une erreur : sans importance
      setOnlineStatus(t(ERRORS[m.code] ?? 'errGeneric'), true);
      if (online.status === 'waiting') online.status = 'lobby';
      renderLobby();
      break;
    default: break;
  }
}

function startOnlineMatch(m) {
  clearTimers();
  app.mode = 'online';
  app.game = null;
  app.over = null;
  app.locked = false;
  app.mySide = m.side;
  online.status = 'playing';
  online.ranked = m.ranked;
  online.why = m.why ?? null;
  online.oppLeft = false;
  online.invite = null;
  const me = online.me?.name ?? '';
  app.names = m.side === 0 ? [me, m.opp.name] : [m.opp.name, me];
  app.nameKeys = m.side === 0 ? ['you', null] : [null, 'you'];
  app.cash = [0, 0];
  app.shield = [0, 0];
  app.turn = m.turn;
  app.deadline = performance.now() + m.left * 1000;
  buildBoard(m.grid);
  hidePanels();
  audio.unlock();
  renderHud();
  app.tick = setInterval(renderHud, 500);
  banner(t(m.side === m.turn ? 'yourTurn' : 'turnOf', { name: m.opp.name }), '', 1500);
}

function onEvents(m) {
  if (app.mode !== 'online') return;
  app.deadline = performance.now() + m.left * 1000;
  const before = app.turn;
  applyEvents(m.e);
  if (app.turn !== before && !m.e.some((e) => e.e === 'match')) banner(t(app.turn === app.mySide ? 'yourTurn' : 'turnOf', { name: nameOf(app.turn) }), '', 1000);
}

function onResult(m) {
  app.over = m;
  app.locked = true;
  clearInterval(app.tick);
  const mine = m.winner === app.mySide;
  later(() => {
    if (app.mode !== 'online' || app.over !== m) return;
    $('#over-title').textContent = m.winner === -1 ? t('draw') : t(mine ? 'youWin' : 'youLose');
    const rating = m.delta !== undefined ? t('ratingDelta', { rating: m.rating, delta: (m.delta >= 0 ? '+' : '') + m.delta })
      : (m.forfeit ? '' : m.ranked ? t('ranked') : t(online.why ? `why_${online.why}` : 'unranked'));
    $('#over-detail').textContent = [t('finalCash', { a: m.cash[0], b: m.cash[1] }), m.forfeit && mine ? t('oppLeft') : '', rating].filter(Boolean).join(' · ');
    $('#over-again').textContent = t('rematch');
    $('#over-again').disabled = online.oppLeft;
    $('#over-again').dataset.action = 'rematch';
    showPanel('over');
  }, m.forfeit ? 200 : 1300);
  if (!m.forfeit) audio.play(m.winner === -1 || mine ? 'win' : 'lose');
  renderHud();
}

function backToLobby() {
  resetBoard();
  online.status = 'lobby';
  showPanel('online');
  $('#lobby').hidden = false;
  $('#join').hidden = true;
  renderLobby();
  loadBoard($('#board-online'), 4);
}

function renderLobby() {
  const status = online.status;
  $('#quick').textContent = t(status === 'queued' ? 'cancelSearch' : 'quickMatch');
  $('#quick').disabled = status === 'waiting';
  $('#my-rating').textContent = online.me ? `${online.me.name} · ${online.me.rating ?? '—'}${online.me.ranked ? '' : ' · ' + t('unranked')}` : '';
  if (status === 'queued') setOnlineStatus(t('searching'));
  else if (status === 'lobby') setOnlineStatus('');
  const list = $('#players');
  list.replaceChildren();
  if (online.players.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = t('nobody');
    list.append(li);
  }
  for (const p of online.players) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${p.name}${p.rating ? ` (${p.rating})` : ''}`;
    const sub = document.createElement('span');
    sub.className = 'muted';
    sub.textContent = t({ lobby: 'waiting', queued: 'searchingState', playing: 'inMatch' }[p.status] ?? 'waiting');
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = t('challenge');
    btn.disabled = !(p.status === 'lobby' || p.status === 'queued') || status === 'waiting';
    btn.addEventListener('click', () => net.send({ t: 'challenge', id: p.id, size: $('#sel-size').value }));
    li.append(label, sub, btn);
    list.append(li);
  }
}

async function loadBoard(body, limit = 10) {
  const message = (text) => {
    body.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = text;
    tr.append(td);
    body.append(tr);
  };
  try {
    const res = await fetch('api.php', { cache: 'no-store' });
    if (!res.ok) throw new Error('http');
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return message(t('noScores'));
    body.replaceChildren();
    for (const r of rows.slice(0, limit)) {
      const tr = document.createElement('tr');
      for (const v of [r.rank, r.name, r.rating, `${r.wins} / ${r.losses}`]) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.append(td);
      }
      body.append(tr);
    }
  } catch {
    message(t('boardUnavailable'));
  }
  return undefined;
}

// ---------------------------------------------------------------- commandes
$('#board').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (cell && !cell.disabled) onCell(Number(cell.dataset.i));
});

const ACTIONS = {
  solo: startSolo,
  ai: () => startVersus('ai'),
  local: () => startVersus('local'),
  online: openOnline,
  next: () => { app.level += 1; hidePanels(); startLevel(); },
  rematch: () => { $('#over-again').disabled = true; net.send({ t: 'rematch' }); },
  help: () => showPanel('help'),
  closeHelp: () => showPanel(app.mode === null ? 'menu' : ''),
  leaderboard: () => { showPanel('leaders'); loadBoard($('#board-menu'), 20); },
  closeLeaders: () => showPanel('menu'),
  names: () => showPanel('names-dialog'),
  toggleSound: () => { audio.setMuted(!audio.isMuted()); refreshLabels(); },
  toggleLang: () => { i18n.setLang(i18n.getLang() === 'fr' ? 'en' : 'fr'); refreshLabels(); },
  askQuit: () => { if (app.mode === null) return; if (app.over) { endSession(); return; } showPanel('quit-dialog'); },
  cancelQuit: () => hidePanels(),
  quit: endSession,
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  audio.unlock();
  audio.play('click');
  ACTIONS[el.dataset.action]?.();
});

$('#sel-level').addEventListener('change', (e) => { opts.level = e.target.value; saveOpts(); });
$('#opt-time').addEventListener('change', (e) => { opts.time = e.target.checked; saveOpts(); });
$('#names-form').addEventListener('submit', (e) => {
  e.preventDefault();
  opts.names = [$('#name1').value.trim().slice(0, 15), $('#name2').value.trim().slice(0, 15)];
  saveOpts();
  showPanel('menu');
});
$('#online-back').addEventListener('click', leaveOnline);
$('#quick').addEventListener('click', () => net.send({ t: online.status === 'queued' ? 'unqueue' : 'queue' }));
$('#invite-accept').addEventListener('click', () => {
  if (online.invite) net.send({ t: 'accept', id: online.invite.id });
  $('#invite').hidden = true;
});
$('#invite-decline').addEventListener('click', () => {
  if (online.invite) net.send({ t: 'decline', id: online.invite.id });
  online.invite = null;
  $('#invite').hidden = true;
});
$('#join').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#nick').value.trim();
  if (!name) { setOnlineStatus(t('errName'), true); return; }
  audio.unlock();
  net.send({ t: 'hello', name, token: playerToken() });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app.mode !== null && $('#quit-dialog').hidden && !app.over) showPanel('quit-dialog');
  else if (e.key === 'Escape' && !$('#quit-dialog').hidden) hidePanels();
});

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', () => setTimeout(fit, 150));
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe($('#stage'));

// ---------------------------------------------------------------- démarrage
i18n.setLang(i18n.detectLang());
refreshLabels();
showPanel('menu');

// Accès pour les tests de bout en bout dans le navigateur.
window.__knock = { app, online, opts, net, CLOSED };
