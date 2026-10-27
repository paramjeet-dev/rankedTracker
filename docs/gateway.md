# Request gateway (`src/shared`)

## What it is for

The single door to the Clash API for every process. It replaces the 32-worker retry loop.

## Request path

```
gate.waitOpen -> pacer.acquire (in-flight permit + evenly spaced start slot) -> fn(client)
  -> success : pacer.onSuccess, metrics
  -> failure : classifyError -> metrics (kind:status:reason) -> decide
```

## Failure handling

| Kind | Examples | Gate | Retried | Counts against entity |
| --- | --- | --- | --- | --- |
| unavailable | HTML body (`Unexpected token '<'`), 502/504, ECONNRESET | closes | after reopen, up to `maxGateRetries` (5) | no |
| maintenance | 503 inMaintenance | closes | same | no |
| auth | 403 accessDenied.invalidIp | closes, triggers re-login | same | no |
| throttled | 429 | open, rate halves | backoff, up to `maxAttempts` (4) | yes |
| timeout | aborted, headers/body timeout | open, rate halves | backoff | yes |
| server | 500 unknownException, truncated JSON | open | backoff | yes |
| not_found / bad_request / forbidden | 404, 400, privateWarLog | open | never | permanent |

`call()` never throws. It returns `{ ok: true, value }` or `{ ok: false, kind, permanent, message }`.
A non-permanent failure means: leave the entity in its target set; the next scan picks it up.

## Why the HTML errors were opaque

clashofclans.js parses the body (`res.body.json()`) before it checks the status, so a gateway HTML page surfaces
as a bare `SyntaxError` with no status. The classifier recognises that signature and treats it as an outage.
`kind:status:reason` counters in the metrics show the breakdown.

## Client settings that matter

- `restRequestTimeout` is set (15 s). The library default of 0 means a hung connection waits forever.
- `retryLimit: 0`. The library's own retry re-logs-in on every 403 invalid-IP, which with many workers means many
  simultaneous logins. Re-login is done once, single-flight, at most once per minute.

## Pacing

Request starts are spaced `1000/rps` ms apart, with an in-flight cap per pool. A pressure signal (429, timeout,
HTML outage) halves the pool's rate down to a floor. Every 50 consecutive successes raise it by 5% of the
configured ceiling. Config: `POOL_<NAME>_RPS`, `POOL_<NAME>_MAX_IN_FLIGHT`.
