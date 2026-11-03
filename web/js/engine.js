// Knock — moteur du jeu. Mêmes règles que src/Engine/ (PHP), verrouillées par les vecteurs de tests/fixtures.
// Que des entiers : la même grille et les mêmes événements des deux côtés.

export const RULES = {
  PAIR_GAIN: 100,
  MISS_PENALTY: 10,
  MOTIFS: 18,
  SETTLE_MS: 1500,
  SKINS: 6,
  BANDIT: -1,
  DETECTIVE: -2,
  ONLINE: { cols: 5, rows: 5, bandits: 2, detectives: 1 },
  SIZES: {
    s: { cols: 4, rows: 4, bandits: 1, detectives: 1 },
    m: { cols: 5, rows: 5, bandits: 2, detectives: 1 },
    l: { cols: 6, rows: 6, bandits: 4, detectives: 2 },
  },
  /** Taille de grille selon le niveau (ordinateur et 2 joueurs). */
  SIZE_OF_LEVEL: { easy: 's', normal: 'm', hard: 'l' },
  LEVELS: [
    { cols: 3, rows: 4, bandits: 1, detectives: 1 },
    { cols: 4, rows: 4, bandits: 1, detectives: 1 },
    { cols: 4, rows: 4, bandits: 2, detectives: 0 },
    { cols: 4, rows: 5, bandits: 2, detectives: 2 },
    { cols: 5, rows: 5, bandits: 2, detectives: 1 },
    { cols: 5, rows: 6, bandits: 3, detectives: 1 },
    { cols: 6, rows: 6, bandits: 4, detectives: 2 },
    { cols: 6, rows: 7, bandits: 4, detectives: 2 },
  ],
};

export const CLOSED = 0;
export const PENDING = 1;
export const MATCHED = 2;
export const SPECIAL = 3;

/** xorshift32. */
export class Rng {
  constructor(seed) {
    this.state = (seed >>> 0) === 0 ? 1 : seed >>> 0;
  }

  next() {
    let x = this.state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.state = x;
    return x;
  }

  below(n) {
    return this.next() % n;
  }

  shuffle(items) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/** La grille : ce qu'il y a derrière chaque porte et son apparence (tirées indépendamment). */
export function generate(cols, rows, bandits, detectives, seed) {
  const cells = cols * rows;
  const specials = bandits + detectives;
  if (cols < 1 || rows < 1 || bandits < 0 || detectives < 0 || (cells - specials) % 2 !== 0 || (cells - specials) / 2 > RULES.MOTIFS) {
    throw new Error('Grille impossible');
  }
  const pairs = (cells - specials) / 2;
  const rng = new Rng(seed);
  let items = [];
  for (const motif of rng.shuffle([...Array(RULES.MOTIFS).keys()]).slice(0, pairs)) items.push(motif, motif);
  for (let i = 0; i < bandits; i++) items.push(RULES.BANDIT);
  for (let i = 0; i < detectives; i++) items.push(RULES.DETECTIVE);
  items = rng.shuffle(items);
  const skins = [];
  for (let i = 0; i < cells; i++) skins.push(rng.below(RULES.SKINS));
  return { cols, rows, items, skins, pairs };
}

export class Game {
  constructor(layout, players = 1) {
    this.layout = layout;
    this.players = players;
    this.state = new Array(layout.items.length).fill(CLOSED);
    this.cash = new Array(players).fill(0);
    this.shield = new Array(players).fill(0);
    this.turn = 0;
    this.first = -1;
    this.pending = [];
    this.pairsLeft = layout.pairs;
    this.over = false;
  }

  /** Ouvre une porte ; retourne les événements, ou null si le coup est impossible. */
  open(cell) {
    if (this.over || this.pending.length > 0 || !Number.isInteger(cell) || cell < 0 || cell >= this.state.length || this.state[cell] !== CLOSED) return null;
    const value = this.layout.items[cell];
    const events = [{ e: 'open', c: cell, v: value }];
    const p = this.turn;

    if (value === RULES.DETECTIVE) {
      this.state[cell] = SPECIAL;
      this.shield[p]++;
      events.push({ e: 'detective', c: cell, p });
      return events;
    }
    if (value === RULES.BANDIT) {
      this.state[cell] = SPECIAL;
      if (this.shield[p] > 0) {
        this.shield[p]--;
        events.push({ e: 'blocked', c: cell, p });
      } else {
        events.push({ e: 'steal', c: cell, p, amount: this.cash[p] });
        this.cash[p] = 0;
      }
      if (this.first !== -1) {
        this.pending = [this.first];
        this.first = -1;
      } else {
        this.#passTurn(events);
      }
      return events;
    }
    if (this.first === -1) {
      this.state[cell] = PENDING;
      this.first = cell;
      return events;
    }
    const first = this.first;
    this.first = -1;
    if (this.layout.items[first] === value) {
      this.state[first] = this.state[cell] = MATCHED;
      this.cash[p] += RULES.PAIR_GAIN;
      events.push({ e: 'match', a: first, b: cell, p, cash: this.cash[p] });
      if (--this.pairsLeft === 0) {
        this.over = true;
        events.push({ e: 'end' });
      }
      return events;
    }
    this.state[cell] = PENDING;
    this.cash[p] = Math.max(0, this.cash[p] - RULES.MISS_PENALTY);
    this.pending = [first, cell];
    events.push({ e: 'miss', a: first, b: cell, p, cash: this.cash[p] });
    return events;
  }

  /** Referme les portes d'une erreur (ou la première porte si un bandit est sorti), puis passe la main. */
  settle() {
    if (this.pending.length === 0) return null;
    const cells = this.pending;
    for (const c of cells) this.state[c] = CLOSED;
    this.pending = [];
    const events = [{ e: 'close', cells }];
    this.#passTurn(events);
    return events;
  }

  /** Temps écoulé : la première porte retournée est refermée et la main passe. */
  skip() {
    const events = [];
    if (this.first !== -1) {
      this.state[this.first] = CLOSED;
      events.push({ e: 'close', cells: [this.first] });
      this.first = -1;
    }
    this.#passTurn(events);
    return events;
  }

  winner() {
    if (this.players < 2 || this.cash[0] === this.cash[1]) return -1;
    return this.cash[0] > this.cash[1] ? 0 : 1;
  }

  #passTurn(events) {
    if (this.players < 2) return;
    this.turn = 1 - this.turn;
    events.push({ e: 'turn', p: this.turn });
  }
}
