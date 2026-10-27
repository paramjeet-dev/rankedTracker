import { AVAILABILITY_KEY, EVENTS_STREAM } from '../shared/availability-state.js';
import { createLoginClient } from '../shared/clash.js';
import { config } from '../shared/config.js';
import { AvailabilityController } from '../shared/controller.js';
import { runProcess } from '../shared/process.js';
import { sleep } from '../shared/util.js';
import { asKv, createValkey } from '../shared/valkey.js';

/**
 * See docs/availability.md and docs/keys.md. Two jobs:
 *  1. probe the API and publish whether requests should run (the shared gate state);
 *  2. be the ONLY process that logs in to the developer portal: it publishes the API keys to Valkey and logs in again
 *     when a process reports that its keys are rejected.
 * Start this process first; every other process waits for its keys.
 */
void runProcess('availability', async ({ signal, log }) => {
  const valkey = createValkey();
  const { client, manager } = await createLoginClient(asKv(valkey), true, signal);

  const controller = new AvailabilityController({
    probe: () => client.getLocations({ limit: 1 }),
    relogin: () => manager.relogin('probe was rejected'),
    publish: async (state) => {
      await valkey.set(AVAILABILITY_KEY, JSON.stringify(state), 'EX', config.availability.stateTtlSeconds);
    },
    emit: async (type, fields) => {
      await valkey.xadd(EVENTS_STREAM, 'MAXLEN', '~', 10_000, '*', 'type', type, ...Object.entries(fields).flat().map(String));
    }
  });

  // Serve "my keys are rejected" requests from the other processes within a second.
  const refreshLoop = (async () => {
    while (!signal.aborted) {
      try {
        await manager.pollRefresh();
      } catch (err) {
        log.warn(`key refresh failed, will retry: ${(err as Error).message.slice(0, 160)}`);
      }
      if (!(await sleep(1_000, signal))) break;
    }
  })();

  log.info(`probing every ${config.availability.probeIntervalMs / 1000}s`);
  while (!signal.aborted) {
    try {
      await controller.tick();
    } catch (err) {
      log.error('tick failed (state not published this round)', err);
    }
    if (!(await sleep(config.availability.probeIntervalMs, signal))) break;
  }
  await refreshLoop;
  valkey.disconnect();
});
