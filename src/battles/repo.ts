import type pg from 'pg';
import { seasonConventionProblem, tagFormatProblem } from '../shared/sanity.js';

export interface CollectTarget {
  groupTag: string;
  seasonId: string;
  tierId: number;
}

export type GroupStatus = 'pending' | 'complete' | 'incomplete';

export interface BattlesRepo {
  loadTargets(afterKey: string, limit: number): Promise<CollectTarget[]>;
  countTargets(): Promise<number>;
  /** First touch of a season's collection: sets season.swept_at once. */
  beginGroup(t: CollectTarget): Promise<void>;
  /** The most active member whose logs are missing or older than the season end, not in `visited`. */
  nextMember(t: CollectTarget, visited: string[]): Promise<string | null>;
  isCovered(t: CollectTarget): Promise<boolean>;
  /** Settle status (pending / complete / incomplete) and stamp collected_at. */
  finalize(t: CollectTarget): Promise<GroupStatus>;
  /** Transient failure: back this group off; collection resumes from the members still missing. */
  recordFailure(t: CollectTarget): Promise<void>;
  sanityProblem(): Promise<string | null>;
}

/** Season first (newest first, because old data is the data that can stop being served), then group tag. */
export const collectCursor = (t: CollectTarget): string => `${t.seasonId}\u0001${t.groupTag}`;

export interface BattlesRepoOptions {
  minTier: number;
  maxTier: number;
  seasonSeconds: number;
  /** Let the final rankings settle after the season ends. */
  graceMinutes?: number;
}

export class PgBattlesRepo implements BattlesRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: BattlesRepoOptions
  ) {}

  private get grace(): number {
    return this.opts.graceMinutes ?? 10;
  }

  private readonly ELIGIBLE = `
    s.ends_at < now() - make_interval(mins => $3)
    AND g.tier_id BETWEEN $1 AND $2
    AND g.status <> 'complete' AND g.collected_at IS NULL
    AND (g.collect_next_attempt_at IS NULL OR g.collect_next_attempt_at <= now())`;

  async loadTargets(afterKey: string, limit: number): Promise<CollectTarget[]> {
    const params: unknown[] = [this.opts.minTier, this.opts.maxTier, this.grace];
    let cursor = '';
    if (afterKey) {
      const [season = '', group = ''] = afterKey.split('\u0001');
      params.push(season, group);
      cursor = 'AND (g.season_id, g.group_tag) < ($4, $5)';
    }
    params.push(limit);
    const res = await this.pool.query<{ group_tag: string; season_id: string; tier_id: string }>(
      `SELECT g.group_tag, g.season_id, g.tier_id
         FROM league_group g JOIN season s ON s.season_id = g.season_id
        WHERE ${this.ELIGIBLE} ${cursor}
        ORDER BY g.season_id DESC, g.group_tag DESC
        LIMIT $${params.length}`,
      params
    );
    return res.rows.map((r) => ({ groupTag: r.group_tag, seasonId: r.season_id, tierId: Number(r.tier_id) }));
  }

  async countTargets(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM league_group g JOIN season s ON s.season_id = g.season_id WHERE ${this.ELIGIBLE}`,
      [this.opts.minTier, this.opts.maxTier, this.grace]
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async beginGroup(t: CollectTarget): Promise<void> {
    await this.pool.query(`UPDATE season SET swept_at = now() WHERE season_id = $1 AND swept_at IS NULL`, [t.seasonId]);
  }

  async nextMember(t: CollectTarget, visited: string[]): Promise<string | null> {
    const res = await this.pool.query<{ player_tag: string }>(
      `SELECT gm.player_tag
         FROM group_member gm JOIN season s ON s.season_id = gm.season_id
        WHERE gm.group_tag = $1 AND gm.season_id = $2
          AND COALESCE(gm.attack_wins, 0) + COALESCE(gm.attack_losses, 0) + COALESCE(gm.defense_wins, 0) + COALESCE(gm.defense_losses, 0) > 0
          AND NOT (gm.player_tag = ANY($3::text[]))
          AND (gm.logs_fetched_at IS NULL OR gm.logs_fetched_at < s.ends_at)
        ORDER BY COALESCE(gm.attack_wins, 0) + COALESCE(gm.attack_losses, 0) + COALESCE(gm.defense_wins, 0) + COALESCE(gm.defense_losses, 0) DESC,
                 gm.player_tag
        LIMIT 1`,
      [t.groupTag, t.seasonId, visited]
    );
    return res.rows[0]?.player_tag ?? null;
  }

  async isCovered(t: CollectTarget): Promise<boolean> {
    const res = await this.pool.query<{ ok: boolean | null }>(
      'SELECT stored_battles >= expected_battles AS ok FROM league_group WHERE group_tag = $1 AND season_id = $2',
      [t.groupTag, t.seasonId]
    );
    return !!res.rows[0]?.ok;
  }

  async finalize(t: CollectTarget): Promise<GroupStatus> {
    const res = await this.pool.query<{ status: GroupStatus }>(
      `UPDATE league_group g
          SET status = CASE WHEN s.ends_at > now() THEN 'pending'
                            WHEN g.stored_battles >= g.expected_battles THEN 'complete'
                            ELSE 'incomplete' END,
              collected_at = now(), collect_fail_count = 0, collect_next_attempt_at = NULL
         FROM season s
        WHERE s.season_id = g.season_id AND g.group_tag = $1 AND g.season_id = $2
        RETURNING g.status`,
      [t.groupTag, t.seasonId]
    );
    return res.rows[0]?.status ?? 'pending';
  }

  async recordFailure(t: CollectTarget): Promise<void> {
    await this.pool.query(
      `UPDATE league_group
          SET collect_fail_count = collect_fail_count + 1,
              collect_next_attempt_at = now() + LEAST(interval '6 hours', interval '1 minute' * power(2, LEAST(collect_fail_count, 10)))
        WHERE group_tag = $1 AND season_id = $2`,
      [t.groupTag, t.seasonId]
    );
  }

  async sanityProblem(): Promise<string | null> {
    return (await tagFormatProblem(this.pool)) ?? (await seasonConventionProblem(this.pool, this.opts.seasonSeconds));
  }
}
