-- Phase D: registration attempts for groups that have no league_group row yet, and lookup indexes on the group tags
-- that players-profile stores on player. Additive and idempotent.
CREATE TABLE IF NOT EXISTS group_fetch_state (
  group_tag       text        NOT NULL,
  season_id       text        NOT NULL,
  fail_count      integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  gone_at         timestamptz,           -- permanent failure (e.g. 404: the API no longer serves this group)
  PRIMARY KEY (group_tag, season_id)
);

CREATE INDEX IF NOT EXISTS player_current_group_idx
  ON player (current_group_tag, current_group_season_id) WHERE current_group_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_previous_group_idx
  ON player (previous_group_tag, previous_group_season_id) WHERE previous_group_tag IS NOT NULL;
