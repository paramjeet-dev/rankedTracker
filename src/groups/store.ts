import type { APILeagueGroupList } from 'clashofclans.js';
import type pg from 'pg';
import { retryDeadlock, withTx } from '../shared/db.js';

export interface GroupRef {
  groupTag: string;
  seasonId: string;
  tierId: number;
}

export interface StoreResult {
  membersWritten: number;
  battlesInserted: number;
  battleSidesFilled: number;
  expectedBattles: number;
}

/** API timestamps look like 20261024T061234.000Z; ISO strings are accepted too. */
export function parseApiTime(s: string): string {
  if (s.includes('-')) return new Date(s).toISOString();
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/.exec(s);
  if (!m) throw new Error(`Unrecognised timestamp: ${s}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? '000'}Z`;
}

interface BattleRow {
  att: string;
  def: string;
  time: string;
  stars: number;
  dest: number;
  atro: number | null;
  dtro: number | null;
}

/**
 * Stores one league-group response: the group, its roster, the clans and players in it, and the battles in the logs of
 * the ONE player the call was made for. Every battle is in two logs (the attacker's and the defender's); the battle
 * primary key merges them, and the second sighting only fills in the other side's trophy value.
 *
 * Shared by `groups` (registration, one call per group) and `battles` (collection after the season).
 * Every write is skipped when nothing changed, so storing the same response twice writes nothing.
 */
export class GroupStore {
  private readonly partitions = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly seasonSeconds = 604_800
  ) {}

  /**
   * One battle partition per season. Created OUTSIDE any transaction (it takes a strong lock on the battle table,
   * which must never be held together with other locks) and remembered in memory.
   */
  private async ensurePartition(seasonId: string): Promise<void> {
    if (!/^\d+$/.test(seasonId)) throw new Error(`Bad season id ${seasonId}`);
    if (this.partitions.has(seasonId)) return;
    try {
      await retryDeadlock(() =>
        this.pool.query(`CREATE TABLE IF NOT EXISTS battle_${seasonId} PARTITION OF battle FOR VALUES IN ('${seasonId}')`)
      );
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== '42P07' && code !== '23505') throw e; // another worker created it at the same moment
    }
    this.partitions.add(seasonId);
  }

  async store(ref: GroupRef, playerTag: string, res: APILeagueGroupList): Promise<StoreResult> {
    const members = [...new Map((res.members ?? []).map((m) => [m.playerTag, m])).values()];
    const expected = members.reduce((n, m) => n + m.attackWinCount + m.attackLoseCount, 0);

    const clans = new Map<string, string>();
    for (const m of members) if (m.clanTag) clans.set(m.clanTag, m.clanName);

    // attack log = this player attacked (attacker-side trophy value); defense log = this player was attacked (defender-side value)
    const battles = new Map<string, BattleRow>();
    const add = (b: BattleRow) => {
      const key = `${b.att}\u0000${b.def}\u0000${b.time}`;
      const prev = battles.get(key);
      if (prev) {
        prev.atro ??= b.atro;
        prev.dtro ??= b.dtro;
      } else battles.set(key, b);
    };
    for (const a of res.attackLogs ?? []) {
      add({ att: playerTag, def: a.opponentPlayerTag, time: parseApiTime(a.creationTime), stars: a.stars, dest: a.destructionPercentage, atro: a.trophies, dtro: null });
    }
    for (const d of res.defenseLogs ?? []) {
      add({ att: d.opponentPlayerTag, def: playerTag, time: parseApiTime(d.creationTime), stars: d.stars, dest: d.destructionPercentage, atro: null, dtro: d.trophies });
    }
    const rows = [...battles.values()];

    await this.ensurePartition(ref.seasonId);

    return withTx(this.pool, async (db) => {
      // 1. season and group (FK targets first)
      await db.query(
        `INSERT INTO season (season_id, starts_at, ends_at)
         SELECT x.s, to_timestamp(x.s::bigint), to_timestamp(x.s::bigint + $2) FROM (SELECT $1::text AS s) x
         ON CONFLICT (season_id) DO NOTHING`,
        [ref.seasonId, this.seasonSeconds]
      );
      await db.query(
        `INSERT INTO league_group (group_tag, season_id, tier_id, expected_battles, fetched_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (group_tag, season_id) DO UPDATE
           SET tier_id = EXCLUDED.tier_id, expected_battles = EXCLUDED.expected_battles, fetched_at = now()`,
        [ref.groupTag, ref.seasonId, ref.tierId, expected]
      );

      // 2. clans, then players (+ name history for new or renamed players). Sorted in SQL so concurrent writers lock in one order.
      if (clans.size) {
        const tags = [...clans.keys()];
        await db.query(
          `INSERT INTO clan (clan_tag, name)
           SELECT u.t, u.n FROM unnest($1::text[], $2::text[]) AS u(t, n) ORDER BY u.t
           ON CONFLICT (clan_tag) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
           WHERE clan.name IS DISTINCT FROM EXCLUDED.name`,
          [tags, tags.map((t) => clans.get(t) ?? null)]
        );
      }
      if (members.length) {
        const changed = await db.query<{ player_tag: string; name: string }>(
          `INSERT INTO player (player_tag, name)
           SELECT u.t, u.n FROM unnest($1::text[], $2::text[]) AS u(t, n) ORDER BY u.t
           ON CONFLICT (player_tag) DO UPDATE SET name = EXCLUDED.name, last_seen = now()
           WHERE player.name IS DISTINCT FROM EXCLUDED.name OR player.last_seen < now() - interval '1 day'
           RETURNING player_tag, name`,
          [members.map((m) => m.playerTag), members.map((m) => m.playerName)]
        );
        if (changed.rows.length) {
          await db.query(
            `INSERT INTO player_name_history (player_tag, name)
             SELECT u.t, u.n FROM unnest($1::text[], $2::text[]) AS u(t, n) ORDER BY u.t, u.n
             ON CONFLICT DO NOTHING`,
            [changed.rows.map((r) => r.player_tag), changed.rows.map((r) => r.name)]
          );
        }
      }

      // 3. roster
      let membersWritten = 0;
      if (members.length) {
        const r = await db.query(
          `INSERT INTO group_member (group_tag, season_id, player_tag, clan_tag, trophies, attack_wins, attack_losses, defense_wins, defense_losses)
           SELECT $1, $2, u.p, u.c, u.t, u.aw, u.al, u.dw, u.dl
             FROM unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[]) AS u(p, c, t, aw, al, dw, dl)
            ORDER BY u.p
           ON CONFLICT (group_tag, season_id, player_tag) DO UPDATE SET
             clan_tag = EXCLUDED.clan_tag, trophies = EXCLUDED.trophies, attack_wins = EXCLUDED.attack_wins,
             attack_losses = EXCLUDED.attack_losses, defense_wins = EXCLUDED.defense_wins, defense_losses = EXCLUDED.defense_losses
           WHERE (group_member.clan_tag, group_member.trophies, group_member.attack_wins, group_member.attack_losses,
                  group_member.defense_wins, group_member.defense_losses)
             IS DISTINCT FROM
                 (EXCLUDED.clan_tag, EXCLUDED.trophies, EXCLUDED.attack_wins, EXCLUDED.attack_losses,
                  EXCLUDED.defense_wins, EXCLUDED.defense_losses)`,
          [
            ref.groupTag, ref.seasonId,
            members.map((m) => m.playerTag), members.map((m) => m.clanTag || null), members.map((m) => m.leagueTrophies),
            members.map((m) => m.attackWinCount), members.map((m) => m.attackLoseCount),
            members.map((m) => m.defenseWinCount), members.map((m) => m.defenseLoseCount)
          ]
        );
        membersWritten = r.rowCount ?? 0;
      }

      // 4. battles from this player's logs. Two statements, because RETURNING xmax is not allowed on a partitioned
      // table: (a) insert the battles that are new, (b) fill in the other side's trophy value on ones already stored
      // from the opponent's log. Both read their rows from the same arrays and skip no-op writes.
      let battlesInserted = 0;
      let battleSidesFilled = 0;
      if (rows.length) {
        const args = [
          ref.seasonId, ref.groupTag,
          rows.map((b) => b.att), rows.map((b) => b.def), rows.map((b) => b.time),
          rows.map((b) => b.stars), rows.map((b) => b.dest), rows.map((b) => b.atro), rows.map((b) => b.dtro)
        ];
        const ins = await db.query(
          `INSERT INTO battle (season_id, attacker_tag, defender_tag, battle_time, group_tag, stars, destruction, attacker_trophies, defender_trophies)
           SELECT $1, u.a, u.d, u.t::timestamptz, $2, u.s, u.x, u.ar, u.dr
             FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[]) AS u(a, d, t, s, x, ar, dr)
            ORDER BY u.a, u.d, u.t
           ON CONFLICT (season_id, attacker_tag, defender_tag, battle_time) DO NOTHING
           RETURNING 1`,
          args
        );
        battlesInserted = ins.rowCount ?? 0;
        const fill = await db.query(
          `UPDATE battle b
              SET attacker_trophies = COALESCE(b.attacker_trophies, u.ar),
                  defender_trophies = COALESCE(b.defender_trophies, u.dr)
             FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::int[]) AS u(a, d, t, ar, dr)
            WHERE b.season_id = $1 AND b.attacker_tag = u.a AND b.defender_tag = u.d AND b.battle_time = u.t::timestamptz
              AND ((b.attacker_trophies IS NULL AND u.ar IS NOT NULL) OR (b.defender_trophies IS NULL AND u.dr IS NOT NULL))`,
          [ref.seasonId, args[2], args[3], args[4], args[7], args[8]]
        );
        battleSidesFilled = fill.rowCount ?? 0;
      }

      // 5. which member's logs this call covered, and the group's stored total (exact: only genuinely new rows are added)
      await db.query(
        `UPDATE group_member SET attacks_logged = $4, defenses_logged = $5, logs_fetched_at = now()
          WHERE group_tag = $1 AND season_id = $2 AND player_tag = $3`,
        [ref.groupTag, ref.seasonId, playerTag, (res.attackLogs ?? []).length, (res.defenseLogs ?? []).length]
      );
      if (battlesInserted > 0) {
        await db.query(
          `UPDATE league_group SET stored_battles = stored_battles + $3 WHERE group_tag = $1 AND season_id = $2`,
          [ref.groupTag, ref.seasonId, battlesInserted]
        );
      }
      return { membersWritten, battlesInserted, battleSidesFilled, expectedBattles: expected };
    });
  }
}
