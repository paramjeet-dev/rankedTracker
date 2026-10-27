import type pg from 'pg';
import { withTx } from '../shared/db.js';
import { seasonConventionProblem, tagFormatProblem } from '../shared/sanity.js';

export type ProfilePool = 'new' | 'refresh';

export interface ProfileData {
  tag: string;
  name: string;
  /** The player's current clan, if any. Upserted so clan discovery can reach it. */
  clanTag: string | null;
  clanName: string | null;
  tierId: number | null;
  currentGroupTag: string | null;
  currentGroupSeasonId: string | null;
  previousGroupTag: string | null;
  previousGroupSeasonId: string | null;
}

export interface SeasonResultRow {
  seasonId: string;
  tierId: number;
  trophies: number;
  placement: number;
  attackWins: number;
  attackLosses: number;
  defenseWins: number;
  defenseLosses: number;
  defenseStars: number;
  maxBattles: number;
}

export interface SaveVisitResult {
  updated: boolean;
  nameChanged: boolean;
  resultsWritten: number;
}

export interface ProfileRepo {
  loadTargets(pool: ProfilePool, afterTag: string, limit: number): Promise<string[]>;
  countTargets(pool: ProfilePool): Promise<number>;
  saveVisit(profile: ProfileData, results: SeasonResultRow[]): Promise<SaveVisitResult>;
  recordFailure(playerTag: string): Promise<void>;
  markInvalid(playerTag: string): Promise<void>;
  sanityProblem(): Promise<string | null>;
}

export interface ProfileRepoOptions {
  minTier: number;
  maxTier: number;
  seasonSeconds: number;
}

/**
 * Start of the current season, computed in SQL from the newest stored season id (ids are start times, seasons are one
 * week long). Arithmetic rather than "newest row" so the refresh wave begins at rollover even before any group of the
 * new season has been stored.
 */
const CURRENT_SEASON = `
  WITH a AS (SELECT max(season_id::bigint) AS anchor FROM season WHERE season_id ~ '^[0-9]+$'),
       cur AS (SELECT to_timestamp(anchor + floor((extract(epoch FROM now()) - anchor) / $1) * $1) AS start FROM a)`;

const COMMON = `p.invalid_at IS NULL
   AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= now())
   AND (p.tier_id IS NULL OR p.tier_id BETWEEN $2 AND $3)`;

export class PgProfileRepo implements ProfileRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: ProfileRepoOptions
  ) {}

  private poolPredicate(pool: ProfilePool): string {
    return pool === 'new'
      ? 'p.history_backfilled_at IS NULL'
      : 'p.history_backfilled_at IS NOT NULL AND p.history_backfilled_at < cur.start';
  }

  async loadTargets(pool: ProfilePool, afterTag: string, limit: number): Promise<string[]> {
    const res = await this.pool.query<{ player_tag: string }>(
      `${CURRENT_SEASON}
       SELECT p.player_tag FROM player p, cur
        WHERE ${COMMON} AND ${this.poolPredicate(pool)} AND p.player_tag > $4
        ORDER BY p.player_tag LIMIT $5`,
      [this.opts.seasonSeconds, this.opts.minTier, this.opts.maxTier, afterTag, limit]
    );
    return res.rows.map((r) => r.player_tag);
  }

  async countTargets(pool: ProfilePool): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `${CURRENT_SEASON}
       SELECT count(*) AS n FROM player p, cur WHERE ${COMMON} AND ${this.poolPredicate(pool)}`,
      [this.opts.seasonSeconds, this.opts.minTier, this.opts.maxTier]
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** One transaction: name history, season rows, season results, then the player row. */
  async saveVisit(profile: ProfileData, results: SeasonResultRow[]): Promise<SaveVisitResult> {
    return withTx(this.pool, async (db) => {
      const existing = await db.query<{ name: string | null }>('SELECT name FROM player WHERE player_tag = $1 FOR UPDATE', [profile.tag]);
      if (existing.rowCount === 0) return { updated: false, nameChanged: false, resultsWritten: 0 };
      const oldName = existing.rows[0]?.name ?? null;
      const nameChanged = oldName !== null && oldName !== profile.name;

      // The player's clan becomes a target for clan roster discovery (the old crawler queued a clan job here).
      if (profile.clanTag) {
        await db.query(
          `INSERT INTO clan (clan_tag, name) VALUES ($1, $2)
           ON CONFLICT (clan_tag) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
           WHERE clan.name IS DISTINCT FROM EXCLUDED.name`,
          [profile.clanTag, profile.clanName]
        );
      }

      // Record both the previous and the current name. Already-known names are ignored (PK player_tag + name).
      const names = [...new Set([oldName, profile.name].filter((n): n is string => !!n))];
      await db.query(
        `INSERT INTO player_name_history (player_tag, name)
         SELECT $1, n FROM unnest($2::text[]) AS n ON CONFLICT DO NOTHING`,
        [profile.tag, names]
      );

      let resultsWritten = 0;
      if (results.length) {
        // Sorted so concurrent transactions touching the same seasons take locks in the same order.
        const seasonIds = [...new Set(results.map((r) => r.seasonId))].sort();
        await db.query(
          `INSERT INTO season (season_id, starts_at, ends_at)
           SELECT s, to_timestamp(s::bigint), to_timestamp(s::bigint + $2)
             FROM unnest($1::text[]) AS s ORDER BY s
           ON CONFLICT (season_id) DO NOTHING`,
          [seasonIds, this.opts.seasonSeconds]
        );
        const col = <K extends keyof SeasonResultRow>(k: K) => results.map((r) => r[k]);
        const r = await db.query(
          `INSERT INTO player_season_result
             (player_tag, season_id, tier_id, trophies, placement, attack_wins, attack_losses,
              defense_wins, defense_losses, defense_stars, max_battles)
           SELECT $1, t.season_id, t.tier_id, t.trophies, t.placement, t.aw, t.al, t.dw, t.dl, t.dstars, t.mb
             FROM unnest($2::text[], $3::bigint[], $4::int[], $5::int[], $6::int[], $7::int[],
                         $8::int[], $9::int[], $10::int[], $11::int[])
                  AS t(season_id, tier_id, trophies, placement, aw, al, dw, dl, dstars, mb)
           ON CONFLICT (player_tag, season_id) DO UPDATE SET
             tier_id = EXCLUDED.tier_id, trophies = EXCLUDED.trophies, placement = EXCLUDED.placement,
             attack_wins = EXCLUDED.attack_wins, attack_losses = EXCLUDED.attack_losses,
             defense_wins = EXCLUDED.defense_wins, defense_losses = EXCLUDED.defense_losses,
             defense_stars = EXCLUDED.defense_stars, max_battles = EXCLUDED.max_battles
           WHERE (player_season_result.tier_id, player_season_result.trophies, player_season_result.placement,
                  player_season_result.attack_wins, player_season_result.attack_losses,
                  player_season_result.defense_wins, player_season_result.defense_losses,
                  player_season_result.defense_stars, player_season_result.max_battles)
             IS DISTINCT FROM
                 (EXCLUDED.tier_id, EXCLUDED.trophies, EXCLUDED.placement, EXCLUDED.attack_wins, EXCLUDED.attack_losses,
                  EXCLUDED.defense_wins, EXCLUDED.defense_losses, EXCLUDED.defense_stars, EXCLUDED.max_battles)`,
          [
            profile.tag, col('seasonId'), col('tierId'), col('trophies'), col('placement'), col('attackWins'),
            col('attackLosses'), col('defenseWins'), col('defenseLosses'), col('defenseStars'), col('maxBattles')
          ]
        );
        resultsWritten = r.rowCount ?? 0;
      }

      await db.query(
        `UPDATE player
            SET name = $2, tier_id = $3, profiled_at = now(), history_backfilled_at = now(), last_seen = now(),
                current_group_tag = $4, current_group_season_id = $5,
                previous_group_tag = $6, previous_group_season_id = $7,
                fail_count = 0, next_attempt_at = NULL
          WHERE player_tag = $1`,
        [
          profile.tag, profile.name, profile.tierId, profile.currentGroupTag, profile.currentGroupSeasonId,
          profile.previousGroupTag, profile.previousGroupSeasonId
        ]
      );
      return { updated: true, nameChanged, resultsWritten };
    });
  }

  async recordFailure(playerTag: string): Promise<void> {
    await this.pool.query(
      `UPDATE player
          SET fail_count = fail_count + 1,
              next_attempt_at = now() + LEAST(interval '6 hours', interval '1 minute' * power(2, LEAST(fail_count, 10)))
        WHERE player_tag = $1`,
      [playerTag]
    );
  }

  async markInvalid(playerTag: string): Promise<void> {
    await this.pool.query('UPDATE player SET invalid_at = now() WHERE player_tag = $1', [playerTag]);
  }

  async sanityProblem(): Promise<string | null> {
    return (await tagFormatProblem(this.pool)) ?? (await seasonConventionProblem(this.pool, this.opts.seasonSeconds));
  }
}
