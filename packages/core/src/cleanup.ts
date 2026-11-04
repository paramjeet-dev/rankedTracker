import { sql } from "./db.js";
import { TIER_MIN, TIER_MAX } from "@coc/shared";

const OOS = `lg.tier_id is not null and (lg.tier_id < ${TIER_MIN} or lg.tier_id > ${TIER_MAX})`;

/**
 * One-time repair for the scope leak: resolve unknown group tiers from the probe's own history row, then find/remove work and data
 * that belongs to groups outside tiers 26..33. dry-run by default.
 */
export async function cleanupOutOfScope(opts: { apply: boolean; purgeData: boolean }) {
  const resolved = await sql`update league_group g set tier_id = ps.tier_id from player_season ps
    where g.tier_id is null and ps.player_tag = g.probe_player_tag and ps.season_id = g.season_id returning 1`;
  const dist = await sql`select coalesce(tier_id::text, 'unknown') tier, count(*)::int groups from league_group group by 1 order by 1`;
  const oosGroups = await sql`select count(*)::int n from league_group lg where ${sql.unsafe(OOS)}`;
  const jobsGroup = await sql`select kind, count(*)::int n from job j where j.status = 'queued' and j.kind in ('roster','memberlog') and exists (
      select 1 from league_group lg where lg.season_id = (j.payload->>'seasonId')::bigint and lg.group_tag = j.payload->>'groupTag' and ${sql.unsafe(OOS)}) group by 1`;
  const oosPlayers = sql`select gm.player_tag from group_member gm join league_group lg using (season_id, group_tag)
      group by gm.player_tag having bool_and(${sql.unsafe(OOS)})`;
  const jobsPlayer = await sql`select kind, count(*)::int n from job where status = 'queued' and kind in ('profile','history') and payload->>'tag' in (${oosPlayers}) group by 1`;
  const report = { tiersResolved: resolved.length, groupsByTier: dist, outOfScopeGroups: oosGroups[0].n, queuedGroupJobsToDelete: jobsGroup, queuedPlayerJobsToDelete: jobsPlayer };
  if (!opts.apply) return report;

  await sql`delete from job j where j.status = 'queued' and j.kind in ('roster','memberlog') and exists (
      select 1 from league_group lg where lg.season_id = (j.payload->>'seasonId')::bigint and lg.group_tag = j.payload->>'groupTag' and ${sql.unsafe(OOS)})`;
  await sql`delete from job where status = 'queued' and kind in ('profile','history') and payload->>'tag' in (${oosPlayers})`;
  if (opts.purgeData) {
    await sql`delete from battle b using league_group lg where b.season_id = lg.season_id and b.group_tag = lg.group_tag and ${sql.unsafe(OOS)}`;
    await sql`delete from group_member gm using league_group lg where gm.season_id = lg.season_id and gm.group_tag = lg.group_tag and ${sql.unsafe(OOS)}`;
    await sql`delete from league_group lg where ${sql.unsafe(OOS)}`;
  }
  return { ...report, applied: true, purgedData: opts.purgeData };
}

/** Keep at most `perGroup` queued roster-discovered profile jobs (priority >= 8) per group; seeds and manual adds (priority < 8) are never touched. */
export async function trimProfileQueue(perGroup: number, apply: boolean) {
  const keep = sql`select id from (select j.id, row_number() over (partition by gm.season_id, gm.group_tag order by md5(j.id::text)) rn
      from job j join group_member gm on gm.player_tag = j.payload->>'tag' where j.kind = 'profile' and j.status = 'queued' and j.priority >= 8) x where rn <= ${perGroup}`;
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from job where kind = 'profile' and status = 'queued' and priority >= 8 and id not in (${keep})`;
  if (apply) await sql`delete from job where kind = 'profile' and status = 'queued' and priority >= 8 and id not in (${keep})`;
  return { profileJobsToDelete: n, applied: apply };
}
