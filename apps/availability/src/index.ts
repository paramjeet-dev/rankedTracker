/** Availability controller: probes /locations?limit=1 every 15s, publishes shared state; workers keep local gates.
 *  Official maintenance flips state at once; a proxy/tunnel failure needs 3 consecutive failed probes (one stalled probe on a busy tunnel is not an outage). */
import { probe, sql, sleep, log } from "@coc/core";
process.env.PROC_NAME ??= "availability";
let since = Date.now(), state: "ok" | "maintenance" | "proxy_down" = "ok", fails = 0;
for (;;) {
  const r = await probe();
  let next: "ok" | "maintenance" | "proxy_down" = state;
  if (r === "proxy_down") { fails++; if (fails >= 3) next = "proxy_down"; } else { fails = 0; next = r; }
  if (next !== state) { since = Date.now(); log("availability", `${state} -> ${next}`); state = next; }
  const value = { available: state === "ok", maintenance: state === "maintenance", since: new Date(since).toISOString() };
  await sql`insert into system_state (key, value, updated_at) values ('clash_availability', ${sql.json(value)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  await sleep(15_000);
}
