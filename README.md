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
| `src/game/` | Game client: Canvas 2D isometric renderer, A* pathfinding, guard vision cones, stealth/alarm sim, HUD |
| `src/admin/`, `admin/` | Admin panel: stats, every setting, product catalog, audit log |
| `shared/settings.ts` | Schema for **all** tunable settings, shared by the game, Worker and admin |
| `worker/` | Cloudflare Worker: public API, Access-JWT-protected admin API, Stripe Checkout and webhook |
| `migrations/` | D1 schema |
| `test/` | Vitest unit tests (sim, settings, JWT/Stripe/token verification) |

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
- **1–4:** select an agent
- **Ctrl+A:** select all agents
- **Right-click:** move
- **Right-click an enemy:** attack
- **Space:** pause
- **WASD / arrows:** pan the camera

Reach an unaware enemy to perform a silent takedown. Gunfire raises the alarm.
