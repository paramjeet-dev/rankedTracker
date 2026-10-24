import { db, tx, normTag } from './db.js';
import { client, getProfileRaw, getLeagueGroupForPlayer } from './coc.js';
import { enqueueMany } from './queue.js';

// ---------- scope (Titan..Electro; Legend and below are skipped) ----------
let scope = new Set<number>();
export async function loadScope() {
  const { rows } = await db.query('SELECT tier_id FROM league_tier WHERE in_scope');
  scope = new Set(rows.map(r => Number(r.tier_id)));
  if (!scope.size) throw new Error('league_tier has no in_scope rows. Run: npm run seed-tiers');
}
export const inScope = (tierId: number | undefined | null) => tierId != null && scope.has(Number(tierId));

// ---------- priorities (lower = sooner) ----------
export const PRIO = { appUser: 1, sweep: 10, groupFetch: 20, clanSeed: 55, history: 40, clanMember: 50, groupMateProfile: 60, clanHop: 70 };

export const stats = { trophyMismatch: 0, battlesInserted: 0 };

// ---------- helpers ----------
/** API timestamps look like 20261024T061234.000Z; accept ISO too. */
export function parseApiTime(s: string): string {
  if (s.includes('-')) return new Date(s).toISOString();
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/.exec(s);
  if (!m) throw new Error(`Unrecognised timestamp: ${s}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? '000'}Z`;
}

async function ensureSeason(c: { query: typeof db.query }, seasonId: string | number) {
  const id = String(seasonId);
  if (!/^\d+$/.test(id)) throw new Error(`Bad season id ${id}`);
  await c.query(
    `INSERT INTO season (season_id, starts_at, ends_at)
     VALUES ($1, to_timestamp($2::bigint), to_timestamp($2::bigint) + interval '7 days')
     ON CONFLICT (season_id) DO NOTHING`, [id, id]);
  // one battle partition per season
  await c.query(`CREATE TABLE IF NOT EXISTS battle_${id} PARTITION OF battle FOR VALUES IN ('${id}')`);
}

async function groupKnown(groupTag: string, seasonId: string | number) {
  const { rowCount } = await db.query('SELECT 1 FROM league_group WHERE group_tag=$1 AND season_id=$2', [groupTag, String(seasonId)]);
  return !!rowCount;
}

async function upsertClans(c: { query: typeof db.query }, clans: Map<string, string>) {
  if (!clans.size) return;
  await c.query(
    `INSERT INTO clan (clan_tag, name) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (clan_tag) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [[...clans.keys()], [...clans.values()]]);
}

async function upsertPlayers(c: { query: typeof db.query }, players: Map<string, string>) {
  if (!players.size) return;
  const tags = [...players.keys()], names = [...players.values()];
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
export async function runProfile(p: { playerTag: string }) {
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
      && !(await groupKnown(prof.currentLeagueGroupTag, prof.currentLeagueSeasonId))) {
    await enqueueMany('group_fetch', [{
      groupTag: prof.currentLeagueGroupTag, seasonId: String(prof.currentLeagueSeasonId), playerTag: tag, tierId: Number(tierId)
    }], PRIO.groupFetch);
  }

  // history gives the tier of the previous season, which the profile does not
  await enqueueMany('history_backfill', [{
    playerTag: tag,
    previousGroupTag: prof.previousLeagueGroupTag ?? null,
    previousSeasonId: prof.previousLeagueSeasonId ? String(prof.previousLeagueSeasonId) : null
  }], PRIO.history);
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

/**
 * group_fetch: one call returns the whole roster plus the attack/defense logs of the REQUESTING player only.
 * So we store the roster, store that player's battles, then queue the other members to collect their logs.
 * Every battle appears in two logs (attacker's and defender's); the PK dedupes them.
 */
export async function runGroupFetch(p: { groupTag: string; seasonId: string; playerTag: string; tierId: number }) {
  if (!inScope(p.tierId)) return; // Legend (and anything outside Titan..Electro): skip the whole group
  const res = await getLeagueGroupForPlayer(p.groupTag, p.seasonId, p.playerTag);
  const members = res.members ?? [];
  const expected = members.reduce((n, m) => n + m.attackWinCount + m.attackLoseCount, 0);

  const clans = new Map<string, string>();
  const players = new Map<string, string>();
  for (const m of members) {
    if (m.clanTag) clans.set(m.clanTag, m.clanName);
    players.set(m.playerTag, m.playerName);
  }

  // build battle rows: attack log = this player attacked; defense log = this player was attacked
  const B = { att: [] as string[], def: [] as string[], time: [] as string[], stars: [] as number[], dest: [] as number[], tro: [] as number[] };
  for (const a of res.attackLogs ?? []) {
    B.att.push(p.playerTag); B.def.push(a.opponentPlayerTag); B.time.push(parseApiTime(a.creationTime));
    B.stars.push(a.stars); B.dest.push(a.destructionPercentage); B.tro.push(a.trophies);
  }
  for (const d of res.defenseLogs ?? []) {
    B.att.push(d.opponentPlayerTag); B.def.push(p.playerTag); B.time.push(parseApiTime(d.creationTime));
    B.stars.push(d.stars); B.dest.push(d.destructionPercentage);
    B.tro.push(40 - d.trophies); // stored value is the attacker's gain; defender's logged change = 40 - gain
  }

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
      const ins = await c.query(
        `INSERT INTO battle (season_id, attacker_tag, defender_tag, battle_time, group_tag, stars, destruction, trophies)
         SELECT $1, a, d, t::timestamptz, $2, s, x, r
         FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[]) AS u(a,d,t,s,x,r)
         ON CONFLICT (season_id, attacker_tag, defender_tag, battle_time) DO NOTHING
         RETURNING attacker_tag, defender_tag, battle_time`,
        [p.seasonId, p.groupTag, B.att, B.def, B.time, B.stars, B.dest, B.tro]);
      stats.battlesInserted += ins.rowCount ?? 0;

      // Battles already stored from the opponent's side: cross-check the trophy value (validates the 40-x assumption)
      if ((ins.rowCount ?? 0) < B.att.length) {
        const cmp = await c.query(
          `SELECT count(*)::int AS bad FROM unnest($2::text[], $3::text[], $4::text[], $5::int[]) AS u(a,d,t,r)
           JOIN battle b ON b.season_id=$1 AND b.attacker_tag=u.a AND b.defender_tag=u.d AND b.battle_time=u.t::timestamptz
           WHERE b.trophies <> u.r`,
          [p.seasonId, B.att, B.def, B.time, B.tro]);
        const bad = cmp.rows[0].bad as number;
        if (bad) { stats.trophyMismatch += bad; console.warn(`! ${bad} trophy mismatches in ${p.groupTag}/${p.seasonId} (check the 40-x assumption)`); }
      }
    }

    await c.query(
      `UPDATE group_member SET attacks_logged=$4, defenses_logged=$5, logs_fetched_at=now()
       WHERE group_tag=$1 AND season_id=$2 AND player_tag=$3`,
      [p.groupTag, p.seasonId, p.playerTag, (res.attackLogs ?? []).length, (res.defenseLogs ?? []).length]);
    await c.query(
      `UPDATE league_group SET stored_battles = (SELECT count(*) FROM battle WHERE season_id=$2 AND group_tag=$1)
       WHERE group_tag=$1 AND season_id=$2`, [p.groupTag, p.seasonId]);
  });

  // queue the other members that actually battled and have no logs yet
  const { rows: todo } = await db.query(
    `SELECT player_tag FROM group_member
     WHERE group_tag=$1 AND season_id=$2 AND logs_fetched_at IS NULL
       AND attack_wins + attack_losses + defense_wins + defense_losses > 0`, [p.groupTag, p.seasonId]);
  await enqueueMany('group_fetch', todo.map(r => ({ groupTag: p.groupTag, seasonId: p.seasonId, playerTag: r.player_tag, tierId: p.tierId })), PRIO.groupFetch);

  // discovery: group-mates' own profiles (their other group) and their clans
  if ((process.env.DISCOVER_FROM_GROUPS ?? 'true') === 'true') {
    await enqueueProfiles(members.map(m => m.playerTag), PRIO.groupMateProfile);
    await enqueueClanHops([...clans.keys()], PRIO.clanHop);
  }
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
