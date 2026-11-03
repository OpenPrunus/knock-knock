// Knock Knock — sons synthétisés (aucun fichier audio). Les navigateurs exigent un geste utilisateur : unlock().
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('knock.muted') === '1'; } catch { /* ignoré */ }

export function unlock() {
  if (ctx || typeof AudioContext === 'undefined') {
    if (ctx?.state === 'suspended') ctx.resume();
    return;
  }
  ctx = new AudioContext();
}

export const isMuted = () => muted;

export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('knock.muted', m ? '1' : '0'); } catch { /* ignoré */ }
}

function tone(freq, dur, { type = 'sine', gain = 0.12, slide = 0, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function play(name) {
  switch (name) {
    case 'open': tone(180, 0.18, { type: 'sawtooth', gain: 0.07, slide: 120 }); tone(420, 0.06, { type: 'square', gain: 0.04, delay: 0.14 }); break;
    case 'close': tone(300, 0.14, { type: 'sawtooth', gain: 0.05, slide: -160 }); break;
    case 'match': [660, 880].forEach((f, i) => tone(f, 0.14, { type: 'triangle', gain: 0.12, delay: i * 0.1 })); break;
    case 'miss': tone(150, 0.3, { type: 'square', gain: 0.08, slide: -70 }); break;
    case 'steal': [440, 330, 220, 150].forEach((f, i) => tone(f, 0.16, { type: 'sawtooth', gain: 0.09, delay: i * 0.09 })); break;
    case 'detective': [523, 659, 784].forEach((f, i) => tone(f, 0.12, { type: 'triangle', gain: 0.1, delay: i * 0.08 })); break;
    case 'blocked': tone(880, 0.12, { type: 'square', gain: 0.08 }); tone(1175, 0.25, { type: 'triangle', gain: 0.1, delay: 0.1 }); break;
    case 'click': tone(660, 0.05, { type: 'square', gain: 0.05 }); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: 'square', gain: 0.09, delay: i * 0.12 })); break;
    case 'lose': [392, 330, 262].forEach((f, i) => tone(f, 0.22, { type: 'square', gain: 0.09, delay: i * 0.16 })); break;
    default: break;
  }
}
