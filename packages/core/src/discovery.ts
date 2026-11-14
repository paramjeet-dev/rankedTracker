/**
 * Weekly upkeep that the daily seeds alone cannot do (groups reshuffle every season, and `history` otherwise runs once per player):
 *  - discoverCurrentSeason: profile a random sample of a past season's members so every new group is found via some member.
 *  - refreshPlayerSeasons: after a season ends, queue `history` for members that have no player_season row for it yet.
 * Both only enqueue jobs (no API calls here) and are safe to re-run: jobs dedupe, and every query skips work that is already done.
 */
import { SEASON_LEN, currentSeasonId } from "@coc/shared";
import { sql } from "./db.js";
import { enqueueMany } from "./queue.js";
import { envNum } from "./config.js";

/** Discovery jobs use priority 0 so their backlog can be counted cheaply and they run before everything else in the profile queue. */
export const DISCOVERY_PRIORITY = 0;

const getState = async (k: string) => (await sql`select value from system_state where key = ${k}`)[0]?.value;
const setState = (k: string, v: unknown) => sql`insert into system_state (key, value, updated_at) values (${k}, ${sql.json(v as any)}, now())
  on conflict (key) do update set value = excluded.value, updated_at = now()`;

export interface DiscoveryResult { action: "no_reference" | "done" | "max_batches" | "waiting" | "enqueued"; known?: number; knownPrev?: number; target?: number; enqueued?: number; batches?: number }

/**
 * Gap 1. A profile exposes only the player's CURRENT and PREVIOUS group, so a season's group tags can be found only until the second Monday after it
 * started (e.g. the Nov 2 season's tags are lost on Nov 16 05:00 UTC). Coverage is therefore tracked for both the current and the previous season.
 * Group membership is reshuffled each week, so old group tags say nothing about the new ones; the only way in is a player's profile.
 * Each tick (cheap) it compares the groups known for the current season with the biggest season seen so far and, while coverage is short,
 * enqueues one more batch of profile jobs for random members of the most complete past season who weren't profiled since this season began.
 * A batch is only added once the previous one has mostly drained. Sampling is random, so coverage grows like 1 - e^(-profiles/groups).
 */
export async function discoverCurrentSeason(now = Date.now()): Promise<DiscoveryResult> {
  const cur = currentSeasonId(now);
  const batchSize = envNum("DISCOVERY_BATCH", 25_000);
  const maxBatches = envNum("DISCOVERY_MAX_BATCHES", 10);
  const targetPct = envNum("DISCOVERY_TARGET_PCT", 99);

  const st = (await getState("discovery")) ?? { seasonId: 0, batches: 0 };
  if (st.seasonId !== cur) { st.seasonId = cur; st.batches = 0; }

  // reference: how many groups a full season has (largest seen) and which past season has the most complete rosters (sampling source)
  const past = await sql<{ season_id: string; groups: number; members: number }[]>`
    select season_id, count(*)::int as groups, coalesce(sum(members_total) filter (where roster_fetched_at is not null), 0)::int as members
    from league_group where season_id < ${cur} group by season_id`;
  if (past.length === 0) return { action: "no_reference" };
  const target = Math.max(...past.map((p) => p.groups));
  const source = past.reduce((a, b) => (b.members > a.members ? b : a));
  if (source.members === 0) return { action: "no_reference" };

  const [{ known }] = await sql<{ known: number }[]>`select count(*)::int as known from league_group where season_id = ${cur}`;
  const [{ knownPrev }] = await sql<{ knownPrev: number }[]>`select count(*)::int as "knownPrev" from league_group where season_id = ${cur - SEASON_LEN}`;
  const base = { known, knownPrev, target, batches: st.batches };
  const covered = (n: number) => n >= (target * targetPct) / 100;
  if (covered(known) && covered(knownPrev)) { await setState("discovery", st); return { action: "done", ...base }; }
  if (st.batches >= maxBatches) { await setState("discovery", st); return { action: "max_batches", ...base }; }

  const [{ backlog }] = await sql<{ backlog: number }[]>`select count(*)::int as backlog from job where status = 'queued' and priority = ${DISCOVERY_PRIORITY} and kind = 'profile'`;
  if (backlog > batchSize / 4) { await setState("discovery", st); return { action: "waiting", ...base }; }

  // random sample of the source season's members not yet profiled this season (random() < frac keeps the scan cheap on millions of rows)
  const frac = Math.min(1, (batchSize * 1.5) / source.members);
  const rows = await sql<{ player_tag: string }[]>`
    select gm.player_tag from group_member gm join player p on p.tag = gm.player_tag
    where gm.season_id = ${Number(source.season_id)} and random() < ${frac}
      and (p.last_profiled_at is null or p.last_profiled_at < to_timestamp(${cur}))
    limit ${batchSize}`;
  await enqueueMany(rows.map((r) => ({ kind: "profile", dedupeKey: r.player_tag, payload: { tag: r.player_tag }, priority: DISCOVERY_PRIORITY })));
  st.batches++;
  await setState("discovery", st);
  return { action: "enqueued", ...base, batches: st.batches, enqueued: rows.length };
}

/**
 * Gap 2. A returning player's newest season (tier, placement, final trophies, W/L) used to be fetched only through `history`, i.e. one API call per
 * player per week (~2M calls). The group rosters already hold final trophies and W/L counters, and the tier is the group's tier, so the row is
 * derived from them with no API call (source='derived'; placement = rank by trophies, ties by average attack stars). `history` is queued only for a
 * sample (HISTORY_SAMPLE_PCT, default 3) and its rows replace derived ones; saveHistory counts any disagreement in system_state 'derived_check'.
 * defense_stars and max_battles stay null on derived rows.
 */
export async function derivePlayerSeasons(seasonId: number): Promise<number> {
  const r = await sql`
    insert into player_season (player_tag, season_id, tier_id, trophies, placement, attack_wins, attack_losses, defense_wins, defense_losses, source)
    select gm.player_tag, gm.season_id, lg.tier_id, gm.trophies,
           row_number() over (partition by gm.group_tag order by gm.trophies desc, coalesce(st.avg_stars, 0) desc, gm.player_tag)::int,
           gm.attack_wins, gm.attack_losses, gm.defense_wins, gm.defense_losses, 'derived'
    from group_member gm
    join league_group lg on lg.season_id = gm.season_id and lg.group_tag = gm.group_tag
    left join (select attacker_tag, avg(stars) as avg_stars from battle where season_id = ${seasonId} group by 1) st on st.attacker_tag = gm.player_tag
    where gm.season_id = ${seasonId} and lg.tier_id is not null and lg.roster_fetched_at >= to_timestamp(${seasonId + SEASON_LEN}) -- roster taken after the season ended
    on conflict (season_id, player_tag) do update set tier_id = excluded.tier_id, trophies = excluded.trophies, placement = excluded.placement,
      attack_wins = excluded.attack_wins, attack_losses = excluded.attack_losses, defense_wins = excluded.defense_wins, defense_losses = excluded.defense_losses
      where player_season.source = 'derived'`; // never overwrite an api row; later passes refine derived rows as more logs (tie-break stars) arrive
  return r.count;
}

/** Passes at +1h, +24h, +72h and +6d after a season ends (rosters and logs arrive over days). */
export const HISTORY_PASSES_SEC = [3600, 24 * 3600, 72 * 3600, 6 * 24 * 3600];
export async function refreshPlayerSeasons(now = Date.now()): Promise<{ seasonId: number; pass: number; derived: number; enqueued: number } | null> {
  const ended = currentSeasonId(now) - SEASON_LEN;
  const elapsed = now / 1000 - (ended + SEASON_LEN);
  const st = (await getState("history_refresh")) ?? { seasonId: 0, pass: 0 };
  if (st.seasonId !== ended) { st.seasonId = ended; st.pass = 0; }
  let due = -1; HISTORY_PASSES_SEC.forEach((s, i) => { if (i >= st.pass && elapsed >= s) due = i; }); // catch up: only the latest due pass runs
  if (due < 0) { await setState("history_refresh", st); return null; }

  const derived = await derivePlayerSeasons(ended);
  const pct = envNum("HISTORY_SAMPLE_PCT", 3);
  let enqueued = 0, lastG = "", lastP = "";
  for (;;) { // keyset pages in primary-key order (season_id, group_tag, player_tag): index scan, no sort, no long-held connection
    const rows = await sql<{ group_tag: string; player_tag: string }[]>`
      select gm.group_tag, gm.player_tag from group_member gm
      where gm.season_id = ${ended} and (gm.group_tag, gm.player_tag) > (${lastG}, ${lastP})
        and abs(hashtext(gm.player_tag || ${String(ended)})) % 100 < ${pct}
        and not exists (select 1 from player_season ps where ps.season_id = gm.season_id and ps.player_tag = gm.player_tag and ps.source = 'api')
      order by gm.group_tag, gm.player_tag limit 20000`;
    if (rows.length === 0) break;
    await enqueueMany(rows.map((r) => ({ kind: "history", dedupeKey: r.player_tag, payload: { tag: r.player_tag }, priority: 3 })));
    enqueued += rows.length; ({ group_tag: lastG, player_tag: lastP } = rows[rows.length - 1]);
  }
  st.pass = due + 1;
  await setState("history_refresh", st);
  return { seasonId: ended, pass: due, derived, enqueued };
}
