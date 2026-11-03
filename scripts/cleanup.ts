/** Repair the scope leak. Dry run: npm run cleanup   Apply job deletes: npm run cleanup -- --apply   Also delete out-of-scope data: --apply --purge-data */
import { cleanupOutOfScope, sql } from "@coc/core";
const apply = process.argv.includes("--apply"), purgeData = process.argv.includes("--purge-data");
const r = await cleanupOutOfScope({ apply, purgeData });
console.log(JSON.stringify(r, null, 1));
if (!apply) console.log("\n(dry run; nothing deleted)");
await sql.end();
