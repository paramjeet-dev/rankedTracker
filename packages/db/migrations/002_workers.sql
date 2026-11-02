-- Worker support: shared availability state, final-log flag, coverage views.
CREATE TABLE system_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE job ADD COLUMN locked_at timestamptz;
ALTER TABLE group_member ADD COLUMN log_final boolean NOT NULL DEFAULT false; -- true when the log was fetched after the season ended
CREATE INDEX group_member_pending_logs ON group_member (season_id, group_tag) WHERE NOT log_final;

CREATE VIEW coverage_by_season AS
SELECT g.season_id,
       count(*) AS groups_known,
       count(*) FILTER (WHERE g.roster_fetched_at IS NOT NULL) AS groups_with_roster,
       round(100.0 * count(*) FILTER (WHERE g.roster_fetched_at IS NOT NULL) / count(*), 1) AS pct_groups_rostered,
       sum(g.members_total) AS members_total,
       sum(g.logs_final) AS logs_final,
       round(100.0 * sum(g.logs_final) / NULLIF(sum(g.members_total), 0), 1) AS pct_members_with_final_log
FROM (SELECT lg.*, (SELECT count(*) FROM group_member gm WHERE gm.season_id = lg.season_id AND gm.group_tag = lg.group_tag AND gm.log_final) AS logs_final
      FROM league_group lg) g
GROUP BY g.season_id;
