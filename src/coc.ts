import 'dotenv/config';
import { Client } from 'clashofclans.js';

export const client = new Client();

/** Call once at startup. The library fetches or creates API keys for the current IP. */
export async function loginCoc() {
  await client.login({
    email: process.env.COC_EMAIL!,
    password: process.env.COC_PASSWORD!
  });
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
