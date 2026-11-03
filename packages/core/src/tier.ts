import { sql } from "./db.js";
import { cocGet } from "./client.js";
import { historyPath } from "./endpoints.js";
import { parseHistory } from "./parse.js";
import { saveHistory } from "./ingest.js";

/** Tier the player was in during an ENDED season (history excludes the ongoing one). Fetches history once if we don't have it yet. */
export async function tierOfPlayerSeason(tag: string, seasonId: number): Promise<number | null> {
  const q = async () => { const [r] = await sql<{ tier_id: number }[]>`select tier_id from player_season where player_tag = ${tag} and season_id = ${seasonId}`; return r ? Number(r.tier_id) : null; };
  const have = await q(); if (have !== null) return have;
  await saveHistory(tag, parseHistory(await cocGet(historyPath(tag), { kind: "history", key: tag })));
  return q();
}
