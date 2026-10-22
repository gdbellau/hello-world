-- Admin "reset progress" keeps mission history for stats but forgets campaign
-- clears from before the reset.
ALTER TABLE players ADD COLUMN progress_reset_at INTEGER NOT NULL DEFAULT 0;
