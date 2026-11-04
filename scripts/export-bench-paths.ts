/** Writes bench-paths.json (real group request paths) for scripts/bench-vps.mjs: npm run bench:export */
import fs from "node:fs";
import { sql, groupPath } from "@coc/core";
import { currentSeasonId } from "@coc/shared";
const prev = currentSeasonId() - 604800;
const g = await sql<{ group_tag: string; probe_player_tag: string }[]>`select group_tag, probe_player_tag from league_group where season_id = ${prev} and roster_fetched_at is not null order by random() limit 100`;
fs.writeFileSync("bench-paths.json", JSON.stringify(g.map((x) => groupPath(x.group_tag, prev, x.probe_player_tag))));
console.log(`wrote bench-paths.json with ${g.length} paths`); await sql.end();
