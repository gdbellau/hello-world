# THE CABAL

**2080.** Nation-states are a memory and twelve megacorporations carve up the sprawl.
You sit on the board of one of them, and your squad of augmented operatives handles the
work the quarterly report never mentions: assassination, research theft, and corporate
espionage.

An isometric 2D real-time tactics game (with active pause) that runs entirely on the
Cloudflare free tier.

- 📐 **Scope, design & roadmap:** [`docs/SCOPE.md`](docs/SCOPE.md)
- 🛠 **Setup (Cloudflare, Zero Trust, Stripe):** [`docs/SETUP.md`](docs/SETUP.md)

## What's here

| Path | What |
|---|---|
| `src/game/` | Game client: sim (stealth AI, cameras, turrets, hacking, civilians), Canvas 2D isometric renderer |
| `src/game/missions/` | 6 contracts (assassination / espionage / research theft) authored as ASCII maps |
| `src/game/hq/` | Corp meta-game screens: HQ board, roster, recruit, cyberware, R&D, world map, loadout, debrief |
| `src/game/gfx/`, `src/game/sfx/` | Procedural pixel-art sprites, skins, lighting and FX; WebAudio synthwave and SFX |
| `src/game/store.ts`, `account.ts` | In-game store (Stripe Checkout) and email magic-link accounts |
| `src/admin/`, `admin/` | Ops console: dashboard charts, players, all settings (import/export), products, audit log, system health |
| `shared/settings/` | Schema for **every** tunable value (180 settings), shared by the game, Worker and admin |
| `shared/corp/` | Corp rules shared by client and server: classes, augments, R&D tree, XP, rewards, world map |
| `worker/` | Cloudflare Worker: one route module per area, Access-JWT-protected admin API, Stripe webhooks, nightly cron |
| `migrations/` | D1 schema (0001–0005) |
| `test/` | Vitest unit tests (128): sim, missions, corp rules, settings, accounts, store, admin, security |

## Quick start

```bash
npm install
npm run dev            # client only at http://localhost:5173, runs offline with default settings

# Full stack (Worker + local D1):
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev:worker     # http://localhost:8787 and http://localhost:8787/admin
npm test
```

## Controls

- **Left-click / drag:** select agents
- **1–6:** select an agent
- **Ctrl+A:** select all agents
- **Right-click:** move
- **Right-click an enemy:** attack
- **Right-click a terminal, door or package:** hack it or pick it up
- **Space:** pause
- **WASD / arrows:** pan the camera
- **M:** mute

Reach an unaware enemy to perform a silent takedown. Gunfire draws guards, and a wounded guard sounds the alarm.
