-- Phase C: profile / history visit state and the current + previous league group tags.
-- Additive and idempotent. The old crawler ignores the new columns.
ALTER TABLE player
  ADD COLUMN IF NOT EXISTS fail_count               integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at          timestamptz,
  ADD COLUMN IF NOT EXISTS invalid_at               timestamptz,
  -- time of the last COMPLETE visit (profile + league history both saved); drives new/refresh targeting
  ADD COLUMN IF NOT EXISTS history_backfilled_at    timestamptz,
  ADD COLUMN IF NOT EXISTS current_group_tag        text,
  ADD COLUMN IF NOT EXISTS current_group_season_id  text,
  ADD COLUMN IF NOT EXISTS previous_group_tag       text,
  ADD COLUMN IF NOT EXISTS previous_group_season_id text;

-- "new" pool: players with no complete visit yet.
CREATE INDEX IF NOT EXISTS player_never_visited_idx
  ON player (player_tag)
  WHERE history_backfilled_at IS NULL AND invalid_at IS NULL;
