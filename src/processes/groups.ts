import { PgGroupsRepo } from '../groups/repo.js';
import { GroupsRegistrar } from '../groups/run.js';
import { GroupStore } from '../groups/store.js';
import { createClashClient, ClashGateway } from '../shared/clash.js';
import { config, poolConfig } from '../shared/config.js';
import { createPg } from '../shared/db.js';
import { AvailabilityGate } from '../shared/gate.js';
import { Metrics, startMetricsReporter } from '../shared/metrics.js';
import { Pacer } from '../shared/pacer.js';
import { runProcess } from '../shared/process.js';
import { loadScope } from '../shared/scope.js';
import { asKv, createValkey } from '../shared/valkey.js';

/** See docs/groups.md. */
void runProcess('groups', async ({ signal, log }) => {
  const pg = createPg();
  const valkey = createValkey();
  const scope = await loadScope(pg);
  const repo = new PgGroupsRepo(pg, { minTier: scope.min, maxTier: scope.max, seasonSeconds: config.seasonSeconds });

  const problem = await repo.sanityProblem();
  if (problem) throw new Error(problem);

  const budget = poolConfig('groups', { rps: 8, maxInFlight: 16 });
  const pacers = { groups: new Pacer({ rps: budget.rps, maxInFlight: budget.maxInFlight }) };

  const gate = new AvailabilityGate(valkey);
  gate.start();
  const metrics = new Metrics();
  const { client, relogin, close: stopKeys } = await createClashClient(asKv(valkey), signal);
  const gateway = new ClashGateway({ client, gate, metrics, pacers, relogin });
  const stopReporter = startMetricsReporter({ processName: 'groups', metrics, pacers, valkey });

  const registrar = new GroupsRegistrar({
    repo,
    log,
    signal,
    store: new GroupStore(pg, config.seasonSeconds),
    pageSize: config.discovery.pageSize,
    idleMs: 60_000,
    fetchGroup: (t, sig) =>
      gateway.call('groups', (c) => c.rest.getLeagueGroup(t.groupTag, t.seasonId, { playerTag: t.playerTag }).then((r) => r.body), { signal: sig })
  });

  const progress = setInterval(async () => {
    try {
      const remaining = await repo.countTargets();
      const s = registrar.stats;
      log.info(
        `remaining=${remaining} registered=${s.registered} battlesInserted=${s.battlesInserted} ` +
          `gone=${s.gone} failed=${s.failed} outageSkips=${s.skippedOutage}`
      );
    } catch {
      /* progress is best effort */
    }
  }, 60_000);

  log.info(`${budget.rps} calls/s, ${budget.maxInFlight} in flight; scope tiers ${scope.min}-${scope.max} (league_tier.in_scope)`);
  await registrar.run(budget.maxInFlight);

  clearInterval(progress);
  stopReporter();
  gate.stop();
  stopKeys();
  valkey.disconnect();
  await pg.end();
});
