# THE CABAL: notes for contributors and agents

Isometric 2D real-time tactics game on Cloudflare (Workers + Static Assets + D1). Design: `docs/SCOPE.md`.

## Commands
- `npm run typecheck`: client (`tsconfig.json`, DOM) and worker (`worker/tsconfig.json`, workers-types) separately
- `npm test`: vitest (sim, settings, security)
- `npx vite build`: client build into `dist/`
- Full stack: `cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev:worker` → http://localhost:8787 (`/admin` works locally via `DEV_ADMIN_EMAIL`)

## Layout and conventions
- **Settings:** every tunable number lives in `shared/settings/<area>.ts` and shows up in the admin panel automatically. Don't hard-code balance values.
- **Worker routes:** each area has a module in `worker/routes/` exporting a `Route[]` registered in `worker/index.ts`. Admin routes use `Route<AdminCtx>` and are already behind Access verification.
- **D1:** add new numbered migration files and never edit applied ones. Batch a `bumpStat()` with any write worth charting, and `audit()` with any admin write.
- **Server authority:** credits, unlocks and entitlements are computed server-side. The client sim isn't trusted.
- **Client:** `src/game/sim.ts` is pure (no DOM) so it's unit-testable. Rendering is in `render.ts` / `render-objects.ts`, and the audio facade is `audio.ts`.
- **Free tier:** keep Worker CPU low, add no npm runtime deps to the Worker without need, and keep static assets small.
