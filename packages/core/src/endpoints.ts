import { encodeTag } from "@coc/shared";
export const playerPath = (tag: string) => `/v1/players/${encodeTag(tag)}`;
export const historyPath = (tag: string) => `/v1/players/${encodeTag(tag)}/leaguehistory`;
export const locationsPath = () => `/v1/locations?limit=1000`;
export const rankingsPath = (loc: string | number, after?: string) =>
  `/v1/locations/${loc}/rankings/players?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`;

/**
 * The group endpoint needs league group tag + season id + a player tag, but HOW the player tag is passed is unverified.
 * `npm run smoke` tries every style below against an in-scope player and tells you which one answers 200; set GROUP_STYLE to it.
 */
export const GROUP_STYLES: Record<string, (g: string, s: number, p: string) => string> = {
  playerTag: (g, s, p) => `/v1/leaguegroup/${encodeURIComponent(g)}/${s}?playerTag=${encodeTag(p)}`,
  tag: (g, s, p) => `/v1/leaguegroup/${encodeURIComponent(g)}/${s}?tag=${encodeTag(p)}`,
  player: (g, s, p) => `/v1/leaguegroup/${encodeURIComponent(g)}/${s}?player=${encodeTag(p)}`,
  path: (g, s, p) => `/v1/leaguegroup/${encodeURIComponent(g)}/${s}/${encodeTag(p)}`,
  none: (g, s) => `/v1/leaguegroup/${encodeURIComponent(g)}/${s}`,
};
export const groupPath = (g: string, s: number, p: string) => (GROUP_STYLES[process.env.GROUP_STYLE ?? "playerTag"] ?? GROUP_STYLES.playerTag)(g, s, p);
