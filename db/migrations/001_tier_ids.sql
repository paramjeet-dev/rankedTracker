-- Migrate an existing DB from the first schema (league_tier.tier INT) to real tier ids. Keeps retention_probe rows.
BEGIN;
DELETE FROM league_tier;
ALTER TABLE league_tier RENAME COLUMN tier TO tier_id;
ALTER TABLE league_tier ALTER COLUMN tier_id TYPE BIGINT;
ALTER TABLE league_tier ADD COLUMN in_scope BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE player_season_result RENAME COLUMN tier TO tier_id;
ALTER TABLE player_season_result ALTER COLUMN tier_id TYPE BIGINT;
ALTER TABLE league_group RENAME COLUMN tier TO tier_id;
ALTER TABLE league_group ALTER COLUMN tier_id TYPE BIGINT;
COMMIT;
