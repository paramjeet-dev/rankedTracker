/** Read-only progress report per stored season.
 *   npm run seasons              per-season coverage, stored data, remaining queue and a time-left estimate
 *   npm run seasons -- --check   also compares stored battles with each member's roster counters (slower; an indicator, not proof)
 *  REPORT_RATE (default 100) = calls/s used for the runtime estimate. */
import { sql } from "@coc/core";
import { SEASON_LEN, SEASON_WINDOW_WEEKS, currentSeasonId, oldestServedSeasonId } from "@coc/shared";

const RATE = Number(process.env.REPORT_RATE ?? 100), cur = currentSeasonId(), floor = oldestServedSeasonId(), now = Date.now() / 1000;
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const by = async <T extends { sid: string }>(q: Promise<T[]>) => new Map((await q).map((r) => [r.sid, r]));
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);

const groups = await by(sql<any[]>`select season_id::text sid, count(*)::int groups, count(*) filter (where roster_fetched_at is not null)::int rostered, count(*) filter (where tier_id is null)::int tier_unknown from league_group group by 1`);
const members = await by(sql<any[]>`select season_id::text sid, count(*)::int members, count(*) filter (where log_fetched_at is not null)::int logs_any, count(*) filter (where log_final)::int logs_final from group_member group by 1`);
const battles = await by(sql<any[]>`select season_id::text sid, count(*)::int n from battle group by 1`);
const ps = await by(sql<any[]>`select season_id::text sid, count(*)::int n from player_season group by 1`);
const tl = await by(sql<any[]>`select season_id::text sid, count(distinct player_tag)::int n from trophy_timeline group by 1`);
const st = await by(sql<any[]>`select season_id::text sid, count(*)::int n from player_season_stats group by 1`);
const gs = await by(sql<any[]>`select season_id::text sid, count(*)::int n from group_stats group by 1`);
const queue = await sql<any[]>`select (payload->>'seasonId')::bigint::text sid, kind, status, count(*)::int n from job where kind in ('roster','memberlog') and payload ? 'seasonId' group by 1, 2, 3`;
const q = (sid: string, kind: string, status: string) => queue.find((r) => r.sid === sid && r.kind === kind && r.status === status)?.n ?? 0;

const sids = [...new Set([...groups.keys(), ...members.keys(), ...battles.keys(), ...queue.map((r) => r.sid)])].sort((a, b) => Number(b) - Number(a));
console.log(`\nNow ${new Date().toISOString().slice(0, 16)}Z | current season ${day(cur)} | API serves seasons >= ${day(floor)} (window ${SEASON_WINDOW_WEEKS} weeks back) | runtime estimates use ${RATE} calls/s`);

console.log("\n1) What is stored per season");
console.table(sids.map((sid) => { const s = Number(sid), g = groups.get(sid), m = members.get(sid);
  return { season: day(s), state: s === cur ? "current" : s > cur ? "future" : "ended", groups: g?.groups ?? 0, "% rostered": pct(g?.rostered ?? 0, g?.groups ?? 0), "tier unknown": g?.tier_unknown ?? 0,
    members: m?.members ?? 0, "% any log": pct(m?.logs_any ?? 0, m?.members ?? 0), "% final log": pct(m?.logs_final ?? 0, m?.members ?? 0), battles: battles.get(sid)?.n ?? 0,
    "player_season": ps.get(sid)?.n ?? 0, "timeline players": tl.get(sid)?.n ?? 0, "stats rows": st.get(sid)?.n ?? 0, "group_stats": gs.get(sid)?.n ?? 0 }; }));

console.log("2) Window and remaining work (roster + memberlog jobs still queued; runtime = calls / rate, wall-clock left = until the API stops serving that season)");
console.table(sids.map((sid) => { const s = Number(sid), exp = s + (SEASON_WINDOW_WEEKS + 1) * SEASON_LEN, left = (exp - now) / 3600;
  const roster = q(sid, "roster", "queued"), log = q(sid, "memberlog", "queued"), failed = q(sid, "roster", "failed") + q(sid, "memberlog", "failed");
  const needH = (roster + log) / RATE / 3600;
  return { season: day(s), "API serves until": new Date(exp * 1000).toISOString().slice(0, 16) + "Z", "wall-clock h left": left > 0 ? Math.round(left) : "EXPIRED", "roster queued": roster, "memberlog queued": log,
    "failed/parked": failed, "runtime h needed": Math.round(needH * 10) / 10, verdict: s < floor ? (roster + log + failed ? "unreachable: delete jobs" : "closed") : needH > Math.max(left, 0) ? "WILL NOT FINISH at this rate" : roster + log ? "ok" : "nothing queued" }; }));

console.log("3) Other queue content (no season in payload)");
console.table(await sql`select kind, status, priority, count(*)::int n from job where not (payload ? 'seasonId') group by 1, 2, 3 order by 1, 2, 3`);
console.log("4) Failed or parked jobs by cause");
console.table(await sql`select kind, left(last_error, 90) error, count(*)::int n from job where status = 'failed' group by 1, 2 order by 3 desc limit 10`);

if (process.argv.includes("--check")) {
  console.log("5) Completeness indicator: members with a FINAL log whose stored attacks/defenses equal their roster counters (rosters taken after season end only)");
  const rows = [];
  for (const sid of sids.filter((s) => Number(s) < cur && members.get(s)?.logs_final)) {
    const [r] = await sql<any[]>`
      with a as (select attacker_tag p, count(*)::int n from battle where season_id = ${sid} group by 1), d as (select defender_tag p, count(*)::int n from battle where season_id = ${sid} group by 1)
      select count(*)::int final_members, count(*) filter (where coalesce(a.n, 0) = gm.attack_wins + gm.attack_losses)::int atk_ok, count(*) filter (where coalesce(d.n, 0) = gm.defense_wins + gm.defense_losses)::int def_ok
      from group_member gm join league_group lg using (season_id, group_tag) left join a on a.p = gm.player_tag left join d on d.p = gm.player_tag
      where gm.season_id = ${sid} and gm.log_final and lg.roster_fetched_at >= to_timestamp(${Number(sid) + SEASON_LEN})`;
    rows.push({ season: day(Number(sid)), "final members checked": r.final_members, "% attacks match": pct(r.atk_ok, r.final_members), "% defenses match": pct(r.def_ok, r.final_members) });
  }
  console.table(rows);
}
await sql.end();
