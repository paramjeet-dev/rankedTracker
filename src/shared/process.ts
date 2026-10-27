import { createLogger, type Logger } from './logger.js';

export interface ProcessContext {
  name: string;
  /** Aborts on SIGINT/SIGTERM. Loops should check it and wind down. */
  signal: AbortSignal;
  log: Logger;
}

/**
 * Entrypoint wrapper shared by every process: graceful shutdown on Ctrl+C (second Ctrl+C forces exit),
 * and unhandled rejections are logged instead of silently killing a worker.
 */
export async function runProcess(name: string, main: (ctx: ProcessContext) => Promise<void>): Promise<void> {
  const log = createLogger(name);
  const ac = new AbortController();
  const stop = (sig: string) => {
    if (ac.signal.aborted) {
      log.warn(`${sig} again, forcing exit`);
      process.exit(1);
    }
    log.info(`${sig} received, stopping`);
    ac.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
  try {
    log.info('starting');
    await main({ name, signal: ac.signal, log });
    log.info('stopped');
  } catch (err) {
    if (!ac.signal.aborted) {
      log.error('fatal', err);
      process.exitCode = 1;
    }
  }
}
