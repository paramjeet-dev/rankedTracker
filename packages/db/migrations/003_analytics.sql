-- Analytics layer: everything here is derived and can be rebuilt from layers A/B/C.
CREATE TABLE trophy_timeline (            -- only for players whose OWN log was fetched after the season ended (complete)
  season_id bigint, player_tag text, seq int, at timestamptz, source text, delta int, trophies_after int,
  PRIMARY KEY (season_id, player_tag, seq));

CREATE TABLE player_season_stats (
  season_id bigint, player_tag text, tier_id int, attacks int,
  avg_stars real, three_star_rate real, hundred_rate real, near_miss_rate real,   -- near miss = 2 stars at 85-99%
  expected_stars real, perf_vs_expected real,
  log_complete boolean NOT NULL,                                                  -- true only if own log was fetched after season end
  PRIMARY KEY (season_id, player_tag));

CREATE TABLE player_hour_hist (season_id bigint, player_tag text, hour smallint, n int, PRIMARY KEY (season_id, player_tag, hour)); -- UTC hours of the player's attacks

CREATE TABLE expected_stars_model (       -- empirical lookup, shrunk toward the tier mean (k = 20)
  tier_id int, diff_bucket int, n int, exp_stars real, exp_three real, fit_at timestamptz DEFAULT now(),
  PRIMARY KEY (tier_id, diff_bucket));      -- diff_bucket = floor((attacker trophies - defender trophies) / 50), final trophies as proxy

CREATE TABLE group_stats (
  season_id bigint, group_tag text, tier_id int, n int, avg_trophies real, stddev real, top10_share real,
  avg_prior_trophies real, difficulty_z real, basis text, group_of_death boolean,
  PRIMARY KEY (season_id, group_tag));

CREATE VIEW three_star_percentile AS
SELECT season_id, player_tag, tier_id, three_star_rate, attacks,
       percent_rank() OVER (PARTITION BY season_id, tier_id ORDER BY three_star_rate) AS pct
FROM player_season_stats WHERE log_complete AND attacks >= 10;

-- Reconciliation of the trophy rules against reported final trophies (see scripts/validate.ts).
CREATE VIEW trophy_reconciliation AS
SELECT gm.season_id, gm.player_tag, gm.trophies AS reported, tl.total AS computed, gm.trophies - tl.total AS residual,
       GREATEST(COALESCE(ps.max_battles, 0) - (gm.defense_wins + gm.defense_losses), 0) AS missing_defenses,
       tl.avg_def, round(GREATEST(COALESCE(ps.max_battles, 0) - (gm.defense_wins + gm.defense_losses), 0) * COALESCE(tl.avg_def, 0)) AS expected_bonus
FROM group_member gm
JOIN (SELECT season_id, player_tag, sum(delta) AS total, avg(delta) FILTER (WHERE source = 'def') AS avg_def
      FROM trophy_timeline GROUP BY 1, 2) tl ON tl.season_id = gm.season_id AND tl.player_tag = gm.player_tag
LEFT JOIN player_season ps ON ps.season_id = gm.season_id AND ps.player_tag = gm.player_tag;
