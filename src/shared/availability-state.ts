/** Shared contract between the availability controller (writer) and every gate (readers). */
export const AVAILABILITY_KEY = 'tracking:clash_availability';
export const EVENTS_STREAM = 'tracking:events';

export interface AvailabilityState {
  /** Whether Clash requests should run right now. */
  available: boolean;
  /** True when the outage is official Clash maintenance rather than a proxy/network problem. */
  maintenance: boolean;
  /** Short machine-readable cause while unavailable (maintenance | unavailable | auth). */
  reason?: string;
  /** When the current state began (epoch ms). Preserved across failed probes. */
  since: number;
  /** Written on every probe (epoch ms). A gate only reopens on a heartbeat newer than its own closure. */
  heartbeat: number;
}
