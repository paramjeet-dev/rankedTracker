-- Claim jobs of the season that leaves the API window first (job.season_id), and mark where a player_season row came from.
ALTER TABLE job ADD COLUMN IF NOT EXISTS season_id bigint;
CREATE INDEX IF NOT EXISTS job_pick_season ON job (kind, season_id, priority, run_after, id) WHERE status = 'queued';
-- 'api' = /leaguehistory, 'derived' = built from the season's group rosters (see derivePlayerSeasons); an api row always replaces a derived one.
ALTER TABLE player_season ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'api';
