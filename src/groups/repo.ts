import type pg from 'pg';
import { seasonConventionProblem, tagFormatProblem } from '../shared/sanity.js';

export interface GroupTarget {
  groupTag: string;
  seasonId: string;
  /** One member of the group, used as the playerTag the API requires. */
  playerTag: string;
  tierId: number;
}

export interface GroupsRepo {
  loadTargets(afterKey: string, limit: number): Promise<GroupTarget[]>;
  countTargets(): Promise<number>;
  /** Transient failure: back this group off. */
  recordFailure(t: GroupTarget): Promise<void>;
  /** Permanent failure: the API does not serve this group (anymore). */
  markGone(t: GroupTarget): Promise<void>;
  sanityProblem(): Promise<string | null>;
}

export const targetCursor = (t: GroupTarget): string => `${t.groupTag}\u0001${t.seasonId}`;

export interface GroupsRepoOptions {
  minTier: number;
  maxTier: number;
  seasonSeconds: number;
}

/**
 * Candidates are the groups players' profiles point at:
 *  - the current group, when the player's current tier is in scope;
 *  - the previous group, when that player's finished-season result for the previous season is in scope
 *    (the history call is what gives the previous season's tier).
 * One representative player per group (sibling exclusion), groups already stored are excluded, and so are groups
 * the API no longer serves or that are backing off.
 */
const CANDIDATES = `
  WITH cand AS (
    SELECT p.current_group_tag AS group_tag, p.current_group_season_id AS season_id, p.player_tag, p.tier_id AS tier_id
      FROM player p
     WHERE p.current_group_tag IS NOT NULL AND p.current_group_season_id IS NOT NULL
       AND p.tier_id BETWEEN $1 AND $2
    UNION ALL
    SELECT p.previous_group_tag, p.previous_group_season_id, p.player_tag, r.tier_id
      FROM player p
      JOIN player_season_result r ON r.player_tag = p.player_tag AND r.season_id = p.previous_group_season_id
     WHERE p.previous_group_tag IS NOT NULL AND p.previous_group_season_id IS NOT NULL
       AND r.tier_id BETWEEN $1 AND $2
  )`;

const UNSTORED = `
   AND NOT EXISTS (SELECT 1 FROM league_group g WHERE g.group_tag = c.group_tag AND g.season_id = c.season_id)
   AND NOT EXISTS (SELECT 1 FROM group_fetch_state s
                    WHERE s.group_tag = c.group_tag AND s.season_id = c.season_id
                      AND (s.gone_at IS NOT NULL OR s.next_attempt_at > now()))`;

export class PgGroupsRepo implements GroupsRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: GroupsRepoOptions
  ) {}

  async loadTargets(afterKey: string, limit: number): Promise<GroupTarget[]> {
    const [afterGroup = '', afterSeason = ''] = afterKey.split('\u0001');
    const res = await this.pool.query<{ group_tag: string; season_id: string; player_tag: string; tier_id: string }>(
      `${CANDIDATES}
       SELECT DISTINCT ON (c.group_tag, c.season_id) c.group_tag, c.season_id, c.player_tag, c.tier_id
         FROM cand c
        WHERE (c.group_tag, c.season_id) > ($3, $4) ${UNSTORED}
        ORDER BY c.group_tag, c.season_id, c.player_tag
        LIMIT $5`,
      [this.opts.minTier, this.opts.maxTier, afterGroup, afterSeason, limit]
    );
    return res.rows.map((r) => ({ groupTag: r.group_tag, seasonId: r.season_id, playerTag: r.player_tag, tierId: Number(r.tier_id) }));
  }

  async countTargets(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `${CANDIDATES}
       SELECT count(*) AS n FROM (SELECT DISTINCT c.group_tag, c.season_id FROM cand c WHERE true ${UNSTORED}) x`,
      [this.opts.minTier, this.opts.maxTier]
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async recordFailure(t: GroupTarget): Promise<void> {
    // 1, 2, 4, ... minutes, capped at 6 hours
    await this.pool.query(
      `INSERT INTO group_fetch_state (group_tag, season_id, fail_count, next_attempt_at)
       VALUES ($1, $2, 1, now() + interval '1 minute')
       ON CONFLICT (group_tag, season_id) DO UPDATE SET
         fail_count = group_fetch_state.fail_count + 1,
         next_attempt_at = now() + LEAST(interval '6 hours', interval '1 minute' * power(2, LEAST(group_fetch_state.fail_count, 10)))`,
      [t.groupTag, t.seasonId]
    );
  }

  async markGone(t: GroupTarget): Promise<void> {
    await this.pool.query(
      `INSERT INTO group_fetch_state (group_tag, season_id, gone_at) VALUES ($1, $2, now())
       ON CONFLICT (group_tag, season_id) DO UPDATE SET gone_at = now()`,
      [t.groupTag, t.seasonId]
    );
  }

  async sanityProblem(): Promise<string | null> {
    return (await tagFormatProblem(this.pool)) ?? (await seasonConventionProblem(this.pool, this.opts.seasonSeconds));
  }
}
