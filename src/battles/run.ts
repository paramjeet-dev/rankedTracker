import type { APILeagueGroupList } from 'clashofclans.js';
import type { GroupStore } from '../groups/store.js';
import type { CallResult } from '../shared/clash.js';
import type { Logger } from '../shared/logger.js';
import { drain, pagedTargets } from '../shared/targets.js';
import type { BattlesRepo, CollectTarget, GroupStatus } from './repo.js';
import { collectCursor } from './repo.js';

export interface BattlesDeps {
  repo: BattlesRepo;
  store: Pick<GroupStore, 'store'>;
  fetchGroup: (t: CollectTarget, playerTag: string, signal: AbortSignal) => Promise<CallResult<APILeagueGroupList>>;
  log: Logger;
  signal: AbortSignal;
  pageSize: number;
  idleMs: number;
  /** Consecutive "not found" answers (with no success in between) after which the group is treated as no longer served. */
  maxConsecutiveNotFound?: number;
}

export interface BattlesStats {
  calls: number;
  complete: number;
  incomplete: number;
  pending: number;
  battlesInserted: number;
  paused: number;
  failed: number;
  dbErrors: number;
}

/**
 * Battle collection for finished seasons (see docs/battles.md). A group call returns the logs of one member and every
 * battle is in two logs, so members are fetched one at a time, most active first, and collection STOPS as soon as the
 * stored battles reach the roster's expected total. Progress is kept in the database (group_member.logs_fetched_at),
 * so a group interrupted by an outage or a failure resumes with the members still missing.
 */
export class BattleCollector {
  readonly stats: BattlesStats = { calls: 0, complete: 0, incomplete: 0, pending: 0, battlesInserted: 0, paused: 0, failed: 0, dbErrors: 0 };
  private readonly inProgress = new Set<string>();

  constructor(private readonly d: BattlesDeps) {}

  async run(workers: number): Promise<void> {
    await drain<CollectTarget>({
      workers,
      items: pagedTargets<CollectTarget>({
        label: 'battles',
        load: (after, limit) => this.d.repo.loadTargets(after, limit),
        cursorOf: collectCursor,
        pageSize: this.d.pageSize,
        idleMs: this.d.idleMs,
        signal: this.d.signal,
        log: this.d.log
      }),
      describe: (t) => `${t.groupTag}/${t.seasonId}`,
      label: 'battles',
      signal: this.d.signal,
      log: this.d.log,
      handle: async (t) => void (await this.processGroup(t)),
      onError: () => void this.stats.dbErrors++
    });
  }

  /** Returns the settled status, or null when the group was paused, failed or is already being collected. */
  async processGroup(t: CollectTarget): Promise<GroupStatus | null> {
    const key = collectCursor(t);
    if (this.inProgress.has(key)) return null; // a long group can still be running when the next pass offers it again
    this.inProgress.add(key);
    try {
      await this.d.repo.beginGroup(t);
      const visited: string[] = [];
      let notFound = 0;
      const maxNotFound = this.d.maxConsecutiveNotFound ?? 3;

      for (;;) {
        if (this.d.signal.aborted) return null;
        const member = await this.d.repo.nextMember(t, visited);
        if (!member) break;
        visited.push(member);

        const res = await this.d.fetchGroup(t, member, this.d.signal);
        if (res.ok) {
          notFound = 0;
          const stored = await this.d.store.store({ groupTag: t.groupTag, seasonId: t.seasonId, tierId: t.tierId }, member, res.value);
          this.stats.calls++;
          this.stats.battlesInserted += stored.battlesInserted;
          if (await this.d.repo.isCovered(t)) break;
          continue;
        }
        if (res.kind === 'unavailable' || res.kind === 'maintenance' || res.kind === 'auth' || res.kind === 'aborted') {
          this.stats.paused++; // not this group's fault: nothing is settled, it stays a target
          return null;
        }
        if (res.kind === 'not_found') {
          // One member can be missing, but several in a row mean the API no longer serves this group: stop instead of
          // spending a call on every remaining member (the group is settled as incomplete).
          if (++notFound >= maxNotFound) break;
          continue;
        }
        if (res.permanent) continue; // skip this member
        await this.d.repo.recordFailure(t); // transient: resume later from the members still missing
        this.stats.failed++;
        return null;
      }

      const status = await this.d.repo.finalize(t);
      this.stats[status]++;
      return status;
    } finally {
      this.inProgress.delete(key);
    }
  }
}
