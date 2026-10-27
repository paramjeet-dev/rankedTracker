import type { Logger } from './logger.js';
import { sleep } from './util.js';

/**
 * Keyset-paginated target stream: ordered by key, resumes after the last key read, wraps to the start when a pass
 * finds nothing, and idles between passes. Pages load only when the workers have drained the previous one.
 * Items are tags (strings) by default; for composite targets pass cursorOf to say how to resume after an item.
 */
export async function* pagedTargets<T = string>(opts: {
  label: string;
  load: (afterKey: string, limit: number) => Promise<T[]>;
  cursorOf?: (item: T) => string;
  pageSize: number;
  idleMs: number;
  signal: AbortSignal;
  log: Logger;
}): AsyncGenerator<T> {
  const cursorOf = opts.cursorOf ?? ((item: T) => String(item));
  let cursor = '';
  while (!opts.signal.aborted) {
    let page: T[];
    try {
      page = await opts.load(cursor, opts.pageSize);
    } catch (err) {
      opts.log.error(`[${opts.label}] could not load targets`, err);
      if (!(await sleep(5_000, opts.signal))) return;
      continue;
    }
    if (page.length === 0) {
      cursor = '';
      if (!(await sleep(opts.idleMs, opts.signal))) return;
      continue;
    }
    cursor = cursorOf(page[page.length - 1] as T);
    for (const item of page) {
      if (opts.signal.aborted) return;
      yield item;
    }
  }
}

/**
 * Run `workers` loops over one shared async generator. Async generators serialise next() calls, so several
 * consumers can safely share one stream, and requests flow continuously instead of waiting for a page barrier.
 * A handler error (e.g. Postgres briefly down) is logged and counted; the worker pauses and carries on.
 */
export async function drain<T = string>(opts: {
  workers: number;
  items: AsyncGenerator<T>;
  handle: (item: T) => Promise<void>;
  describe?: (item: T) => string;
  label: string;
  signal: AbortSignal;
  log: Logger;
  onError?: () => void;
}): Promise<void> {
  const describe = opts.describe ?? ((item: T) => String(item));
  const loop = async () => {
    for (;;) {
      if (opts.signal.aborted) return;
      const next = await opts.items.next();
      if (next.done) return;
      try {
        await opts.handle(next.value);
      } catch (err) {
        opts.onError?.();
        opts.log.error(`[${opts.label}] ${describe(next.value)} failed`, err);
        if (!(await sleep(2_000, opts.signal))) return;
      }
    }
  };
  await Promise.all(Array.from({ length: opts.workers }, loop));
}
