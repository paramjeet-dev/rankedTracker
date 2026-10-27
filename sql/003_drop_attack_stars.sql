-- An earlier draft of 002 added player_season_result.attack_stars. The API returns 0 for it in every finished
-- season, so the column carries no information. Idempotent: does nothing if the column was never added.
ALTER TABLE player_season_result DROP COLUMN IF EXISTS attack_stars;
