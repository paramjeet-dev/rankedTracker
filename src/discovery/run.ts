import type { APIClan } from 'clashofclans.js';
import type { CallResult } from '../shared/clash.js';
import type { Logger } from '../shared/logger.js';
import { drain, pagedTargets } from '../shared/targets.js';
import type { DiscoveryPool, DiscoveryRepo, MemberRow } from './repo.js';

export interface DiscoveryDeps {
  repo: DiscoveryRepo;
  fetchClan: (pool: DiscoveryPool, clanTag: string, signal: AbortSignal) => Promise<CallResult<APIClan>>;
  log: Logger;
  signal: AbortSignal;
  pageSize: number;
  /** How long a pool sleeps after a full pass finds nothing left to do. */
  idleMs: Record<DiscoveryPool, number>;
}

export interface PoolStats {
  clansOk: number;
  playersInserted: number;
  tierUpdates: number;
  failed: number;
  invalid: number;
  skippedOutage: number;
  dbErrors: number;
}

const emptyStats = (): PoolStats => ({ clansOk: 0, playersInserted: 0, tierUpdates: 0, failed: 0, invalid: 0, skippedOutage: 0, dbErrors: 0 });

/**
 * Clan roster discovery (see docs/players-discovery.md).
 *
 * Targets are a keyset-paginated query, not a queue (see shared/targets.ts): workers share one stream, so requests
 * flow continuously and a slow clan never holds up the next page.
 */
export class PlayersDiscovery {
  readonly stats: Record<DiscoveryPool, PoolStats> = { new: emptyStats(), refresh: emptyStats() };

  constructor(private readonly d: DiscoveryDeps) {}

  async runPool(pool: DiscoveryPool, workers: number): Promise<void> {
    const items = pagedTargets({
      label: pool,
      load: (after, limit) => this.d.repo.loadTargets(pool, after, limit),
      pageSize: this.d.pageSize,
      idleMs: this.d.idleMs[pool],
      signal: this.d.signal,
      log: this.d.log
    });
    await drain({
      workers,
      items,
      label: pool,
      signal: this.d.signal,
      log: this.d.log,
      handle: (tag) => this.processClan(pool, tag),
      onError: () => void this.stats[pool].dbErrors++
    });
  }

  async processClan(pool: DiscoveryPool, clanTag: string): Promise<void> {
    const s = this.stats[pool];
    const res = await this.d.fetchClan(pool, clanTag, this.d.signal);

    if (res.ok) {
      const members: MemberRow[] = (res.value.memberList ?? []).map((m) => ({
        tag: m.tag,
        name: m.name,
        tierId: m.leagueTier?.id ?? 0
      }));
      const saved = await this.d.repo.saveClan(clanTag, res.value.name, members);
      s.clansOk++;
      s.playersInserted += saved.inserted;
      s.tierUpdates += saved.tierUpdated;
      return;
    }

    if (res.kind === 'unavailable' || res.kind === 'maintenance' || res.kind === 'auth' || res.kind === 'aborted') {
      s.skippedOutage++; // not the clan's fault: leave it untouched for the next scan
      return;
    }
    if (res.permanent) {
      await this.d.repo.markInvalid(clanTag);
      s.invalid++;
      return;
    }
    await this.d.repo.recordFailure(clanTag);
    s.failed++;
  }
}
