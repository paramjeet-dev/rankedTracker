/** Manually seed players (e.g. your own tag or clanmates in Titan..Electro): npm run add-seed -- #TAG1 #TAG2 */
import { sql, enqueueMany } from "@coc/core";
import { normalizeTag } from "@coc/shared";
const tags = process.argv.slice(2).map(normalizeTag);
if (!tags.length) { console.log("usage: npm run add-seed -- #TAG1 #TAG2 ..."); process.exit(1); }
for (const t of tags) await sql`insert into player (tag) values (${t}) on conflict do nothing`;
await enqueueMany(tags.flatMap((t) => [{ kind: "profile", dedupeKey: t, payload: { tag: t }, priority: 1 }, { kind: "history", dedupeKey: t, payload: { tag: t }, priority: 2 }]));
console.log(`queued ${tags.length} seed player(s)`); await sql.end();
