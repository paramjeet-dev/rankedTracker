import type { APILeagueGroupList } from 'clashofclans.js';
import type { CallResult } from '../shared/clash.js';
import type { Logger } from '../shared/logger.js';
import { drain, pagedTargets } from '../shared/targets.js';
import type { GroupTarget, GroupsRepo } from './repo.js';
import { targetCursor } from './repo.js';
import type { GroupStore, StoreResult } from './store.js';

export interface GroupsDeps {
  repo: GroupsRepo;
  store: Pick<GroupStore, 'store'>;
  fetchGroup: (t: GroupTarget, signal: AbortSignal) => Promise<CallResult<APILeagueGroupList>>;
  log: Logger;
  signal: AbortSignal;
  pageSize: number;
  idleMs: number;
}

export interface GroupsStats {
  registered: number;
  battlesInserted: number;
  gone: number;
  failed: number;
  skippedOutage: number;
  dbErrors: number;
}

/**
 * Group registration (see docs/groups.md): one call per group the tracker has heard of but not stored. The response
 * holds the whole roster and the battle logs of one member, and all of it is stored. Collecting the remaining
 * members' logs after the season is the `battles` process.
 */
export class GroupsRegistrar {
  readonly stats: GroupsStats = { registered: 0, battlesInserted: 0, gone: 0, failed: 0, skippedOutage: 0, dbErrors: 0 };

  constructor(private readonly d: GroupsDeps) {}

  async run(workers: number): Promise<void> {
    await drain<GroupTarget>({
      workers,
      items: pagedTargets<GroupTarget>({
        label: 'groups',
        load: (after, limit) => this.d.repo.loadTargets(after, limit),
        cursorOf: targetCursor,
        pageSize: this.d.pageSize,
        idleMs: this.d.idleMs,
        signal: this.d.signal,
        log: this.d.log
      }),
      describe: (t) => `${t.groupTag}/${t.seasonId}`,
      label: 'groups',
      signal: this.d.signal,
      log: this.d.log,
      handle: async (t) => void (await this.processTarget(t)),
      onError: () => void this.stats.dbErrors++
    });
  }

  async processTarget(t: GroupTarget): Promise<StoreResult | null> {
    const res = await this.d.fetchGroup(t, this.d.signal);
    if (res.ok) {
      const stored = await this.d.store.store({ groupTag: t.groupTag, seasonId: t.seasonId, tierId: t.tierId }, t.playerTag, res.value);
      this.stats.registered++;
      this.stats.battlesInserted += stored.battlesInserted;
      return stored;
    }
    if (res.kind === 'unavailable' || res.kind === 'maintenance' || res.kind === 'auth' || res.kind === 'aborted') {
      this.stats.skippedOutage++; // not this group's fault: it stays a target
      return null;
    }
    if (res.permanent) {
      await this.d.repo.markGone(t);
      this.stats.gone++;
      return null;
    }
    await this.d.repo.recordFailure(t);
    this.stats.failed++;
    return null;
  }
}
