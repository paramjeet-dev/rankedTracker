import 'dotenv/config';
import { Client, BatchThrottler } from 'clashofclans.js';

// Up to 10 keys (developer portal limit). The library rotates through them request by request.
const KEY_COUNT = Math.min(Math.max(Number(process.env.COC_KEY_COUNT ?? 1), 1), 10);
// Requests per second PER KEY. Exact API limit is not documented; 20 is a conservative start.
// Total allowed rate = RATE_PER_KEY * KEY_COUNT, shared by all workers.
const RATE_PER_KEY = Number(process.env.COC_RATE_PER_KEY ?? 20);

export const client = new Client({ throttler: new BatchThrottler(RATE_PER_KEY * KEY_COUNT) });

/** Call once at startup. The library fetches or creates API keys for the current IP. */
export async function loginCoc() {
  await client.login({
    email: process.env.COC_EMAIL!,
    password: process.env.COC_PASSWORD!,
    keyCount: KEY_COUNT
  });
  console.log(`API login ok: ${KEY_COUNT} key(s), throttle ${RATE_PER_KEY * KEY_COUNT} req/s`);
}

/** Raw API profile body (includes current/previous leagueGroupTag and leagueSeasonId). */
export async function getProfileRaw(playerTag: string) {
  const { body } = await client.rest.getPlayer(playerTag);
  return body;
}

/**
 * clashofclans.js getLeagueGroup() cannot send the player tag the official API requires,
 * so we reuse the library's request handler (auth, key rotation, throttling, retries)
 * with our own path.
 */
export async function getLeagueGroupForPlayer(groupTag: string, seasonId: string | number, playerTag: string) {
  const param = process.env.LEAGUE_GROUP_PLAYER_PARAM ?? 'playerTag';
  const qs = new URLSearchParams({ [param]: playerTag }).toString();
  const path = `/leaguegroup/${encodeURIComponent(groupTag)}/${seasonId}?${qs}`;
  const res = await client.rest.requestHandler.request(path, { cache: false });
  return res.body as import('clashofclans.js').APILeagueGroupList;
}
