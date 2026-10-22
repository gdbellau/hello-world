-- THE CABAL — corp meta-game: roster, cyberware, R&D, campaign progress.

ALTER TABLE players ADD COLUMN research_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN intel INTEGER NOT NULL DEFAULT 0;
-- 1 once the starting roster has been issued (so a wiped roster isn't re-seeded).
ALTER TABLE players ADD COLUMN roster_seeded INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players(id),
  name           TEXT NOT NULL,          -- callsign shown in missions
  full_name      TEXT NOT NULL DEFAULT '',
  cls            TEXT NOT NULL,          -- 'ghost' | 'razor' | 'decker' | 'bruiser'
  level          INTEGER NOT NULL DEFAULT 1,
  xp             INTEGER NOT NULL DEFAULT 0,
  implants       TEXT NOT NULL DEFAULT '{}', -- JSON {head?, torso?, arms?, legs?: augment id}
  injured_until  INTEGER NOT NULL DEFAULT 0, -- epoch ms
  dead           INTEGER NOT NULL DEFAULT 0,
  kills          INTEGER NOT NULL DEFAULT 0,
  missions       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  died_at        INTEGER
);
CREATE INDEX idx_agents_player ON agents(player_id, dead);

CREATE TABLE research (
  player_id     TEXT NOT NULL REFERENCES players(id),
  project       TEXT NOT NULL,
  completed_at  INTEGER NOT NULL,
  PRIMARY KEY (player_id, project)
);

-- Squad deployed on a run (JSON array of agent ids), plus non-credit rewards.
ALTER TABLE mission_runs ADD COLUMN squad TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mission_runs ADD COLUMN rp INTEGER;
ALTER TABLE mission_runs ADD COLUMN intel INTEGER;
-- Campaign progress lookups: "which missions has this player won?"
CREATE INDEX idx_runs_player_outcome ON mission_runs(player_id, outcome, mission_id);
