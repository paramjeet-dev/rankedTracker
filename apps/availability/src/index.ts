/** Availability controller: probes /locations?limit=1 every 15s, publishes shared state; workers keep local gates. */
import { probe, sql, sleep, log } from "@coc/core";
process.env.PROC_NAME ??= "availability";
let since = Date.now(), last = "ok";
for (;;) {
  const r = await probe();
  if (r !== last) { since = Date.now(); log("availability", `${last} -> ${r}`); last = r; }
  const value = { available: r === "ok", maintenance: r === "maintenance", since: new Date(since).toISOString() };
  await sql`insert into system_state (key, value, updated_at) values ('clash_availability', ${sql.json(value)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  await sleep(15_000);
}
