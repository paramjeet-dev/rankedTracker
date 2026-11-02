/** First-season validation report. Run after the first season is fully captured: `npm run validate`. */
import { sql, rebuildSeason, refitExpectedStars, scoreSeason } from "@coc/core";

const seasons = await sql<{ season_id: number }[]>`select distinct season_id from battle order by 1 desc limit 4`;
for (const s of seasons) await rebuildSeason(Number(s.season_id));
await refitExpectedStars(); for (const s of seasons) await scoreSeason(Number(s.season_id));

console.log("\n1) Which side does the log's `trophies` field describe? (compare with the formulas)");
console.table(await sql`
  select count(*) filter (where atk_log_reported is not null) atk_log_rows,
         count(*) filter (where atk_log_reported = attacker_gain) atk_log_equals_attacker_gain,
         count(*) filter (where atk_log_reported = defender_gain and atk_log_reported <> attacker_gain) atk_log_equals_defender_gain,
         count(*) filter (where def_log_reported is not null) def_log_rows,
         count(*) filter (where def_log_reported = defender_gain) def_log_equals_defender_gain,
         count(*) filter (where def_log_reported = attacker_gain and def_log_reported <> defender_gain) def_log_equals_attacker_gain
  from battle`);

console.log("\n2) Trophy reconciliation for players with complete logs: residual minus expected missing-defense bonus (0 = rules hold)");
console.table(await sql`
  select count(*) players, count(*) filter (where abs(residual - expected_bonus) <= 2) within_2,
         percentile_cont(0.5) within group (order by residual - expected_bonus) median_gap,
         percentile_cont(0.95) within group (order by abs(residual - expected_bonus)) p95_abs_gap
  from trophy_reconciliation`);

console.log("\n3) Promotion rules: observed promotion share among the configured top slice, by tier");
console.table(await sql`
  select r.tier_id, count(*) players, t.promote_rate configured_rate,
         round(avg((outcome = 'promoted')::int) filter (where placement_pct <= t.promote_rate)::numeric, 3) promoted_in_top_slice,
         round(avg((outcome = 'promoted')::int) filter (where placement_pct > t.promote_rate)::numeric, 3) promoted_outside_slice,
         round(avg((outcome = 'demoted')::int) filter (where placement_pct > 1 - t.demote_rate)::numeric, 3) demoted_in_bottom_slice
  from player_season_result r join league_tier t using (tier_id)
  where outcome is not null and group_size is not null group by r.tier_id, t.promote_rate order by 1`);

console.log("\n4) Season ids look like Monday 05:00 UTC unix starts?");
console.table(await sql`select count(*) seasons, count(*) filter (where extract(isodow from starts_at at time zone 'UTC') = 1 and extract(hour from starts_at at time zone 'UTC') = 5) monday_0500_utc from season`);

console.log("\n5) Completeness: for players with a final log, do stored battles match the roster's win/loss counts?");
console.table(await sql`
  select count(*) players,
         count(*) filter (where coalesce(a.n, 0) = gm.attack_wins + gm.attack_losses) attacks_match,
         count(*) filter (where coalesce(d.n, 0) = gm.defense_wins + gm.defense_losses) defenses_match
  from group_member gm
  left join (select season_id, attacker_tag, count(*) n from battle group by 1, 2) a on a.season_id = gm.season_id and a.attacker_tag = gm.player_tag
  left join (select season_id, defender_tag, count(*) n from battle group by 1, 2) d on d.season_id = gm.season_id and d.defender_tag = gm.player_tag
  where gm.log_final`);

console.log("\n6) Coverage"); console.table(await sql`select * from coverage_by_season order by season_id desc limit 4`);
await sql.end();
