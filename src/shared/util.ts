/** Sleep that resolves early when the signal aborts. Returns false if aborted, true if the time elapsed. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with +/-25% jitter. attempt is 1-based. */
export function backoffMs(attempt: number, baseMs = 1_500, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

/**
 * Wrap an async function so concurrent callers share one in-flight run, and calls within
 * minIntervalMs of the last completed run are skipped. Used for re-login so 30 workers that
 * all see a 403 trigger one login, not 30.
 */
export function singleFlight(fn: () => Promise<void>, minIntervalMs = 0): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let lastFinished = 0;
  return () => {
    if (inFlight) return inFlight;
    if (Date.now() - lastFinished < minIntervalMs) return Promise.resolve();
    inFlight = fn().finally(() => {
      lastFinished = Date.now();
      inFlight = null;
    });
    return inFlight;
  };
}
