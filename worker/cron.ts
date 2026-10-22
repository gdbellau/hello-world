// Nightly rollup & cleanup (Cron Trigger, free tier allows up to 5).
//
// Wiring (owned elsewhere):
//   worker/index.ts : import { scheduled } from "./cron";  and add `scheduled,` next to `fetch` in the default export
//   wrangler.jsonc  : "triggers": { "crons": ["17 0 * * *"] }
//
// - Rolls each finished day's player_days count into daily_stats('dau'), so the
//   dashboard reads one row per day instead of counting player_days.
// - Prunes player_days past the retention window (dashboard ranges top out at 365d,
//   but older days are already rolled up, so raw rows are only kept for 120 days).
import { addDays } from "./admin-lib";
import { today } from "./db";
import type { Env } from "./env";

export const PLAYER_DAYS_RETENTION = 120;
/** Re-roll a few recent days so a missed cron run heals itself. */
const ROLLUP_LOOKBACK = 3;

export function rollupStatements(db: D1Database, todayStr: string): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 1; i <= ROLLUP_LOOKBACK; i++) {
    const day = addDays(todayStr, -i);
    stmts.push(
      db
        .prepare(
          `INSERT INTO daily_stats (day, metric, value)
           SELECT ?1, 'dau', COUNT(*) FROM player_days WHERE day = ?1
           ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value`,
        )
        .bind(day),
    );
  }
  stmts.push(db.prepare("DELETE FROM player_days WHERE day < ?1").bind(addDays(todayStr, -PLAYER_DAYS_RETENTION)));
  return stmts;
}

export async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(
    env.DB.batch(rollupStatements(env.DB, today())).then(
      () => console.log("cron: rollup ok"),
      (e: unknown) => console.error("cron: rollup failed", e),
    ),
  );
}
