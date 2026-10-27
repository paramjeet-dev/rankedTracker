# Metrics and error reporting

Each process logs one line per pool every 30 seconds:

```
[metrics] groups rps=7.9 (limit 8.0/8.0) ok=236 err=12 avg=412ms top=[server:500:unknownException x7 unavailable:-:html_body x5]
```

- `rps`: observed request starts per second in the window. `limit current/ceiling`: the pacer's present and
  configured rates. A current limit below the ceiling means the pool is backing off.
- `top`: the failure breakdown as `kind:status:reason`. This is the first place to look when errors appear.
- The same numbers are written to `tracking:metrics:<process>:<pool>` in Valkey for a future dashboard.

Gate transitions (`closed (...)`, `reopened (...)`) are logged by every process that uses a gate.
