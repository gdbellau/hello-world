-- THE CABAL — initial schema (Cloudflare D1 / SQLite)

CREATE TABLE players (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  email         TEXT UNIQUE,
  corp_name     TEXT NOT NULL DEFAULT 'Unnamed Corp',
  credits       INTEGER NOT NULL DEFAULT 0,
  banned        INTEGER NOT NULL DEFAULT 0
);

-- Overrides only; defaults live in shared/settings.ts.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,          -- JSON-encoded
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);

CREATE TABLE products (
  id               TEXT PRIMARY KEY,  -- slug, e.g. 'supporter-pack'
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL,     -- 'cosmetic' | 'expansion' | 'supporter'
  price_cents      INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'usd',
  stripe_price_id  TEXT,
  entitlement      TEXT NOT NULL,     -- key granted on purchase
  active           INTEGER NOT NULL DEFAULT 0,
  sort             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE entitlements (
  player_id    TEXT NOT NULL REFERENCES players(id),
  entitlement  TEXT NOT NULL,
  source       TEXT NOT NULL,         -- 'stripe' | 'admin'
  granted_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  PRIMARY KEY (player_id, entitlement)
);

CREATE TABLE purchases (
  stripe_session_id  TEXT PRIMARY KEY,
  player_id          TEXT NOT NULL,
  product_id         TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL,   -- 'paid' | 'refunded'
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_purchases_created ON purchases(created_at);

CREATE TABLE mission_runs (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL,
  mission_id   TEXT NOT NULL,
  mission_type TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  outcome      TEXT,                  -- 'win' | 'loss' | 'abort'
  stealth      INTEGER,
  reward       INTEGER
);
CREATE INDEX idx_runs_player ON mission_runs(player_id);
CREATE INDEX idx_runs_started ON mission_runs(started_at);

-- Pre-aggregated counters so the admin dashboard is a cheap read.
CREATE TABLE daily_stats (
  day     TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  metric  TEXT NOT NULL,
  value   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  target   TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at ON audit_log(at);

-- Seed catalog (inactive until Stripe Price IDs are filled in via admin).
INSERT INTO products (id, name, description, kind, price_cents, entitlement, sort) VALUES
  ('supporter-pack', 'Supporter Pack', 'Founder agent skin, badge, and your name in the credits.', 'supporter', 499, 'supporter', 10),
  ('skins-chrome', 'Chrome Skin Pack', 'Mirror-finish full-body conversions for all four classes.', 'cosmetic', 199, 'skin:chrome', 20),
  ('skins-yakuza', 'Yakuza Skin Pack', 'Irezumi-inked operatives with katana trails.', 'cosmetic', 299, 'skin:yakuza', 30),
  ('dlc-orbital', 'Expansion: Orbital Arcology', 'A new district in low orbit. 8 missions and a new enemy faction.', 'expansion', 699, 'dlc:orbital', 40),
  ('dlc-neolagos', 'Expansion: Neo-Lagos Data Wars', 'A hacking-heavy campaign with Decker upgrades.', 'expansion', 699, 'dlc:neolagos', 50);
