-- coc Tracker v2: initial schema (PostgreSQL 16)
CREATE TABLE league_tier (
  tier_id int PRIMARY KEY, name text, promote_rate real, demote_rate real DEFAULT 0.15
);
-- Promotion rates for tiers 26..33 in ascending order (from the user). Verify empirically via player_season_result.
INSERT INTO league_tier (tier_id, promote_rate) VALUES
  (105000026,0.50),(105000027,0.40),(105000028,0.30),(105000029,0.25),
  (105000030,0.25),(105000031,0.20),(105000032,0.20),(105000033,0.15);

CREATE TABLE season (
  season_id bigint PRIMARY KEY,          -- unix start time (assumed; verify)
  starts_at timestamptz GENERATED ALWAYS AS (to_timestamp(season_id)) STORED,
  ends_at   timestamptz GENERATED ALWAYS AS (to_timestamp(season_id + 604800)) STORED
);

CREATE TABLE player (
  tag text PRIMARY KEY, name text, first_seen timestamptz DEFAULT now(),
  last_profiled_at timestamptz, last_history_at timestamptz,
  cur_group_tag text, cur_season_id bigint, prev_group_tag text, prev_season_id bigint
);

CREATE TABLE player_snapshot (          -- name/clan/townhall over time
  player_tag text, at timestamptz DEFAULT now(), name text, clan_tag text, town_hall int, trophies int,
  PRIMARY KEY (player_tag, at)
);

-- Layer A
CREATE TABLE player_season (
  player_tag text, season_id bigint REFERENCES season, tier_id int, trophies int, placement int,
  attack_wins int, attack_losses int, defense_wins int, defense_losses int, defense_stars int, max_battles int,
  PRIMARY KEY (season_id, player_tag)
);

CREATE TABLE league_group (
  season_id bigint REFERENCES season, group_tag text, tier_id int, probe_player_tag text,
  discovered_at timestamptz DEFAULT now(), roster_fetched_at timestamptz,
  members_total int, logs_fetched int DEFAULT 0,
  PRIMARY KEY (season_id, group_tag)
);

-- Layer B
CREATE TABLE group_member (
  season_id bigint, group_tag text, player_tag text, player_name text,
  clan_tag text, clan_name text, trophies int,
  attack_wins int, attack_losses int, defense_wins int, defense_losses int,
  roster_fetched_at timestamptz DEFAULT now(), log_fetched_at timestamptz,
  PRIMARY KEY (season_id, group_tag, player_tag)
);
CREATE INDEX group_member_player ON group_member (player_tag, season_id);
CREATE INDEX group_member_clan ON group_member (clan_tag, season_id);

-- Layer C: one row per battle, seen from either side's log.
-- *_reported = raw "trophies" field from that side's log (kept to validate the trophy formulas).
-- Gains are computed from stars/destruction via shared/trophies.ts at insert time.
CREATE TABLE battle (
  season_id bigint NOT NULL, group_tag text NOT NULL,
  attacker_tag text NOT NULL, defender_tag text NOT NULL, battle_time timestamptz NOT NULL,
  stars smallint NOT NULL, destruction smallint NOT NULL,
  attacker_gain smallint, defender_gain smallint,
  atk_log_reported smallint, def_log_reported smallint,
  PRIMARY KEY (season_id, attacker_tag, defender_tag, battle_time)
) PARTITION BY RANGE (season_id);
CREATE INDEX battle_defender ON battle (defender_tag, season_id);
CREATE INDEX battle_group ON battle (season_id, group_tag);

CREATE OR REPLACE FUNCTION ensure_season(sid bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO season (season_id) VALUES (sid) ON CONFLICT DO NOTHING;
  EXECUTE format('CREATE TABLE IF NOT EXISTS battle_%s PARTITION OF battle FOR VALUES FROM (%s) TO (%s)',
                 sid, sid, sid + 604800);
END $$;

-- Ingestion plumbing
CREATE TABLE job (
  id bigserial PRIMARY KEY, kind text NOT NULL, dedupe_key text NOT NULL, payload jsonb NOT NULL,
  priority smallint NOT NULL DEFAULT 5, run_after timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'queued', last_error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX job_dedupe ON job (kind, dedupe_key) WHERE status IN ('queued','running');
CREATE INDEX job_pick ON job (priority, run_after) WHERE status = 'queued';

CREATE TABLE fetch_log (
  at timestamptz DEFAULT now(), endpoint text, status smallint, ms int, bytes int, key_id smallint, season_id bigint
);

-- Derived (see plan): promotion outcome per player-season.
CREATE VIEW player_season_result AS
SELECT ps.*, lg.members_total AS group_size,
       ps.placement::real / NULLIF(lg.members_total, 0) AS placement_pct,
       nxt.tier_id AS next_tier_id,
       CASE WHEN nxt.tier_id > ps.tier_id THEN 'promoted'
            WHEN nxt.tier_id < ps.tier_id THEN 'demoted'
            WHEN nxt.tier_id = ps.tier_id THEN 'stayed' END AS outcome
FROM player_season ps
LEFT JOIN player_season nxt ON nxt.player_tag = ps.player_tag AND nxt.season_id = ps.season_id + 604800
LEFT JOIN group_member gm ON gm.season_id = ps.season_id AND gm.player_tag = ps.player_tag
LEFT JOIN league_group lg ON lg.season_id = gm.season_id AND lg.group_tag = gm.group_tag;
