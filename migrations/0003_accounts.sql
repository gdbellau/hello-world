-- THE CABAL: accounts (email magic links), token versioning, Stripe lifecycle.

-- Single-use login links. Only the SHA-256 of the token is stored, so a DB
-- leak can't be replayed into a session.
CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,       -- hex SHA-256 of the emailed token
  email       TEXT NOT NULL,          -- normalised (trimmed, lower-case)
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  ip          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_login_tokens_expires ON login_tokens(expires_at);

-- Fixed-window counters (one row per bucket per hour). Buckets look like
-- "login:email:<sha256>" or "login:ip:<ip>", so plain emails of people who
-- never finish signing in aren't kept here.
CREATE TABLE rate_limits (
  bucket        TEXT NOT NULL,
  window_start  INTEGER NOT NULL,     -- ms, floored to the window
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

-- Bumping token_version invalidates every session token issued for a player
-- (logout everywhere, or after their device identity is merged away).
ALTER TABLE players ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN email_verified_at INTEGER;
-- Set on an anonymous device player whose entitlements were merged into an account.
ALTER TABLE players ADD COLUMN merged_into TEXT;

-- Stripe lifecycle. Status: 'pending' | 'paid' | 'refunded' | 'disputed' | 'failed'.
ALTER TABLE purchases ADD COLUMN payment_intent TEXT;
ALTER TABLE purchases ADD COLUMN customer_email TEXT;
ALTER TABLE purchases ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN updated_at INTEGER;
CREATE INDEX idx_purchases_payment_intent ON purchases(payment_intent);
CREATE INDEX idx_purchases_player ON purchases(player_id);

-- Pay-what-you-want tip jar. Its Stripe price must use custom_unit_amount;
-- amount_total from the session is what's recorded. Inactive until a Price ID is set.
INSERT OR IGNORE INTO products (id, name, description, kind, price_cents, entitlement, sort) VALUES
  ('tip-jar', 'Tip Jar', 'Pay what you want to keep the servers humming. Adds a tipper badge.', 'tip', 0, 'badge:tipper', 90);
