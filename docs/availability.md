# API availability and maintenance (`availability`)

## What this process is for

Gives every tracker one shared answer to "should Clash requests run now?". It distinguishes official Clash
maintenance from a proxy/network outage (including gateways that answer with an HTML page instead of JSON).

## When it runs

One `availability` process, continuously, probing every 15 seconds. Every Clash-using process also runs a light
local watcher (`AvailabilityGate`) that reads the shared state every 2 seconds.

## Probe and classification flow

```
client.getLocations({ limit: 1 })
  -> success                         : available
  -> 429 requestThrottled            : available (reachable but busy; the pacer slows down, not the gate)
  -> 503 / inMaintenance / 500 with a maintenance message : official maintenance
  -> 403 / accessDenied              : auth problem -> log in again and publish the new key set (at most every 20 s)
  -> HTML body, 502/504, network error, timeout            : proxy / network outage
```

The probe does not use the gateway, because the gateway waits on the gate this process is trying to open.

## How trackers survive before the controller notices

Any request that sees an unavailable error calls `gate.close()` on its own process immediately. Other workers
stop before starting their request. The gate reopens only after it sees a controller heartbeat that is newer
than its own closure and reports available.

If no controller heartbeat exists (process not running, Valkey down), the gate half-opens every 30 seconds and
lets live traffic act as the probe, so a stopped controller can never freeze the trackers permanently.

## Shared Valkey state

`tracking:clash_availability` (JSON) with `available`, `maintenance`, `reason`, `since`, `heartbeat`, and a
45-second TTL refreshed on every probe. Only the controller writes it. `since` is preserved across failed probes
so recovery measures the real outage duration.

On recovery the controller appends `availability.recovered` (`maintenance`, `durationMs`) to the
`tracking:events` stream.

## Interaction

```
availability --probe--> Clash locations endpoint
availability --SET EX 45--> tracking:clash_availability --poll--> AvailabilityGate in every process
any process sees outage first --> its local gate closes immediately
```

## Configuration

Probe interval (15 s) and state TTL (45 s) are code constants in `src/shared/config.ts`. Requires Valkey and the
Clash credentials (`CLASH_EMAIL`, `CLASH_PASSWORD`).

## Outages and restarts

If the controller restarts mid-outage, workers stay paused until a healthy heartbeat arrives (or the half-open
trial fires). Maintenance history is not stored. The ranked tracker has no war clocks, so the only recovery
action is the event.

## Key manager

This process is also the only one that logs in to the developer portal and publishes the API keys to Valkey; see
[keys.md](keys.md). Start it first.

## What it deliberately does not do

- It does not write to PostgreSQL.
- It does not retry on behalf of workers or shift any schedules.
- It does not make an independent retry loop in every worker.
