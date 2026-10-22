-- Admin & ops: daily-active tracking and indexes for the admin console.

-- One row per player per UTC day they opened a session. Written with
-- INSERT OR IGNORE, so a player costs at most one D1 row write per day.
-- The nightly cron (worker/cron.ts) rolls the count into daily_stats('dau')
-- and prunes rows older than the retention window.
CREATE TABLE IF NOT EXISTS player_days (
  day        TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  player_id  TEXT NOT NULL,
  PRIMARY KEY (day, player_id)
) WITHOUT ROWID;

-- Admin player search / detail and audit-log filters.
CREATE INDEX IF NOT EXISTS idx_players_created ON players(created_at);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_purchases_player ON purchases(player_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target, id);
