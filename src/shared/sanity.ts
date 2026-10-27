import type pg from 'pg';

/** Stored tags must use the API's "#" prefix, otherwise upserts create duplicate rows instead of updating. */
export async function tagFormatProblem(pool: pg.Pool): Promise<string | null> {
  const p = await pool.query<{ player_tag: string }>('SELECT player_tag FROM player LIMIT 1');
  const c = await pool.query<{ clan_tag: string }>('SELECT clan_tag FROM clan LIMIT 1');
  const bad: string[] = [];
  if (p.rows[0] && !p.rows[0].player_tag.startsWith('#')) bad.push(`player_tag "${p.rows[0].player_tag}"`);
  if (c.rows[0] && !c.rows[0].clan_tag.startsWith('#')) bad.push(`clan_tag "${c.rows[0].clan_tag}"`);
  return bad.length
    ? `Stored tags do not start with "#" (${bad.join(', ')}) but the API returns "#"-prefixed tags. Writing now would create duplicate rows.`
    : null;
}

/** Season ids are the season START time (epoch seconds) and seasons last seasonSeconds (one week). */
export async function seasonConventionProblem(pool: pg.Pool, seasonSeconds: number): Promise<string | null> {
  const r = await pool.query<{ season_id: string }>(
    `SELECT season_id FROM season
      WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL AND season_id ~ '^[0-9]+$'
        AND (ends_at - starts_at <> make_interval(secs => $1) OR starts_at <> to_timestamp(season_id::bigint))
      LIMIT 1`,
    [seasonSeconds]
  );
  return r.rows[0]
    ? `Season ${r.rows[0].season_id} does not match "id = start time, length = ${seasonSeconds}s". Check the season table before writing new season rows.`
    : null;
}
