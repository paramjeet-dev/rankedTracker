import type pg from 'pg';
import { withTx } from '../shared/db.js';
import { tagFormatProblem } from '../shared/sanity.js';

export type DiscoveryPool = 'new' | 'refresh';

export interface MemberRow {
  tag: string;
  name: string;
  tierId: number;
}

export interface SaveResult {
  inserted: number;
  tierUpdated: number;
}

export interface DiscoveryRepo {
  loadTargets(pool: DiscoveryPool, afterTag: string, limit: number): Promise<string[]>;
  countTargets(pool: DiscoveryPool): Promise<number>;
  saveClan(clanTag: string, clanName: string, members: MemberRow[]): Promise<SaveResult>;
  /** Transient failure: back off this clan only. */
  recordFailure(clanTag: string): Promise<void>;
  /** Permanent failure (clan gone, bad tag): stop targeting it. */
  markInvalid(clanTag: string): Promise<void>;
  /** Guard against creating duplicate rows when tags are stored in a different format than the API's. */
  tagFormatProblem(): Promise<string | null>;
}

export interface RepoOptions {
  minTier: number;
  maxTier: number;
  refreshDays: number;
}

const ELIGIBLE = `invalid_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())`;

export class PgDiscoveryRepo implements DiscoveryRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: RepoOptions
  ) {}

  private where(pool: DiscoveryPool): { sql: string; params: unknown[] } {
    return pool === 'new'
      ? { sql: `members_crawled_at IS NULL AND ${ELIGIBLE}`, params: [] }
      : {
          sql: `members_crawled_at IS NOT NULL AND members_crawled_at < now() - make_interval(days => $REFRESH) AND ${ELIGIBLE}`,
          params: [this.opts.refreshDays]
        };
  }

  /** Keyset pagination: ordered by tag, resumes after the last tag read. */
  async loadTargets(pool: DiscoveryPool, afterTag: string, limit: number): Promise<string[]> {
    const w = this.where(pool);
    const tagIdx = w.params.length + 1;
    const limitIdx = w.params.length + 2;
    const sql = `SELECT clan_tag FROM clan WHERE ${w.sql.replace('$REFRESH', '$1')} AND clan_tag > $${tagIdx} ORDER BY clan_tag LIMIT $${limitIdx}`;
    const res = await this.pool.query<{ clan_tag: string }>(sql, [...w.params, afterTag, limit]);
    return res.rows.map((r) => r.clan_tag);
  }

  async countTargets(pool: DiscoveryPool): Promise<number> {
    const w = this.where(pool);
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM clan WHERE ${w.sql.replace('$REFRESH', '$1')}`,
      w.params
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async saveClan(clanTag: string, clanName: string, members: MemberRow[]): Promise<SaveResult> {
    const inScope = members.filter((m) => m.tierId >= this.opts.minTier && m.tierId <= this.opts.maxTier);
    const others = members.filter((m) => !(m.tierId >= this.opts.minTier && m.tierId <= this.opts.maxTier));

    return withTx(this.pool, async (db) => {
      let inserted = 0;
      let tierUpdated = 0;

      if (inScope.length) {
        // New in-scope players are inserted. Existing ones only get tier/last_seen changes, and last_seen is
        // touched at most once a day so an unchanged roster causes no writes. Name is deliberately NOT updated
        // here: name changes are the profile process's job (it owns player_name_history).
        // Sorted by tag so concurrent transactions lock rows in the same order and cannot deadlock.
        const r = await db.query<{ inserted: boolean }>(
          `INSERT INTO player (player_tag, name, tier_id, last_seen)
           SELECT t.tag, t.name, t.tier, now()
             FROM unnest($1::text[], $2::text[], $3::bigint[]) AS t(tag, name, tier)
            ORDER BY t.tag
           ON CONFLICT (player_tag) DO UPDATE
              SET tier_id = EXCLUDED.tier_id, last_seen = now()
            WHERE player.tier_id IS DISTINCT FROM EXCLUDED.tier_id
               OR player.last_seen IS NULL
               OR player.last_seen < now() - interval '1 day'
           RETURNING (xmax = 0) AS inserted`,
          [inScope.map((m) => m.tag), inScope.map((m) => m.name), inScope.map((m) => m.tierId)]
        );
        inserted = r.rows.filter((x) => x.inserted).length;
        tierUpdated = r.rows.length - inserted;
      }

      if (others.length) {
        // Players already in the catalogue who left scope: record their new tier, never insert new rows.
        const r = await db.query(
          `UPDATE player p SET tier_id = t.tier, last_seen = now()
             FROM unnest($1::text[], $2::bigint[]) AS t(tag, tier)
            WHERE p.player_tag = t.tag AND p.tier_id IS DISTINCT FROM t.tier`,
          [others.map((m) => m.tag), others.map((m) => m.tierId)]
        );
        tierUpdated += r.rowCount ?? 0;
      }

      await db.query(
        `UPDATE clan
            SET name = $2, updated_at = now(), members_crawled_at = now(), member_count = $3,
                fail_count = 0, next_attempt_at = NULL
          WHERE clan_tag = $1`,
        [clanTag, clanName, members.length]
      );
      return { inserted, tierUpdated };
    });
  }

  async recordFailure(clanTag: string): Promise<void> {
    // 1, 2, 4, ... minutes, capped at 6 hours. Uses the old fail_count on the right-hand side.
    await this.pool.query(
      `UPDATE clan
          SET fail_count = fail_count + 1,
              next_attempt_at = now() + LEAST(interval '6 hours', interval '1 minute' * power(2, LEAST(fail_count, 10)))
        WHERE clan_tag = $1`,
      [clanTag]
    );
  }

  async markInvalid(clanTag: string): Promise<void> {
    await this.pool.query(
      `UPDATE clan SET invalid_at = now(), members_crawled_at = COALESCE(members_crawled_at, now()) WHERE clan_tag = $1`,
      [clanTag]
    );
  }

  tagFormatProblem(): Promise<string | null> {
    return tagFormatProblem(this.pool);
  }
}
