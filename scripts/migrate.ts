/** Apply pending SQL migrations (packages/db/migrations) in order. Needed once Postgres no longer runs in Docker (no docker-entrypoint-initdb). Safe to re-run.
 *  An existing database created by the Docker entrypoint (001-004 already applied) is detected and baselined. */
import fs from "node:fs";
import { sql } from "@coc/core";

const dir = "packages/db/migrations";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
const [{ existing }] = await sql<{ existing: boolean }[]>`select to_regclass('public.job') is not null as existing`;
if (applied.size === 0 && existing) { // legacy database: 001-004 are already in
  for (const f of files.filter((f) => f <= "004_diagnostics.sql")) { await sql`insert into schema_migrations (name) values (${f}) on conflict do nothing`; applied.add(f); }
  console.log("baselined existing database through 004_diagnostics.sql");
}
for (const f of files) {
  if (applied.has(f)) continue;
  console.log("applying", f);
  await sql.begin(async (tx) => { await tx.unsafe(fs.readFileSync(`${dir}/${f}`, "utf8")); await tx`insert into schema_migrations (name) values (${f})`; });
}
console.log("migrations up to date");
await sql.end();
