/** Repair/trim the queue.
 *   npm run cleanup                                  dry run (out-of-scope groups + profile backlog)
 *   npm run cleanup -- --apply                       delete queued jobs of out-of-scope groups
 *   npm run cleanup -- --apply --purge-data          also delete stored data of out-of-scope groups
 *   npm run cleanup -- --trim-profiles [--apply]     keep only 8 queued profile jobs per group (PROFILES_PER_GROUP)
 */
import { cleanupOutOfScope, trimProfileQueue, sql, envNum } from "@coc/core";
const apply = process.argv.includes("--apply"), purgeData = process.argv.includes("--purge-data");
if (process.argv.includes("--trim-profiles")) console.log(JSON.stringify(await trimProfileQueue(envNum("PROFILES_PER_GROUP", 8), apply)));
else console.log(JSON.stringify(await cleanupOutOfScope({ apply, purgeData }), null, 1));
if (!apply) console.log("\n(dry run; nothing deleted)");
await sql.end();
