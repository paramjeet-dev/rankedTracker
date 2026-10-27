# Tracking dossiers

Each dossier answers the same questions: what the process owns, how it selects targets, which Clash endpoint it
calls, what it writes, what it emits, and what it deliberately leaves to another process.

The processes stay separate so each workload can be started, stopped and observed independently. They share
PostgreSQL contracts, Valkey keys, and the availability gate. They do not share in-process state.

| Process | Dossier | Status |
| --- | --- | --- |
| Availability and maintenance | [availability.md](availability.md) | implemented |
| Request gateway (shared layer) | [gateway.md](gateway.md) | implemented |
| Player discovery | [players-discovery.md](players-discovery.md) | implemented (Phase B) |
| Player profiles and season history | [players-profile.md](players-profile.md) | implemented (Phase C) |
| League groups (registration) | [groups.md](groups.md) | implemented (Phase D) |
| Battle collection after the season | [battles.md](battles.md) | implemented (Phase E) |
| Scheduled work | [scheduled.md](scheduled.md) | folded into the processes |
| Mapping from the old crawler | [legacy-mapping.md](legacy-mapping.md) | reference |
| Valkey keys and events | [events.md](events.md) | implemented |
| Metrics and error reporting | [observability.md](observability.md) | implemented |

## Rules every process follows

1. **Every Clash call goes through `ClashGateway.call(pool, fn)`.** Never call the client directly.
2. **Targets are a query, not a queue.** A catalogue table plus a cursor ordered by tag. State columns
   (`next_attempt_at`, `fail_count`) replace job rows.
3. **A transient failure leaves the entity in its target set.** It is retried on the next scan. One bad entity
   never stalls the rest.
4. **A permanent failure (404, 400, private) is recorded on the entity**, never retried blindly.
5. **Outages are not the entity's fault.** Gateway, maintenance and auth errors close the shared gate and do not
   increase `fail_count`.
6. **Writes are idempotent and change-detected.** Only changed columns are written. Restarting at any point is safe.
7. **Rate is a request-start budget per pool**, not a worker count (`POOL_<NAME>_RPS`, `POOL_<NAME>_MAX_IN_FLIGHT`).
