import { sql } from "./db.js";

/** Rebuild every derived table for one season. Idempotent. Run only after the season's logs are in (the aggregator decides when). */
export async function rebuildSeason(s: number) {
  // 1. trophy timeline: complete only for players whose own log is final (attacks + defenses of that player)
  await sql`delete from trophy_timeline where season_id = ${s}`;
  await sql`
    insert into trophy_timeline (season_id, player_tag, seq, at, source, delta, trophies_after)
    select season_id, p, row_number() over (partition by p order by at, src), at, src, delta,
           (sum(delta) over (partition by p order by at, src rows between unbounded preceding and current row))::int
    from (
      select b.season_id, b.attacker_tag p, b.battle_time at, 'atk' src, b.attacker_gain::int delta
        from battle b join group_member gm on gm.season_id = b.season_id and gm.player_tag = b.attacker_tag and gm.log_final where b.season_id = ${s}
      union all
      select b.season_id, b.defender_tag, b.battle_time, 'def', b.defender_gain::int
        from battle b join group_member gm on gm.season_id = b.season_id and gm.player_tag = b.defender_tag and gm.log_final where b.season_id = ${s}
    ) e`;

  // 2. real attack stars (the API's attackStars is always 0)
  await sql`delete from player_season_stats where season_id = ${s}`;
  await sql`
    insert into player_season_stats (season_id, player_tag, tier_id, attacks, avg_stars, three_star_rate, hundred_rate, near_miss_rate, log_complete)
    select b.season_id, b.attacker_tag, lg.tier_id, count(*), avg(b.stars)::real, avg((b.stars = 3)::int)::real, avg((b.destruction = 100)::int)::real,
           avg((b.stars = 2 and b.destruction between 85 and 99)::int)::real, gm.log_final
    from battle b
    join group_member gm on gm.season_id = b.season_id and gm.player_tag = b.attacker_tag
    join league_group lg on lg.season_id = gm.season_id and lg.group_tag = gm.group_tag
    where b.season_id = ${s} group by b.season_id, b.attacker_tag, lg.tier_id, gm.log_final`;

  // 3. activity heatmap input (UTC hour of each attack)
  await sql`delete from player_hour_hist where season_id = ${s}`;
  await sql`
    insert into player_hour_hist (season_id, player_tag, hour, n)
    select season_id, attacker_tag, extract(hour from battle_time at time zone 'UTC')::smallint, count(*) from battle where season_id = ${s} group by 1, 2, 3`;

  // 4. group difficulty (prior-season strength when available: final trophies are partly an outcome of the group itself)
  await sql`delete from group_stats where season_id = ${s}`;
  await sql`
    insert into group_stats (season_id, group_tag, tier_id, n, avg_trophies, stddev, top10_share, avg_prior_trophies)
    select gm.season_id, gm.group_tag, lg.tier_id, count(*), avg(gm.trophies)::real, stddev_pop(gm.trophies)::real,
      ((select sum(t) from (select x.trophies t from group_member x where x.season_id = gm.season_id and x.group_tag = gm.group_tag order by x.trophies desc limit 10) q)::numeric / nullif(sum(gm.trophies), 0))::real,
      avg(prev.trophies)::real
    from group_member gm
    join league_group lg on lg.season_id = gm.season_id and lg.group_tag = gm.group_tag
    left join player_season prev on prev.player_tag = gm.player_tag and prev.season_id = gm.season_id - 604800 and prev.tier_id = lg.tier_id
    where gm.season_id = ${s} group by gm.season_id, gm.group_tag, lg.tier_id`;
  await sql`
    update group_stats g set
      basis = case when g.avg_prior_trophies is not null then 'prior' else 'final' end,
      difficulty_z = (coalesce(g.avg_prior_trophies, g.avg_trophies) - t.m) / nullif(t.sd, 0),
      group_of_death = ((coalesce(g.avg_prior_trophies, g.avg_trophies) - t.m) / nullif(t.sd, 0)) >= 2
    from (select tier_id, avg(coalesce(avg_prior_trophies, avg_trophies)) m, stddev_pop(coalesce(avg_prior_trophies, avg_trophies)) sd
          from group_stats where season_id = ${s} group by tier_id) t
    where g.season_id = ${s} and g.tier_id = t.tier_id`;
}

/** Refit the expected-stars lookup over all stored seasons, then score performance vs expected for one season. */
export async function refitExpectedStars() {
  await sql`delete from expected_stars_model`;
  await sql`
    insert into expected_stars_model (tier_id, diff_bucket, n, exp_stars, exp_three)
    with obs as (
      select lg.tier_id, floor((ga.trophies - gd.trophies) / 50.0)::int bkt, b.stars
      from battle b
      join group_member ga on ga.season_id = b.season_id and ga.player_tag = b.attacker_tag
      join group_member gd on gd.season_id = b.season_id and gd.player_tag = b.defender_tag and gd.group_tag = ga.group_tag
      join league_group lg on lg.season_id = ga.season_id and lg.group_tag = ga.group_tag where lg.tier_id is not null),
    tier as (select tier_id, avg(stars) m, avg((stars = 3)::int) m3 from obs group by 1)
    select o.tier_id, o.bkt, count(*), ((sum(o.stars) + 20 * t.m) / (count(*) + 20))::real, ((sum((o.stars = 3)::int) + 20 * t.m3) / (count(*) + 20))::real
    from obs o join tier t using (tier_id) group by o.tier_id, o.bkt, t.m, t.m3`;
}

export async function scoreSeason(s: number) {
  await sql`
    update player_season_stats ps set expected_stars = x.e::real, perf_vs_expected = (ps.avg_stars - x.e)::real
    from (select b.season_id, b.attacker_tag p, avg(m.exp_stars) e
          from battle b
          join group_member ga on ga.season_id = b.season_id and ga.player_tag = b.attacker_tag
          join group_member gd on gd.season_id = b.season_id and gd.player_tag = b.defender_tag and gd.group_tag = ga.group_tag
          join league_group lg on lg.season_id = ga.season_id and lg.group_tag = ga.group_tag
          join expected_stars_model m on m.tier_id = lg.tier_id and m.diff_bucket = floor((ga.trophies - gd.trophies) / 50.0)::int
          where b.season_id = ${s} group by 1, 2) x
    where ps.season_id = x.season_id and ps.player_tag = x.p`;
}
