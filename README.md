# Knock Knock

[![CI](https://github.com/OpenPrunus/knock-knock/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenPrunus/knock-knock/actions/workflows/ci.yml)

A memory game with an asymmetric interface, inspired by the 1990s Macintosh classic *On-The-Contrary*. The board is a patchwork of
doors that all look different — a wooden cupboard, a garage shutter, a safe, a gothic coffin — and **the look of a door tells nothing
about what hides behind it**: two identical pictures can sit behind two completely different doors. Only your memory counts.

## Features

- **Doors with a personality**: six types, each opening its own way (the cupboard swings, the garage rolls up, the safe turns, the coffin
  lid tips, the fridge swings, the theatre curtain parts). Everything is drawn in CSS, with a little perspective; no image files.
- **Cash**: a pair is worth **+$100** (and the doors stay open), a mismatch costs **$10** (the doors close again after 1.5 s).
- **The Bandit**: when a door reveals him, he steals all the cash you made in the current grid.
- **The Detective**: found first, he stays with you as a one-shot shield — he stops the next Bandit, then he is gone.
- **Solo campaign**: eight grids of growing size with more and more Bandits, plus an optional **time attack**. The level changes the campaign: easy stays small (3×4 up to 5×6), normal goes from 3×4 to 6×7, hard starts at 4×4 and ends on 6×7 with up to 8 Bandits. One best total is kept per level.
- **Grid size follows the level**: easy 4×4, normal 5×5, hard 6×6 (more doors, more Bandits) against the computer and on the same screen. Online, quick match is 5×5 and whoever sends a challenge picks 4×4, 5×5 or 6×6.
- **Against the computer** (easy / normal / hard): it takes turns on the same grid, plays again after a pair, and never cheats: it only
  knows the doors it has seen, and remembers each one with a probability of 30 % / 60 % / 95 %.
- **Two players on the same screen** (pass & play): the richest at the end of the grid wins.
- **Online 1v1**: a PHP 8.5 WebSocket server draws one grid for both players and is the only one to know what is behind the doors
  (the browser only receives what is revealed). Quick match, challenges, Elo ranking, nicknames reserved by browser token, rematch,
  and an IP-based anti-cheat (see below).
- **Mobile**: the whole grid always fits the screen, in portrait and landscape; doors are opened with a tap.
- **Installable and playable offline** (PWA): web manifest, icons, and a service worker that serves the last visit's files when there is no network. Solo, computer and same-screen modes work offline; online play shows a clear message.
- French and English, synthesized sounds, no account.

## Quick start

```bash
docker compose up -d --build
```

Game: <http://localhost:8097> — game server: `ws://localhost:8098`. See [INSTALL.md](INSTALL.md) for a setup without Docker,
the configuration variables and an HTTPS reverse proxy.

## Rules in detail

- Open a first door, then a second one. Same picture: the pair is validated for good (+$100). Different pictures: −$10 (never below
  zero) and both doors close after 1.5 s.
- With two players, finding a pair lets you play again; a mistake passes the turn. A Bandit also ends your turn.
- Opening a Detective or a Bandit as the *second* door is not a pair: the first door closes again (a Detective lets you keep the turn, a Bandit ends it). Once revealed, their door stays open, dimmed.
- The Detective stays active in the background for the player who found him. If that player later opens a Bandit, the Detective
  intercepts the attack (nothing is stolen) and is consumed.
- A grid ends when all pairs are found. Bandits and Detectives do not have to be found.
- Online, each player has 30 s per move; two missed turns in a row forfeit the match.

## Architecture

```
src/Engine/          the rules: Rules (constants, levels), Rng (xorshift32), Layout (grid generation), Game (state machine)
src/Game/            the game server: GameHub, MatchService (turns, delays, result, rematch), Room, handlers, lobby, invitations
src/Ranking/         Elo, ranking file, pair limiter
src/Api/             the leaderboard read by web/api.php
server/              the WebSocket server entry point
web/                 index.php (single page), js/ (engine, ai, net, audio, i18n, main), css/, sw.js + manifest (PWA)
tests/               PHPUnit, Node unit tests, integration (real server), browser (real Chrome)
```

The rules exist twice — `web/js/engine.js` (solo, computer and same-screen modes) and `src/Engine/` (online) — with **integer-only**
code (xorshift32 for the grid) so that both produce exactly the same grids and events. Recorded games
(`tests/fixtures/engine-vectors.json`, regenerated with `npm run fixtures`) are replayed by the PHP tests to lock them together.

### Online protocol (JSON over WebSocket)

- The server announces the **match** with the grid shape and the look of each door (`skins`) — never what is behind them.
- Players send `{"t":"open","c":<cell>}`; the server answers both with `{"t":"ev","e":[...]}`: `open` (cell and what it reveals),
  `match`, `miss`, `detective`, `steal`, `blocked`, `close`, `turn`, `end`; then a `result` with the cash of each player.

## Anti-cheat (by IP)

The server reads the real client address from `X-Real-IP`, trusted only when the request comes from a trusted proxy (`TRUSTED_PROXIES`, private networks by default; IPv6 grouped by /64). It is kept in memory only, never stored. A ranked match is refused (it becomes a friendly one, with the reason shown) when both players share an address, when one address uses too many accounts, or when the same pair has played too many ranked matches. Connections per address are capped (HTTP 429). Limits: `KNOCK_MAX_CONN_PER_IP`, `KNOCK_MAX_ACCOUNTS_PER_IP`, `KNOCK_MAX_PAIR_MATCHES`, `KNOCK_ALLOW_SAME_IP`. The logic lives in [arcade-core](https://github.com/OpenPrunus/arcade-core) ≥ 1.1.

## Tests

```bash
composer check            # PHP: code style (PSR-12), PHPStan level 8, PHPUnit
npm run test:unit         # engine, computer player, translations, PWA
npm run test:integration  # the real PHP server with real WebSocket clients
npm run test:browser      # a real headless Chrome (desktop and phone, offline, online match against a robot)
```

## License

MIT — see [LICENSE](LICENSE).
