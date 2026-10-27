import { Redis } from 'ioredis';
import { config } from './config.js';
import { createLogger } from './logger.js';

/** Valkey is wire-compatible with Redis, so ioredis works unchanged. */
export function createValkey(url: string = config.valkeyUrl): Redis {
  const log = createLogger('valkey');
  let lastWarn = 0;
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 500, 5_000)
  });
  client.on('error', (err) => {
    // ioredis emits on every failed reconnect; log at most once per 30 seconds
    if (Date.now() - lastWarn > 30_000) {
      lastWarn = Date.now();
      log.warn(`connection problem: ${err.message}`);
    }
  });
  return client;
}
