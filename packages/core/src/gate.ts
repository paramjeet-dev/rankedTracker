/** Process-local request gate, fed by the shared availability state (mirrors ClashKingTracking's design). */
import { sql } from "./db.js";
import { sleep } from "./config.js";

let closedAt: number | null = null;
let remote: { available: boolean; maintenance: boolean; updatedAt: number } | null = null;

/** Any request wrapper that sees an outage closes this process's gate immediately. */
export const closeLocal = () => { if (closedAt === null) closedAt = Date.now(); };

async function poll() {
  try {
    const [r] = await sql<{ value: any; updated_at: Date }[]>`select value, updated_at from system_state where key = 'clash_availability'`;
    remote = r ? { available: !!r.value.available, maintenance: !!r.value.maintenance, updatedAt: r.updated_at.getTime() } : null;
  } catch { /* DB blip: keep last known */ }
}
let started = false;
export function startGateWatcher() {
  if (started) return; started = true;
  void poll(); setInterval(poll, 5000).unref();
}

export function isOpen(): boolean {
  const fresh = remote !== null && Date.now() - remote.updatedAt < 45_000; // controller heartbeat TTL
  if (closedAt !== null) {
    // reopen only after a healthy heartbeat NEWER than the local closure
    if (fresh && remote!.available && remote!.updatedAt > closedAt) closedAt = null; else return false;
  }
  if (fresh && !remote!.available) return false;
  return true; // stale/unknown state fails open; real errors still close the local gate
}
export async function waitOpen() { while (!isOpen()) await sleep(1000); }
