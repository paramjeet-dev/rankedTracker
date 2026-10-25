import { db, tx, normTag, retryDeadlock } from './db.js';
import { client, getProfileRaw, getLeagueGroupForPlayer } from './coc.js';
import { enqueueMany, isRetryable } from './queue.js';

// ---------- configuration ----------
// LIVE_LOGS=true      also collect battle logs while a season is still running (default: rosters only, logs after the season ends)
// COLLECT=all         fetch every member of a group even when all battles are already covered (default: stop as soon as covered)
// DISCOVER_GROUPMATES=true  also queue a profile for every group-mate (default off: their clans are crawled instead)
const LIVE_LOGS = process.env.LIVE_LOGS === 'true';
const FETCH_ALL_MEMBERS = process.env.COLLECT === 'all';
const DISCOVER_GROUPMATES = process.env.DISCOVER_GROUPMATES === 'true';
const WEEK = 7 * 24 * 3600;

// ---------- scope (Titan..Electro; Legend and below are skipped) ----------
let scope = new Set<number>();
export async function loadScope() {
  const { rows } = await db.query('SELECT tier_id FROM league_tier WHERE in_scope');
  scope = new Set(rows.map(r => Number(r.tier_id)));
  if (!scope.size) throw new Error('league_tier has no in_scope rows. Run: npm run seed-tiers');
}
export const inScope = (tierId: number | undefined | null) => tierId != null && scope.has(Number(tierId));

// ---------- priorities (lower = sooner) ----------
export const PRIO = { appUser: 1, sweep: 10, groupFetch: 20, history: 40, clanMember: 50, clanSeed: 55, groupMateProfile: 60, clanHop: 70 };

export const stats = { battleRowsWritten: 0, groupCalls: 0 };

// ---------- helpers ----------
export const seasonEnded = (seasonId: string | number) => Date.now() >= (Number(seasonId) + WEEK) * 1000;

/** API timestamps look like 20261024T061234.000Z; accept ISO too. */
export function parseApiTime(s: string): string {
  if (s.includes('-')) return new Date(s).toISOString();
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/.exec(s);
  if (!m) throw new Error(`Unrecognised timestamp: ${s}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? '000'}Z`;
}

const byKey = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

async function ensureSeason(c: { query: typeof db.query }, seasonId: string | number) {
  const id = String(seasonId);
  if (!/^\d+$/.test(id)) throw new Error(`Bad season id ${id}`);
  await c.query(
    `INSERT INTO season (season_id, starts_at, ends_at)
     VALUES ($1, to_timestamp($2::bigint), to_timestamp($2::bigint) + interval '7 days')
     ON CONFLICT (season_id) DO NOTHING`, [id, id]);
}

/**
 * One battle partition per season. Created OUTSIDE any transaction (it needs a strong lock on the battle table,
 * which must never be held together with other locks) and remembered in memory.
 */
const partitions = new Set<string>();
async function ensurePartition(seasonId: string | number) {
  const id = String(seasonId);
  if (!/^\d+$/.test(id)) throw new Error(`Bad season id ${id}`);
  if (partitions.has(id)) return;
  try {
    await retryDeadlock(() => db.query(`CREATE TABLE IF NOT EXISTS battle_${id} PARTITION OF battle FOR VALUES IN ('${id}')`));
  } catch (e: any) {
    if (e?.code !== '42P07' && e?.code !== '23505') throw e; // another worker created it at the same moment
  }
  partitions.add(id);
}

async function groupKnown(groupTag: string, seasonId: string | number) {
  const { rowCount } = await db.query('SELECT 1 FROM league_group WHERE group_tag=$1 AND season_id=$2', [groupTag, String(seasonId)]);
  return !!rowCount;
}

async function upsertClans(c: { query: typeof db.query }, clans: Map<string, string>) {
  if (!clans.size) return;
  const rows = [...clans.entries()].sort(byKey); // fixed lock order
  await c.query(
    `INSERT INTO clan (clan_tag, name) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (clan_tag) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [rows.map(r => r[0]), rows.map(r => r[1])]);
}

async function upsertPlayers(c: { query: typeof db.query }, players: Map<string, string>) {
  if (!players.size) return;
  const rows = [...players.entries()].sort(byKey); // fixed lock order
  const tags = rows.map(r => r[0]), names = rows.map(r => r[1]);
  await c.query(
    `INSERT INTO player (player_tag, name) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (player_tag) DO UPDATE SET name = EXCLUDED.name, last_seen = now()`, [tags, names]);
  await c.query(
    `INSERT INTO player_name_history (player_tag, name) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT DO NOTHING`, [tags, names]);
}

/** Enqueue profile jobs for tags not profiled within the last N days. */
async function enqueueProfiles(tags: string[], priority: number, freshDays = 6) {
  if (!tags.length) return;
  const { rows } = await db.query(
    `SELECT t AS tag FROM unnest($1::text[]) t
     WHERE NOT EXISTS (SELECT 1 FROM player p WHERE p.player_tag = t AND p.profiled_at > now() - ($2 || ' days')::interval)`,
    [tags, String(freshDays)]);
  await enqueueMany('profile', rows.map(r => ({ playerTag: r.tag })), priority);
}

async function enqueueClanHops(clanTags: string[], priority: number, freshDays = 3) {
  if (!clanTags.length) return;
  const { rows } = await db.query(
    `SELECT t AS tag FROM unnest($1::text[]) t
     WHERE NOT EXISTS (SELECT 1 FROM clan c WHERE c.clan_tag = t AND c.members_crawled_at > now() - ($2 || ' days')::interval)`,
    [clanTags, String(freshDays)]);
  await enqueueMany('clan_members', rows.map(r => ({ clanTag: r.tag })), priority);
}

// ---------- job handlers ----------

/** profile: player row, current group (tier known from profile), history job for the previous group. */
export async function runProfile(p: { playerTag: string; full?: boolean }) {
  const tag = normTag(p.playerTag);
  const prof = await getProfileRaw(tag);
  const tierId = prof.leagueTier?.id ?? null;

  await tx(async c => {
    if (prof.clan) await upsertClans(c, new Map([[prof.clan.tag, prof.clan.name]]));
    await upsertPlayers(c, new Map([[tag, prof.name]]));
    await c.query('UPDATE player SET profiled_at = now(), tier_id = $2 WHERE player_tag = $1', [tag, tierId]);
  });

  if (prof.clan) await enqueueClanHops([prof.clan.tag], PRIO.clanHop);

  if (prof.currentLeagueGroupTag && prof.currentLeagueSeasonId && inScope(tierId)
      && (p.full || !(await groupKnown(prof.currentLeagueGroupTag, prof.currentLeagueSeasonId)))) {
    await enqueueMany('group_fetch', [{
      groupTag: prof.currentLeagueGroupTag, seasonId: String(prof.currentLeagueSeasonId), playerTag: tag, tierId: Number(tierId),
      ...(p.full ? { full: true } : {})   // app users: collect battle logs of the running season too
    }], p.full ? PRIO.appUser : PRIO.groupFetch);
  }

  // history gives the tier of the previous season, which the profile does not
  await enqueueMany('history_backfill', [{
    playerTag: tag,
    previousGroupTag: prof.previousLeagueGroupTag ?? null,
    previousSeasonId: prof.previousLeagueSeasonId ? String(prof.previousLeagueSeasonId) : null
  }], p.full ? PRIO.appUser : PRIO.history);
}

/** history_backfill: Layer A (all finished seasons) + previous group if its tier is in scope. */
export async function runHistory(p: { playerTag: string; previousGroupTag: string | null; previousSeasonId: string | null }) {
  const tag = normTag(p.playerTag);
  const { body } = await client.rest.getLeagueHistory(tag);
  const items = body.items ?? [];

  await tx(async c => {
    for (const it of items) {
      await ensureSeason(c, it.leagueSeasonId);
      await c.query(
        `INSERT INTO player_season_result
           (player_tag, season_id, tier_id, trophies, placement, attack_wins, attack_losses, defense_wins, defense_losses, defense_stars, max_battles)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (player_tag, season_id) DO UPDATE SET
           tier_id=EXCLUDED.tier_id, trophies=EXCLUDED.trophies, placement=EXCLUDED.placement,
           attack_wins=EXCLUDED.attack_wins, attack_losses=EXCLUDED.attack_losses,
           defense_wins=EXCLUDED.defense_wins, defense_losses=EXCLUDED.defense_losses,
           defense_stars=EXCLUDED.defense_stars, max_battles=EXCLUDED.max_battles`,
        [tag, String(it.leagueSeasonId), it.leagueTierId, it.leagueTrophies, it.placement, it.attackWins, it.attackLosses,
         it.defenseWins, it.defenseLosses, it.defenseStars, it.maxBattles]);
    }
  });

  if (p.previousGroupTag && p.previousSeasonId) {
    const prev = items.find(i => String(i.leagueSeasonId) === p.previousSeasonId);
    if (prev && inScope(prev.leagueTierId) && !(await groupKnown(p.previousGroupTag, p.previousSeasonId))) {
      await enqueueMany('group_fetch', [{
        groupTag: p.previousGroupTag, seasonId: p.previousSeasonId, playerTag: tag, tierId: Number(prev.leagueTierId)
      }], PRIO.groupFetch);
    }
  }
}

/** clan_members: only members whose current tier is in scope become profile jobs. */
export async function runClanMembers(p: { clanTag: string }) {
  const { body } = await client.rest.getClan(p.clanTag);
  await tx(async c => {
    await upsertClans(c, new Map([[body.tag, body.name]]));
    await c.query('UPDATE clan SET members_crawled_at = now() WHERE clan_tag = $1', [body.tag]);
  });
  const tags = (body.memberList ?? []).filter(m => inScope(m.leagueTier?.id)).map(m => m.tag);
  await enqueueProfiles(tags, PRIO.clanMember);
}

type GroupJob = { groupTag: string; seasonId: string; playerTag: string; tierId: number; full?: boolean };

/**
 * Stores one API response: roster, clans, players, and the battles of the player the call was made for.
 * One call returns the whole roster but the attack/defense logs of that ONE player. Every battle is in two logs
 * (the attacker's and the defender's), so the primary key merges them.
 */
async function storeGroupResponse(p: GroupJob, player: string, res: Awaited<ReturnType<typeof getLeagueGroupForPlayer>>) {
  const members = [...(res.members ?? [])].sort((a, b) => (a.playerTag < b.playerTag ? -1 : a.playerTag > b.playerTag ? 1 : 0));
  const expected = members.reduce((n, m) => n + m.attackWinCount + m.attackLoseCount, 0);

  const clans = new Map<string, string>();
  const players = new Map<string, string>();
  for (const m of members) {
    if (m.clanTag) clans.set(m.clanTag, m.clanName);
    players.set(m.playerTag, m.playerName);
  }

  // attack log = this player attacked (attacker side value); defense log = this player was attacked (defender side value)
  const B = { att: [] as string[], def: [] as string[], time: [] as string[], stars: [] as number[], dest: [] as number[],
              atro: [] as (number | null)[], dtro: [] as (number | null)[] };
  for (const a of res.attackLogs ?? []) {
    B.att.push(player); B.def.push(a.opponentPlayerTag); B.time.push(parseApiTime(a.creationTime));
    B.stars.push(a.stars); B.dest.push(a.destructionPercentage); B.atro.push(a.trophies); B.dtro.push(null);
  }
  for (const d of res.defenseLogs ?? []) {
    B.att.push(d.opponentPlayerTag); B.def.push(player); B.time.push(parseApiTime(d.creationTime));
    B.stars.push(d.stars); B.dest.push(d.destructionPercentage); B.atro.push(null); B.dtro.push(d.trophies);
  }
  // sort by primary key so concurrent inserts always take locks in the same order
  const order = B.att.map((_, i) => i).sort((i, j) =>
    B.att[i] < B.att[j] ? -1 : B.att[i] > B.att[j] ? 1 : B.def[i] < B.def[j] ? -1 : B.def[i] > B.def[j] ? 1 : B.time[i] < B.time[j] ? -1 : B.time[i] > B.time[j] ? 1 : 0);
  for (const k of Object.keys(B) as (keyof typeof B)[]) (B as any)[k] = order.map(i => (B as any)[k][i]);

  await ensurePartition(p.seasonId);
  await tx(async c => {
    await ensureSeason(c, p.seasonId);
    await c.query(
      `INSERT INTO league_group (group_tag, season_id, tier_id, expected_battles, fetched_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (group_tag, season_id) DO UPDATE SET tier_id=EXCLUDED.tier_id, expected_battles=EXCLUDED.expected_battles, fetched_at=now()`,
      [p.groupTag, p.seasonId, p.tierId, expected]);
    await upsertClans(c, clans);
    await upsertPlayers(c, players);
    await c.query(
      `INSERT INTO group_member (group_tag, season_id, player_tag, clan_tag, trophies, attack_wins, attack_losses, defense_wins, defense_losses)
       SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[])
       ON CONFLICT (group_tag, season_id, player_tag) DO UPDATE SET
         clan_tag=EXCLUDED.clan_tag, trophies=EXCLUDED.trophies, attack_wins=EXCLUDED.attack_wins,
         attack_losses=EXCLUDED.attack_losses, defense_wins=EXCLUDED.defense_wins, defense_losses=EXCLUDED.defense_losses`,
      [p.groupTag, p.seasonId,
       members.map(m => m.playerTag), members.map(m => m.clanTag || null), members.map(m => m.leagueTrophies),
       members.map(m => m.attackWinCount), members.map(m => m.attackLoseCount),
       members.map(m => m.defenseWinCount), members.map(m => m.defenseLoseCount)]);

    if (B.att.length) {
      // first sight inserts the row, the second sight (other side's log) fills in that side's trophy value
      const ins = await c.query(
        `INSERT INTO battle (season_id, attacker_tag, defender_tag, battle_time, group_tag, stars, destruction, attacker_trophies, defender_trophies)
         SELECT $1, a, d, t::timestamptz, $2, s, x, ar, dr
         FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[]) AS u(a,d,t,s,x,ar,dr)
         ON CONFLICT (season_id, attacker_tag, defender_tag, battle_time) DO UPDATE SET
           attacker_trophies = COALESCE(battle.attacker_trophies, EXCLUDED.attacker_trophies),
           defender_trophies = COALESCE(battle.defender_trophies, EXCLUDED.defender_trophies)`,
        [p.seasonId, p.groupTag, B.att, B.def, B.time, B.stars, B.dest, B.atro, B.dtro]);
      stats.battleRowsWritten += ins.rowCount ?? 0;
    }

    await c.query(
      `UPDATE group_member SET attacks_logged=$4, defenses_logged=$5, logs_fetched_at=now()
       WHERE group_tag=$1 AND season_id=$2 AND player_tag=$3`,
      [p.groupTag, p.seasonId, player, (res.attackLogs ?? []).length, (res.defenseLogs ?? []).length]);
    await c.query(
      `UPDATE league_group SET stored_battles = (SELECT count(*) FROM battle WHERE season_id=$2 AND group_tag=$1)
       WHERE group_tag=$1 AND season_id=$2`, [p.groupTag, p.seasonId]);
  });
}

async function groupCovered(groupTag: string, seasonId: string) {
  const { rows } = await db.query(
    'SELECT stored_battles >= expected_battles AS ok FROM league_group WHERE group_tag=$1 AND season_id=$2', [groupTag, seasonId]);
  return !!rows[0]?.ok;
}

/** The unvisited member with the most battles whose logs are missing or older than the season end / this run's start. */
async function nextMember(groupTag: string, seasonId: string, visited: Set<string>, t0: Date): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT gm.player_tag
     FROM group_member gm JOIN season s ON s.season_id = gm.season_id
     WHERE gm.group_tag = $1 AND gm.season_id = $2
       AND gm.attack_wins + gm.attack_losses + gm.defense_wins + gm.defense_losses > 0
       AND NOT (gm.player_tag = ANY($3::text[]))
       AND (gm.logs_fetched_at IS NULL OR gm.logs_fetched_at < LEAST(s.ends_at, $4::timestamptz))
     ORDER BY gm.attack_wins + gm.attack_losses + gm.defense_wins + gm.defense_losses DESC, gm.player_tag
     LIMIT 1`, [groupTag, seasonId, [...visited], t0.toISOString()]);
  return rows[0]?.player_tag ?? null;
}

/**
 * group_fetch (one job per group):
 *  - season still running: store the roster only (1 call). Battle logs are collected after the season ends,
 *    because logs fetched mid-week would have to be fetched again anyway. Exceptions: app users (full) or LIVE_LOGS=true.
 *  - season ended: fetch members one at a time, most active first, and STOP as soon as the stored battles reach the
 *    roster's expected total. Every battle is in two logs, so this usually needs well under half the members' logs.
 */
export async function runGroupFetch(p: GroupJob) {
  if (!inScope(p.tierId)) return; // Legend (and anything outside Titan..Electro): skip the whole group
  const ended = seasonEnded(p.seasonId);
  if (ended && await groupAlreadyComplete(p.groupTag, p.seasonId)) return;
  const collect = ended || !!p.full || LIVE_LOGS;
  const t0 = new Date();
  const visited = new Set<string>();

  let player: string | null = p.playerTag;
  while (player) {
    visited.add(player);
    let res;
    try {
      res = await getLeagueGroupForPlayer(p.groupTag, p.seasonId, player);
    } catch (e: any) {
      if (player !== p.playerTag && !isRetryable(e)) { player = await nextMember(p.groupTag, p.seasonId, visited, t0); continue; } // skip this member
      throw e;
    }
    stats.groupCalls++;
    await storeGroupResponse(p, player, res);
    if (!collect) break;
    if (!FETCH_ALL_MEMBERS && await groupCovered(p.groupTag, p.seasonId)) break;
    player = await nextMember(p.groupTag, p.seasonId, visited, t0);
  }

  // group-mates: their clans are crawled (cheap); their own profiles only if asked for
  const { rows } = await db.query(
    `SELECT DISTINCT clan_tag, player_tag FROM group_member WHERE group_tag=$1 AND season_id=$2`, [p.groupTag, p.seasonId]);
  await enqueueClanHops([...new Set(rows.map(r => r.clan_tag).filter(Boolean))], PRIO.clanHop);
  if (DISCOVER_GROUPMATES) await enqueueProfiles(rows.map(r => r.player_tag), PRIO.groupMateProfile);
}

async function groupAlreadyComplete(groupTag: string, seasonId: string) {
  const { rows } = await db.query(`SELECT status FROM league_group WHERE group_tag=$1 AND season_id=$2`, [groupTag, seasonId]);
  return rows[0]?.status === 'complete';
}

/** After a group_fetch job is terminal, settle the group's status once no fetches for it remain queued. */
export async function finalizeGroup(groupTag: string, seasonId: string) {
  await db.query(
    `UPDATE league_group g SET status = CASE
         WHEN s.ends_at > now() THEN 'pending'
         WHEN g.stored_battles >= g.expected_battles THEN 'complete'
         ELSE 'incomplete' END
     FROM season s
     WHERE s.season_id = g.season_id AND g.group_tag = $1 AND g.season_id = $2
       AND NOT EXISTS (SELECT 1 FROM job j WHERE j.kind='group_fetch' AND j.status IN ('queued','running')
                       AND j.payload->>'groupTag' = $1 AND j.payload->>'seasonId' = $2)`,
    [groupTag, seasonId]);
}
