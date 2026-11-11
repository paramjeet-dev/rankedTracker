import { SEASON_LEN, currentSeasonId, inScope, oldestServedSeasonId } from "@coc/shared";
import { sql } from "./db.js";
import { enqueueMany, type NewJob } from "./queue.js";
import { cfg, envNum } from "./config.js";
import type { Group, HistoryRow, Profile } from "./parse.js";

const seen = new Set<number>();
export async function ensureSeason(id: number) {
  if (seen.has(id)) return;
  await sql`select ensure_season(${id}::bigint)`;
  seen.add(id);
}
export const seasonEnded = (seasonId: number, now = Date.now()) => seasonId + SEASON_LEN <= now / 1000;

export async function saveProfile(p: Profile) {
  await sql`insert into player (tag, name, last_profiled_at, cur_group_tag, cur_season_id, prev_group_tag, prev_season_id)
    values (${p.tag}, ${p.name}, now(), ${p.current?.groupTag ?? null}, ${p.current?.seasonId ?? null}, ${p.previous?.groupTag ?? null}, ${p.previous?.seasonId ?? null})
    on conflict (tag) do update set name = excluded.name, last_profiled_at = now(), cur_group_tag = excluded.cur_group_tag,
      cur_season_id = excluded.cur_season_id, prev_group_tag = excluded.prev_group_tag, prev_season_id = excluded.prev_season_id`;
  await sql`insert into player_snapshot (player_tag, name, clan_tag, town_hall, trophies)
    select ${p.tag}, ${p.name}, ${p.clanTag}, ${p.townHall}, ${p.trophies}
    where not exists (select 1 from player_snapshot s where s.player_tag = ${p.tag} and s.at > now() - interval '6 days')`;
}

/** Register a group (idempotent) and queue its roster job if the roster was never fetched. */
export async function discoverGroup(seasonId: number, groupTag: string, probeTag: string, tierId: number | null, priority: number) {
  if (tierId === null || !inScope(tierId)) return; // never register groups outside the tracked tiers
  await ensureSeason(seasonId);
  await sql`insert into league_group (season_id, group_tag, tier_id, probe_player_tag) values (${seasonId}, ${groupTag}, ${tierId}, ${probeTag})
            on conflict (season_id, group_tag) do update set tier_id = coalesce(league_group.tier_id, excluded.tier_id)`;
  const [g] = await sql`select roster_fetched_at from league_group where season_id = ${seasonId} and group_tag = ${groupTag}`;
  if (!g.roster_fetched_at && seasonId >= oldestServedSeasonId()) await enqueueMany([{ kind: "roster", dedupeKey: `${seasonId}:${groupTag}`, payload: { seasonId, groupTag, probeTag }, priority }]);
}

export async function saveHistory(tag: string, rows: HistoryRow[]) {
  for (const r of rows) await ensureSeason(r.seasonId);
  if (rows.length) await sql`
    insert into player_season (player_tag, season_id, tier_id, trophies, placement, attack_wins, attack_losses, defense_wins, defense_losses, defense_stars, max_battles)
    select ${tag}, t.season_id, t.tier_id, t.trophies, t.placement, t.aw, t.al, t.dw, t.dl, t.ds, t.mb
    from jsonb_to_recordset(${sql.json(rows.map((r) => ({ season_id: r.seasonId, tier_id: r.tierId, trophies: r.trophies, placement: r.placement, aw: r.attackWins, al: r.attackLosses, dw: r.defenseWins, dl: r.defenseLosses, ds: r.defenseStars, mb: r.maxBattles })) as any)}::jsonb)
      as t(season_id bigint, tier_id int, trophies int, placement int, aw int, al int, dw int, dl int, ds int, mb int)
    on conflict (season_id, player_tag) do update set tier_id = excluded.tier_id, trophies = excluded.trophies, placement = excluded.placement,
      attack_wins = excluded.attack_wins, attack_losses = excluded.attack_losses, defense_wins = excluded.defense_wins, defense_losses = excluded.defense_losses,
      defense_stars = excluded.defense_stars, max_battles = excluded.max_battles`;
  await sql`update player set last_history_at = now() where tag = ${tag}`;
}

/** Store a group response: roster (layer B), battles (layer C) from the probe's logs, new players -> follow-up jobs. */
export async function saveGroup(g: Group, seasonId: number, groupTag: string, probeTag: string, opts: { roster?: boolean } = {}) {
  const roster = opts.roster ?? true; // memberlog passes false: roster rows already exist, don't rewrite 100 rows per member log
  await ensureSeason(seasonId);
  if (roster) {
  const fresh = await sql<{ tag: string; inserted: boolean }[]>`
    insert into player (tag, name) select t.tag, t.name from jsonb_to_recordset(${sql.json(g.members.map((m) => ({ tag: m.playerTag, name: m.playerName })) as any)}::jsonb) as t(tag text, name text)
    order by t.tag
    on conflict (tag) do update set name = excluded.name returning tag, (xmax = 0) as inserted`;
  const added = fresh.filter((f) => f.inserted);
  const perGroup = envNum("PROFILES_PER_GROUP", 8); // history for everyone (layer A); profiles only for a sample: they just reveal 2 group refs each
  await enqueueMany(added.flatMap<NewJob>((f, i) => [
    { kind: "history", dedupeKey: f.tag, payload: { tag: f.tag }, priority: 7 },
    ...(i < perGroup ? [{ kind: "profile", dedupeKey: f.tag, payload: { tag: f.tag }, priority: 8 }] : [])]));

  await sql`insert into group_member (season_id, group_tag, player_tag, player_name, clan_tag, clan_name, trophies, attack_wins, attack_losses, defense_wins, defense_losses)
    select ${seasonId}, ${groupTag}, t.tag, t.name, t.clan_tag, t.clan_name, t.trophies, t.aw, t.al, t.dw, t.dl
    from jsonb_to_recordset(${sql.json(g.members.map((m) => ({ tag: m.playerTag, name: m.playerName, clan_tag: m.clanTag, clan_name: m.clanName, trophies: m.trophies, aw: m.atkWin, al: m.atkLoss, dw: m.defWin, dl: m.defLoss })) as any)}::jsonb)
      as t(tag text, name text, clan_tag text, clan_name text, trophies int, aw int, al int, dw int, dl int)
    order by t.tag
    on conflict (season_id, group_tag, player_tag) do update set player_name = excluded.player_name, clan_tag = excluded.clan_tag, clan_name = excluded.clan_name,
      trophies = excluded.trophies, attack_wins = excluded.attack_wins, attack_losses = excluded.attack_losses, defense_wins = excluded.defense_wins,
      defense_losses = excluded.defense_losses, roster_fetched_at = now()`;

  }

  if (g.battles.length) await sql`
    insert into battle (season_id, group_tag, attacker_tag, defender_tag, battle_time, stars, destruction, attacker_gain, defender_gain, atk_log_reported, def_log_reported)
    select ${seasonId}::bigint, ${groupTag}, t.a, t.d, t.ts, t.stars, t.dest, t.ag, t.dg, t.ar, t.dr
    from jsonb_to_recordset(${sql.json(g.battles.map((b) => ({ a: b.attacker, d: b.defender, ts: b.time, stars: b.stars, dest: b.destruction, ag: b.attackerGain, dg: b.defenderGain, ar: b.atkRep, dr: b.defRep })) as any)}::jsonb)
      as t(a text, d text, ts timestamptz, stars smallint, dest smallint, ag smallint, dg smallint, ar smallint, dr smallint)
    order by t.a, t.d, t.ts
    on conflict (season_id, attacker_tag, defender_tag, battle_time) do update set
      atk_log_reported = coalesce(battle.atk_log_reported, excluded.atk_log_reported),
      def_log_reported = coalesce(battle.def_log_reported, excluded.def_log_reported)`;

  const final = seasonEnded(seasonId);
  await sql`update group_member set log_fetched_at = now(), log_final = ${final} where season_id = ${seasonId} and group_tag = ${groupTag} and player_tag = ${probeTag}`;
  if (!roster) return; // coverage_by_season counts final logs from group_member, no per-call group row update (avoids lock contention)
  await sql`update league_group set members_total = ${g.members.length}, roster_fetched_at = now(),
            logs_fetched = (select count(*) from group_member where season_id = ${seasonId} and group_tag = ${groupTag} and log_fetched_at is not null)
            where season_id = ${seasonId} and group_tag = ${groupTag}`;
}

/** After a season ended: queue member-log jobs by value (top 5 for the race chart, promotion/demotion bubble, then the rest by trophies). */
export async function queueMemberLogs(seasonId: number, groupTag: string) {
  if (!seasonEnded(seasonId) || seasonId < oldestServedSeasonId()) return 0;
  const [g] = await sql<{ tier_id: number | null; members_total: number }[]>`select tier_id, members_total from league_group where season_id = ${seasonId} and group_tag = ${groupTag}`;
  const [t] = g?.tier_id ? await sql<{ promote_rate: number; demote_rate: number }[]>`select promote_rate, demote_rate from league_tier where tier_id = ${g.tier_id}` : [];
  const rows = await sql<{ player_tag: string; log_final: boolean }[]>`select player_tag, log_final from group_member where season_id = ${seasonId} and group_tag = ${groupTag} order by trophies desc, player_tag`;
  const n = rows.length; const keep = Math.ceil(cfg.memberlogDepth * n);
  const promoteN = t ? Math.ceil(t.promote_rate * n) : 0, demoteN = t ? Math.ceil(t.demote_rate * n) : 0;
  const jobs: NewJob[] = [];
  rows.forEach((r, i) => {
    if (r.log_final) return;
    const bubble = t && (Math.abs(i + 1 - promoteN) <= 3 || Math.abs(i + 1 - (n - demoteN)) <= 3);
    const priority = i < 5 ? 1 : bubble ? 2 : 3;
    if (i < keep || priority < 3) jobs.push({ kind: "memberlog", dedupeKey: `${seasonId}:${groupTag}:${r.player_tag}`, payload: { seasonId, groupTag, playerTag: r.player_tag }, priority });
  });
  await enqueueMany(jobs);
  return jobs.length;
}
export { currentSeasonId };
