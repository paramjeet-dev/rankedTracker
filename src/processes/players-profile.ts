import { PgProfileRepo, type ProfilePool } from '../profile/repo.js';
import { PlayersProfile } from '../profile/run.js';
import { createClashClient, ClashGateway } from '../shared/clash.js';
import { config, poolConfig } from '../shared/config.js';
import { createPg } from '../shared/db.js';
import { AvailabilityGate } from '../shared/gate.js';
import { Metrics, startMetricsReporter } from '../shared/metrics.js';
import { Pacer } from '../shared/pacer.js';
import { runProcess } from '../shared/process.js';
import { loadScope } from '../shared/scope.js';
import { asKv, createValkey } from '../shared/valkey.js';

const POOL_NAMES: Record<ProfilePool, string> = { new: 'players-profile-new', refresh: 'players-profile-refresh' };

/** See docs/players-profile.md. */
void runProcess('players-profile', async ({ signal, log }) => {
  const pg = createPg();
  const valkey = createValkey();
  const scope = await loadScope(pg);
  const repo = new PgProfileRepo(pg, {
    minTier: scope.min,
    maxTier: scope.max,
    seasonSeconds: config.seasonSeconds
  });

  const problem = await repo.sanityProblem();
  if (problem) throw new Error(problem);

  // One visit is two calls, so these budgets are calls per second (about half as many players per second).
  const budgets = {
    new: poolConfig(POOL_NAMES.new, { rps: 12, maxInFlight: 24 }),
    refresh: poolConfig(POOL_NAMES.refresh, { rps: 4, maxInFlight: 8 })
  };
  const pacers = {
    [POOL_NAMES.new]: new Pacer({ rps: budgets.new.rps, maxInFlight: budgets.new.maxInFlight }),
    [POOL_NAMES.refresh]: new Pacer({ rps: budgets.refresh.rps, maxInFlight: budgets.refresh.maxInFlight })
  };

  const gate = new AvailabilityGate(valkey);
  gate.start();
  const metrics = new Metrics();
  const { client, relogin, close: stopKeys } = await createClashClient(asKv(valkey), signal);
  const gateway = new ClashGateway({ client, gate, metrics, pacers, relogin });
  const stopReporter = startMetricsReporter({ processName: 'players-profile', metrics, pacers, valkey });

  const profile = new PlayersProfile({
    repo,
    log,
    signal,
    pageSize: config.discovery.pageSize,
    idleMs: { new: 30_000, refresh: 10 * 60_000 },
    scope: { minTier: scope.min, maxTier: scope.max, historyScopeOnly: config.profile.historyScopeOnly },
    fetchPlayer: (pool, tag, sig) => gateway.call(POOL_NAMES[pool], (c) => c.rest.getPlayer(tag).then((r) => r.body), { signal: sig }),
    fetchHistory: (pool, tag, sig) =>
      gateway.call(POOL_NAMES[pool], (c) => c.rest.getLeagueHistory(tag).then((r) => r.body), { signal: sig })
  });

  const progress = setInterval(async () => {
    try {
      const [rn, rr] = await Promise.all([repo.countTargets('new'), repo.countTargets('refresh')]);
      const s = profile.stats;
      log.info(
        `remaining new=${rn} refresh=${rr} | new: visits=${s.new.visits} results=${s.new.resultsWritten} nameChanges=${s.new.nameChanges} ` +
          `failed=${s.new.failed} invalid=${s.new.invalid} outageSkips=${s.new.skippedOutage}`
      );
    } catch {
      /* progress is best effort */
    }
  }, 60_000);

  log.info(
    `new: ${budgets.new.rps} calls/s, ${budgets.new.maxInFlight} in flight; refresh: ${budgets.refresh.rps} calls/s, ` +
      `${budgets.refresh.maxInFlight}; history stored for in-scope tiers only: ${config.profile.historyScopeOnly}`
  );
  await Promise.all([profile.runPool('new', budgets.new.maxInFlight), profile.runPool('refresh', budgets.refresh.maxInFlight)]);

  clearInterval(progress);
  stopReporter();
  gate.stop();
  stopKeys();
  valkey.disconnect();
  await pg.end();
});
