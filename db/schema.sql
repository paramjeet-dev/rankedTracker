-- Ranked Mode History Tracker: complete schema (fresh install; no migrations needed)
-- Tags are stored as TEXT for now (BIGINT encoding is an optional later optimisation).

CREATE TABLE league_tier (
  tier_id     BIGINT PRIMARY KEY,        -- API leagueTierId, e.g. 105000035 (not a small ordinal)
  name        TEXT,
  in_scope    BOOLEAN NOT NULL DEFAULT false  -- set for the Titan..Electro range after seeding
);
-- Seed with: npm run seed-tiers

CREATE TABLE season (
  season_id   TEXT PRIMARY KEY,          -- API leagueSeasonId = season START, epoch seconds (Monday 05:00 UTC)
  starts_at   TIMESTAMPTZ,               -- = to_timestamp(season_id)
  ends_at     TIMESTAMPTZ,               -- = starts_at + 7 days
  swept_at    TIMESTAMPTZ                -- set when the post-rollover sweep was queued
);

CREATE TABLE clan (
  clan_tag    TEXT PRIMARY KEY,
  name        TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  members_crawled_at TIMESTAMPTZ
);

CREATE TABLE player (
  player_tag  TEXT PRIMARY KEY,
  name        TEXT,
  first_seen  TIMESTAMPTZ DEFAULT now(),
  last_seen   TIMESTAMPTZ DEFAULT now(),
  profiled_at TIMESTAMPTZ,
  tier_id     BIGINT
);

CREATE TABLE player_name_history (
  player_tag  TEXT REFERENCES player,
  name        TEXT,
  seen_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (player_tag, name)
);

-- Layer A: season summaries (backfillable)
CREATE TABLE player_season_result (
  player_tag      TEXT REFERENCES player,
  season_id       TEXT REFERENCES season,
  tier_id         BIGINT,
  trophies        INT,
  placement       INT,
  attack_wins     INT,
  attack_losses   INT,
  defense_wins    INT,
  defense_losses  INT,
  defense_stars   INT,
  max_battles     INT,
  PRIMARY KEY (player_tag, season_id)
);

-- Layer B: groups and rosters
CREATE TABLE league_group (
  group_tag         TEXT,
  season_id         TEXT REFERENCES season,
  tier_id           BIGINT,
  expected_battles  INT,
  stored_battles    INT DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','complete','incomplete')),
  fetched_at        TIMESTAMPTZ,
  PRIMARY KEY (group_tag, season_id)
);

CREATE TABLE group_member (
  group_tag          TEXT,
  season_id          TEXT,
  player_tag         TEXT REFERENCES player,
  clan_tag           TEXT REFERENCES clan,
  trophies           INT,
  attack_wins        INT,
  attack_losses      INT,
  defense_wins       INT,
  defense_losses     INT,
  -- derived
  attacks_logged     INT,
  defenses_logged    INT,
  autofill_trophies  INT,
  avg_attack_stars   NUMERIC(4,3),
  computed_rank      INT,
  logs_fetched_at    TIMESTAMPTZ,
  PRIMARY KEY (group_tag, season_id, player_tag),
  FOREIGN KEY (group_tag, season_id) REFERENCES league_group
);

-- Layer C: battles. Both sides' raw trophy values from the API are kept (see npm run trophies for how they relate).
CREATE TABLE battle (
  season_id     TEXT NOT NULL,
  attacker_tag  TEXT NOT NULL,
  defender_tag  TEXT NOT NULL,
  battle_time   TIMESTAMPTZ NOT NULL,    -- creationTime, identical on both sides
  group_tag     TEXT NOT NULL,
  stars         SMALLINT,
  destruction   SMALLINT,
  attacker_trophies SMALLINT,            -- from the attacker's attack log
  defender_trophies SMALLINT,            -- from the defender's defense log
  PRIMARY KEY (season_id, attacker_tag, defender_tag, battle_time)
) PARTITION BY LIST (season_id);
-- Create one partition per season, e.g.:
-- CREATE TABLE battle_<season_id> PARTITION OF battle FOR VALUES IN ('<season_id>');

CREATE INDEX group_member_pending_idx ON group_member (group_tag, season_id) WHERE logs_fetched_at IS NULL;

-- Battles with both sides' trophy values filled in.
-- Rules (from the game): the attacker earns 40 with 3 stars, 16-32 with 2, 5-15 with 1, 0-4 with 0 stars.
-- The defender gets 40 minus the attacker's trophies, except when the attacker has 0 stars: then the defender gets 40.
-- Raw values come from the API logs; a missing side is derived with these rules. trophy_source tells which.
CREATE VIEW battle_resolved AS
SELECT b.*,
  COALESCE(b.attacker_trophies,
    CASE WHEN b.stars = 3 THEN 40
         WHEN b.stars = 0 THEN LEAST(4, b.destruction / 10)
         ELSE 40 - b.defender_trophies END)                          AS attacker_trophies_final,
  COALESCE(b.defender_trophies,
    CASE WHEN b.stars = 0 THEN 40 ELSE 40 - b.attacker_trophies END) AS defender_trophies_final,
  CASE WHEN b.attacker_trophies IS NOT NULL AND b.defender_trophies IS NOT NULL THEN 'both'
       WHEN b.attacker_trophies IS NOT NULL THEN 'attacker_log'
       ELSE 'defender_log' END                                       AS trophy_source
FROM battle b;

-- Postgres-backed queue (use FOR UPDATE SKIP LOCKED)
CREATE TABLE job (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,             -- clan_members | profile | history_backfill | group_fetch
  payload     JSONB NOT NULL,
  priority    INT NOT NULL DEFAULT 100,  -- lower = sooner (app users, expiring groups first)
  run_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts    INT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed')),
  locked_at   TIMESTAMPTZ,
  last_error  TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (kind, payload)
);
CREATE INDEX job_pick ON job (priority, run_after) WHERE status = 'queued';
CREATE INDEX job_group_idx ON job ((payload->>'groupTag'), (payload->>'seasonId')) WHERE kind = 'group_fetch';

CREATE TABLE raw_response (
  id          BIGSERIAL PRIMARY KEY,
  endpoint    TEXT,
  key         TEXT,
  body        JSONB,
  fetched_at  TIMESTAMPTZ DEFAULT now()
);

-- Spike E: retention probe. Re-fetch the same groups after each Monday rollover.
CREATE TABLE retention_probe (
  group_tag   TEXT,
  season_id   TEXT,
  probed_at   TIMESTAMPTZ DEFAULT now(),
  http_status INT,
  ok          BOOLEAN,
  PRIMARY KEY (group_tag, season_id, probed_at)
);
