import { PgDiscoveryRepo, type DiscoveryPool } from '../discovery/repo.js';
import { PlayersDiscovery } from '../discovery/run.js';
import { createClashClient, ClashGateway } from '../shared/clash.js';
import { config, poolConfig } from '../shared/config.js';
import { createPg } from '../shared/db.js';
import { AvailabilityGate } from '../shared/gate.js';
import { Metrics, startMetricsReporter } from '../shared/metrics.js';
import { Pacer } from '../shared/pacer.js';
import { runProcess } from '../shared/process.js';
import { sleep } from '../shared/util.js';
import { loadScope } from '../shared/scope.js';
import { createValkey } from '../shared/valkey.js';

const POOL_NAMES: Record<DiscoveryPool, string> = { new: 'players-discovery-new', refresh: 'players-discovery-refresh' };

/** See docs/players-discovery.md. */
void runProcess('players-discovery', async ({ signal, log }) => {
  const pg = createPg();
  const valkey = createValkey();
  const scope = await loadScope(pg);
  const repo = new PgDiscoveryRepo(pg, {
    minTier: scope.min,
    maxTier: scope.max,
    refreshDays: config.discovery.refreshDays
  });

  const problem = await repo.tagFormatProblem();
  if (problem) throw new Error(problem);

  const budgets = {
    new: poolConfig(POOL_NAMES.new, { rps: 10, maxInFlight: 20 }),
    refresh: poolConfig(POOL_NAMES.refresh, { rps: 2, maxInFlight: 4 })
  };
  const pacers = {
    [POOL_NAMES.new]: new Pacer({ rps: budgets.new.rps, maxInFlight: budgets.new.maxInFlight }),
    [POOL_NAMES.refresh]: new Pacer({ rps: budgets.refresh.rps, maxInFlight: budgets.refresh.maxInFlight })
  };

  const gate = new AvailabilityGate(valkey);
  gate.start();
  const metrics = new Metrics();
  const { client, relogin } = await createClashClient();
  const gateway = new ClashGateway({ client, gate, metrics, pacers, relogin });
  const stopReporter = startMetricsReporter({ processName: 'players-discovery', metrics, pacers, valkey });

  const discovery = new PlayersDiscovery({
    repo,
    log,
    signal,
    pageSize: config.discovery.pageSize,
    idleMs: { new: 30_000, refresh: 10 * 60_000 },
    fetchClan: (pool, tag, sig) => gateway.call(POOL_NAMES[pool], (c) => c.rest.getClan(tag).then((r) => r.body), { signal: sig })
  });

  // Progress line: remaining targets and a completion estimate for the "new" pool.
  const progress = setInterval(async () => {
    try {
      const remaining = await repo.countTargets('new');
      const s = discovery.stats.new;
      log.info(
        `[new] remaining=${remaining} clansOk=${s.clansOk} playersInserted=${s.playersInserted} tierUpdates=${s.tierUpdates} ` +
          `failed=${s.failed} invalid=${s.invalid} outageSkips=${s.skippedOutage}`
      );
    } catch {
      /* progress is best effort */
    }
  }, 60_000);

  log.info(
    `new: ${budgets.new.rps} rps / ${budgets.new.maxInFlight} in flight; refresh: ${budgets.refresh.rps} rps / ${budgets.refresh.maxInFlight}; ` +
      `scope tiers ${scope.min}-${scope.max} (league_tier.in_scope)`
  );
  await Promise.all([discovery.runPool('new', budgets.new.maxInFlight), discovery.runPool('refresh', budgets.refresh.maxInFlight)]);

  clearInterval(progress);
  stopReporter();
  gate.stop();
  await sleep(0);
  valkey.disconnect();
  await pg.end();
});
