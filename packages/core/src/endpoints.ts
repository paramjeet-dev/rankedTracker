import { encodeTag } from "@coc/shared";
export const playerPath = (tag: string) => `/v1/players/${encodeTag(tag)}`;
export const historyPath = (tag: string) => `/v1/players/${encodeTag(tag)}/leaguehistory`;
/** VERIFY against the official docs: the user says playerTag must accompany group tag + season id; query-param form assumed. */
export const groupPath = (groupTag: string, seasonId: number, playerTag: string) =>
  `/v1/leaguegroup/${encodeURIComponent(groupTag)}/${seasonId}?playerTag=${encodeTag(playerTag)}`;
export const locationsPath = () => `/v1/locations?limit=1000`;
export const rankingsPath = (loc: string | number, after?: string) =>
  `/v1/locations/${loc}/rankings/players?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`;
