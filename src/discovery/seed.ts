import type pg from 'pg';

/** Insert clan tags that are not in `clan` yet (members_crawled_at stays NULL, so discovery picks them up). Returns how many were new. */
export async function insertSeedClans(pool: pg.Pool, tags: string[]): Promise<number> {
  const unique = [...new Set(tags)];
  let inserted = 0;
  for (let i = 0; i < unique.length; i += 5_000) {
    const res = await pool.query(
      `INSERT INTO clan (clan_tag) SELECT t FROM unnest($1::text[]) AS t ORDER BY t ON CONFLICT (clan_tag) DO NOTHING RETURNING 1`,
      [unique.slice(i, i + 5_000)]
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export interface LegacyQueueReport {
  clans: { queued: number; missing: number };
  players: { queued: number; missing: number };
  appliedClans: number;
  appliedPlayers: number;
}

/**
 * The old crawler keeps its work in the `job` table, and a queued clan_members / profile job carries only a tag: the
 * clan or player row is created when the job RUNS. Targets of the new processes are rows, so queued tags without a
 * row would be lost. This copies them over (rows only; the job table itself is never modified).
 */
export async function importLegacyQueue(pool: pg.Pool, apply: boolean): Promise<LegacyQueueReport> {
  const count = async (kind: string, key: string, table: string, col: string) => {
    const r = await pool.query<{ queued: string; missing: string }>(
      `WITH q AS (SELECT DISTINCT payload->>'${key}' AS t FROM job
                   WHERE kind = $1 AND status IN ('queued', 'running') AND payload->>'${key}' IS NOT NULL)
       SELECT count(*) AS queued, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.${col} = q.t)) AS missing FROM q`,
      [kind]
    );
    return { queued: Number(r.rows[0]?.queued ?? 0), missing: Number(r.rows[0]?.missing ?? 0) };
  };
  const clans = await count('clan_members', 'clanTag', 'clan', 'clan_tag');
  const players = await count('profile', 'playerTag', 'player', 'player_tag');
  let appliedClans = 0;
  let appliedPlayers = 0;
  if (apply) {
    const c = await pool.query(
      `INSERT INTO clan (clan_tag)
       SELECT t FROM (SELECT DISTINCT payload->>'clanTag' AS t FROM job
                       WHERE kind = 'clan_members' AND status IN ('queued', 'running') AND payload->>'clanTag' IS NOT NULL) q
       ORDER BY t ON CONFLICT (clan_tag) DO NOTHING RETURNING 1`
    );
    appliedClans = c.rowCount ?? 0;
    const p = await pool.query(
      `INSERT INTO player (player_tag)
       SELECT t FROM (SELECT DISTINCT payload->>'playerTag' AS t FROM job
                       WHERE kind = 'profile' AND status IN ('queued', 'running') AND payload->>'playerTag' IS NOT NULL) q
       ORDER BY t ON CONFLICT (player_tag) DO NOTHING RETURNING 1`
    );
    appliedPlayers = p.rowCount ?? 0;
  }
  return { clans, players, appliedClans, appliedPlayers };
}
