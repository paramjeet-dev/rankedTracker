import type { APILeagueSeasonResultList, APIPlayer } from 'clashofclans.js';
import type { CallResult } from '../shared/clash.js';
import type { Logger } from '../shared/logger.js';
import { drain, pagedTargets } from '../shared/targets.js';
import type { ProfileData, ProfilePool, ProfileRepo, SeasonResultRow } from './repo.js';

export interface ProfileDeps {
  repo: ProfileRepo;
  fetchPlayer: (pool: ProfilePool, tag: string, signal: AbortSignal) => Promise<CallResult<APIPlayer>>;
  fetchHistory: (pool: ProfilePool, tag: string, signal: AbortSignal) => Promise<CallResult<APILeagueSeasonResultList>>;
  log: Logger;
  signal: AbortSignal;
  pageSize: number;
  idleMs: Record<ProfilePool, number>;
  /** Store only finished seasons whose tier is inside the tracked scope. */
  scope: { minTier: number; maxTier: number; historyScopeOnly: boolean };
}

export interface ProfileStats {
  visits: number;
  nameChanges: number;
  resultsWritten: number;
  failed: number;
  invalid: number;
  skippedOutage: number;
  dbErrors: number;
}

const emptyStats = (): ProfileStats => ({ visits: 0, nameChanges: 0, resultsWritten: 0, failed: 0, invalid: 0, skippedOutage: 0, dbErrors: 0 });

/**
 * Player profile + league-history visits (see docs/players-profile.md).
 * A visit is two calls, getPlayer then getLeagueHistory, saved in ONE transaction. If either call fails nothing is
 * saved, so `history_backfilled_at` always means "profile and history are both current for this season".
 */
export class PlayersProfile {
  readonly stats: Record<ProfilePool, ProfileStats> = { new: emptyStats(), refresh: emptyStats() };

  constructor(private readonly d: ProfileDeps) {}

  async runPool(pool: ProfilePool, workers: number): Promise<void> {
    await drain({
      workers,
      items: pagedTargets({
        label: pool,
        load: (after, limit) => this.d.repo.loadTargets(pool, after, limit),
        pageSize: this.d.pageSize,
        idleMs: this.d.idleMs[pool],
        signal: this.d.signal,
        log: this.d.log
      }),
      label: pool,
      signal: this.d.signal,
      log: this.d.log,
      handle: (tag) => this.processPlayer(pool, tag),
      onError: () => void this.stats[pool].dbErrors++
    });
  }

  async processPlayer(pool: ProfilePool, tag: string): Promise<void> {
    const s = this.stats[pool];
    const player = await this.d.fetchPlayer(pool, tag, this.d.signal);
    if (!player.ok) return this.handleFailure(pool, tag, player);

    const history = await this.d.fetchHistory(pool, tag, this.d.signal);
    let items: APILeagueSeasonResultList['items'];
    if (history.ok) items = history.value.items ?? [];
    else if (history.kind === 'not_found') items = []; // no league history is "empty", not "invalid player"
    else return this.handleFailure(pool, tag, history);

    const p = player.value;
    const profile: ProfileData = {
      tag,
      name: p.name,
      clanTag: p.clan?.tag ?? null,
      clanName: p.clan?.name ?? null,
      tierId: p.leagueTier?.id ?? null,
      currentGroupTag: p.currentLeagueGroupTag || null,
      currentGroupSeasonId: p.currentLeagueSeasonId ? String(p.currentLeagueSeasonId) : null,
      previousGroupTag: p.previousLeagueGroupTag || null,
      previousGroupSeasonId: p.previousLeagueSeasonId ? String(p.previousLeagueSeasonId) : null
    };
    const { minTier, maxTier, historyScopeOnly } = this.d.scope;
    const results: SeasonResultRow[] = items
      .filter((r) => !historyScopeOnly || (r.leagueTierId >= minTier && r.leagueTierId <= maxTier))
      .map((r) => ({
        seasonId: String(r.leagueSeasonId),
        tierId: r.leagueTierId,
        trophies: r.leagueTrophies,
        placement: r.placement,
        attackWins: r.attackWins,
        attackLosses: r.attackLosses,
        defenseWins: r.defenseWins,
        defenseLosses: r.defenseLosses,
        defenseStars: r.defenseStars,
        maxBattles: r.maxBattles
      }));

    const saved = await this.d.repo.saveVisit(profile, results);
    if (saved.updated) {
      s.visits++;
      s.resultsWritten += saved.resultsWritten;
      if (saved.nameChanged) s.nameChanges++;
    }
  }

  private async handleFailure(pool: ProfilePool, tag: string, res: Extract<CallResult<unknown>, { ok: false }>): Promise<void> {
    const s = this.stats[pool];
    if (res.kind === 'unavailable' || res.kind === 'maintenance' || res.kind === 'auth' || res.kind === 'aborted') {
      s.skippedOutage++; // not this player's fault: leave it as a target
      return;
    }
    if (res.permanent) {
      await this.d.repo.markInvalid(tag);
      s.invalid++;
      return;
    }
    await this.d.repo.recordFailure(tag);
    s.failed++;
  }
}
