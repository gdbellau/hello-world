# THE CABAL — Project Scope

> Year 2080. Nation-states are a memory. Twelve megacorporations carve up the
> sprawl, and you sit on the board of one of them. Your squad of augmented
> operatives does the work the quarterly report never mentions:
> **assassination, research theft, and corporate espionage.**

This document covers what the game is, what it runs on, how it pays for itself,
and the order we build it in. It assumes **Cloudflare free tier only** for
hosting, **Cloudflare Zero Trust (free plan)** for admin access, and **Stripe**
for selling add-ons.

---

## 1. Game design

### 1.1 Pillars
1. **Real-time, with active pause.** Missions play out in real time. Space
   pauses so you can queue orders (Syndicate / Satellite Reign / Commandos).
2. **Isometric 2D.** Readable tile-based maps, depth-sorted sprites, layered
   neon lighting done with 2D tricks rather than 3D.
3. **The corp is the meta-game.** Between missions you run a megacorp:
   budget, R&D, recruitment, augmentation, and rival-corp reputation.
4. **Every number is tunable live.** All balance values come from the server
   config, which the admin panel edits. There are no hard-coded magic numbers.

### 1.2 Core loop
```
Corp HQ (meta) ──► pick contract ──► loadout squad ──► Mission (RTT)
     ▲                                                     │
     └──── credits, intel, research data, rep ◄────────────┘
```

### 1.3 Mission types
| Type | Objective | Win condition | Primary reward |
|---|---|---|---|
| **Assassination** | Eliminate a named VIP | VIP dead + squad extracts | Credits, rival rep damage |
| **Espionage** | Hack N terminals undetected | Data uplinked + extract | Intel (unlocks contracts) |
| **Research theft** | Extract a scientist or prototype | Package reaches extraction | Research points (unlocks tech) |
| **Sabotage** *(later)* | Destroy infrastructure | Charges detonated | Rival corp market share |

### 1.4 Agents
- 4-agent squad per mission, drawn from a roster of up to 12.
- Stats: HP, speed, accuracy, stealth, hacking, and implant slots.
- Classes: **Ghost** (stealth/infiltration), **Razor** (melee/assassin),
  **Decker** (hacking/drones), **Bruiser** (heavy weapons/tank).
- Augments (cyberware) slot into head, torso, arms, and legs. Permadeath is
  optional (an "Ironman" setting).

### 1.5 AI and stealth
- Guards follow patrol routes, have vision cones with line-of-sight against
  walls, and escalate through alert states: *calm → suspicious → alarmed*.
- Cameras, turrets, and civilians (who flee and raise alarms).
- Noise radius from gunfire, plus a global alert timer that brings in
  reinforcements.

### 1.6 Corp meta-game (phase 3+)
- **Board screen:** credits, quarterly targets, and share price as the score.
- **R&D tree:** weapons, cyberware, drones, and ICE breakers.
- **World map:** 2080 megacity districts, each controlled by a corp. Missions
  shift control.
- **Rival corps:** they react to your actions with counter-ops against your
  assets.

### 1.7 Art direction
- Pixel-art isometric (64×32 tiles) in a neon-noir palette (magenta, cyan,
  and acid yellow on deep indigo).
- The prototype uses procedural vector shapes. Sprite atlases come in phase 2
  (Aseprite → texture atlas JSON).
- Audio: synthwave/darksynth loops. Store it in R2 and stream it.

---

## 2. Technical architecture (Cloudflare free tier)

```
                ┌───────────────────────────────────────────────┐
 Player ───────►│  Cloudflare Worker  (single deploy)           │
 browser        │   ├─ Static assets: game client (Vite build)  │
                │   ├─ /api/*   public game API                 │
                │   ├─ /api/stripe/webhook                      │
 Admin ──► CF ─►│   └─ /admin/* admin UI + API (Access JWT)     │
 (Zero Trust    │                    │                          │
  Access)       └────────────────────┼──────────────────────────┘
                                     ▼
                       D1 (SQLite): players, settings, products,
                       entitlements, purchases, mission_runs,
                       daily_stats, audit_log
                                     │
                       R2 (later): sprite atlases, music, DLC packs
                                     │
                       Stripe Checkout + webhooks (outbound fetch)
```

### 2.1 Stack choices
| Concern | Choice | Why |
|---|---|---|
| Client | TypeScript + Canvas 2D, built with Vite | No engine weight, full control of iso depth sorting. Can move to PixiJS (WebGL) when sprite counts demand it. |
| Hosting | **Workers + Static Assets** | Static asset requests are free and unlimited. One deploy serves the game, API, and admin. |
| Database | **D1** | Free tier: 5 GB, 5M row reads/day, 100k row writes/day. |
| Blob storage | **R2** (phase 2) | Free tier: 10 GB, with no egress fees. |
| Admin auth | **Cloudflare Access** (Zero Trust free tier, up to 50 users) | No passwords in our code. The Worker also verifies the `Cf-Access-Jwt-Assertion` JWT as defence in depth. |
| Payments | **Stripe Checkout** (hosted) | No card data touches us. The webhook grants entitlements. |
| Analytics | D1 `daily_stats` plus Cloudflare Web Analytics | Free, cookieless, and visible in the admin panel. |

### 2.2 Free-tier budget
| Resource | Free limit | Expected usage | Mitigation |
|---|---|---|---|
| Worker requests | 100k/day | About 5 API calls per session, so roughly 20k sessions/day | Static assets aren't counted. Cache `/api/config` at the edge for 60 s. |
| Worker CPU | 10 ms/request | JWT verification and HMAC take about 1–2 ms | Cache JWKS in isolate memory. |
| D1 reads | 5M rows/day | Low | Indexed queries only. |
| D1 writes | 100k rows/day | About 4 per mission | Batch stat increments. |

When a free limit is hit, the Workers Paid plan costs $5/mo. That's the first
cost to cover from add-on revenue.

### 2.3 Trust model
- The client runs the simulation. It isn't authoritative for anything that
  costs money.
- The server owns credits, unlocks, and entitlements. Mission rewards are
  computed **server-side** from the outcome and the live config, with
  sanity checks (minimum duration, one completion per run, rate limits).
- Paid content is gated by the `entitlements` table, written only by the
  Stripe webhook or an admin grant.

### 2.4 Player identity
- **Phase 1:** anonymous device identity. The server issues a player ID
  signed with HMAC (`SESSION_SECRET`), stored in `localStorage`.
- **Phase 4 (before the store launches):** account linking by email magic
  link (sent with Cloudflare Email Workers or Resend's free tier). Purchases
  can then be restored on a new device. The Stripe customer email is linked
  to the account.

---

## 3. Monetisation (covering costs)

Principle: **no pay-to-win.** The base campaign is free and complete.

| Product | Type | Indicative price | Notes |
|---|---|---|---|
| **Supporter Pack** | One-off | $4.99 | Badge, exclusive "Founder" agent skin, name in credits |
| **Agent Skin Packs** | Cosmetic | $1.99–$2.99 | Chrome, Yakuza, Corporate Exec, Street Samurai |
| **Expansion: Orbital Arcology** | DLC campaign | $6.99 | New district, 8 missions, new enemy faction |
| **Expansion: Neo-Lagos Data Wars** | DLC campaign | $6.99 | Hacking-focused campaign, Decker class upgrades |
| **Corp Liveries** | Cosmetic | $0.99 | HQ and UI themes |
| **Tip jar** | Pay-what-you-want | Any amount | Stripe Checkout supports custom amounts |

- All products live in the D1 `products` table and are editable in the admin
  panel: name, price, Stripe Price ID, and active flag.
- A **store kill switch** (`store_enabled`) lives in the settings.
- Stripe flow:
  1. `/api/store/checkout` creates a Checkout Session.
  2. The player is redirected to Stripe.
  3. `checkout.session.completed` arrives at the webhook.
  4. The webhook writes an `entitlements` row and records revenue in stats.
- Refunds: the `charge.refunded` webhook revokes the entitlement (phase 4).
- Tax/VAT: use Stripe Tax, or sell through Lemon Squeezy / Paddle as merchant
  of record if VAT admin becomes painful. This is a business decision to make
  before launch.

---

## 4. Admin panel (Zero Trust)

Served at `/admin`, behind a Cloudflare Access application.

| Section | What it does |
|---|---|
| **Dashboard / Stats** | Players (total and daily new), missions started/won/lost, win rate by mission type, revenue by day and product, and live config version. |
| **Settings** | Every game setting, rendered generically from the schema in `shared/settings.ts`. Includes balance, economy, AI, feature flags, store, and maintenance mode. Values are validated against min/max/type and every change is audit-logged. |
| **Products** | Store catalog CRUD: price, Stripe Price ID, active, and the entitlement key it grants. |
| **Players** *(phase 3)* | Search, view entitlements, grant/revoke, reset progress, ban. |
| **Audit log** | Who changed what and when, using the email from the Access JWT. |

Setup steps are in [`docs/SETUP.md`](./SETUP.md).

---

## 5. Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| **0. Foundations** | Repo, Worker + D1 + assets, settings schema, admin shell, Access verification, Stripe webhook verification, iso prototype | **This commit** |
| **1. Vertical slice** | One polished assassination mission: sprites, sound, stealth AI, alert states, save/load | Next |
| **2. Mission variety** | Espionage and research-theft objectives, hacking mini-interaction, cameras/turrets, 6 missions, R2 assets | |
| **3. Corp meta** | HQ screen, roster/recruitment, augments, R&D tree, world map, admin player tools | |
| **4. Store** | Accounts (magic link), Stripe live mode, entitlements in client, cosmetics pipeline, refunds | |
| **5. Content & launch** | Full base campaign (~15 missions), first DLC, itch.io/Newgrounds listing, Discord | |

### Risks and open questions
1. **Repo location.** This scaffold was built in `hello-world` because the
   session couldn't create `the_CABAL`. Create the private repo and push this
   branch into it (see `docs/SETUP.md`).
2. **Art pipeline.** Who produces the sprites? Options are commissioning
   pixel art or AI-assisted generation with a human pass. This is the largest
   cost and schedule risk.
3. **Merchant of record vs. Stripe Tax.** Decide this before phase 4.
4. **Cheating on rewards.** Rewards are server-computed, but completions can
   still be spoofed. That's acceptable while credits are only earned in-game
   and never bought. Don't sell soft currency without server-side simulation.
