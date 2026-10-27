# Valkey keys and events

All keys use the `tracking:` prefix. Valkey is run with append-only persistence; do not flush it while queues
hold work.

| Key | Type | Writer | Purpose |
| --- | --- | --- | --- |
| `tracking:clash_availability` | string (JSON), TTL 45 s | availability | gate state |
| `tracking:events` | stream, trimmed to ~10,000 | availability (more later) | cross-process events, e.g. `availability.recovered` |
| `tracking:metrics:<process>:<pool>` | hash | each process | latest per-pool metrics (observed rps, errors, latency) |
| `tracking:battles:queue` | sorted set, no expiry | groups (planned) | deduplicated battle/group handoff to the battles process |
