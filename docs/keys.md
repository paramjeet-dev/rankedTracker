# API keys (`availability` is the only process that logs in)

## The problem this solves

`clashofclans.js` `login()` does three things against the developer portal: it reads the IP the portal sees, it
**revokes every key with the same key name whose IP differs from that one**, and it creates keys up to the requested
count (the account maximum is 10). With one login per process, any inconsistency in the IP seen by two logins makes
the processes revoke each other's keys in a loop. Symptoms: `403 accessDenied` everywhere, `Key #n is no longer
valid. Removed from the key list`, `failed to create 1 more key(s)`, and the portal answering `Temporary application
error` when several logins arrive at once.

## The design

- `availability` is the **key manager**. It logs in (retrying with backoff while the portal is unhappy) and publishes
  the key set to Valkey as `tracking:clash_keys` (`{ version, keys, publishedAt }`, no expiry). Versions keep
  increasing across restarts.
- Every other process is a **key follower**. It never touches the developer portal. It waits for the first key set,
  builds its client from it (`new Client({ keys })`), and swaps keys in place with `requestHandler.setKeys()` when a
  newer version appears (checked every 2 s).
- When a request gets `403` (keys rejected), the process closes its own gate, writes `tracking:clash_keys_refresh`
  (`{ seenVersion }`), and waits for a newer version. The manager serves requests within a second: a request from a
  process that is already behind is ignored (newer keys exist), otherwise it logs in once, whatever the number of
  processes asking, and at most once per 20 seconds. The process then reopens its gate and retries the request.
- An "own keys" closure is not ended by a healthy controller heartbeat (the controller's keys say nothing about this
  process's keys). It ends when the keys were swapped, or after 60 s as a safety net.
- Keys are never logged. They sit in Valkey, which `docker-compose.valkey.yml` binds to 127.0.0.1.

## Modes

`CLASH_KEYS_MODE=shared` (default) as above. `CLASH_KEYS_MODE=login` makes a process log in by itself (the old
behaviour); only safe when it is the only process using the account.

## If the IP itself keeps changing

One login owner stops the processes from fighting each other, but it cannot make the API accept a key from an IP it
was not created for. If your public IP changes every few minutes (some mobile and carrier-grade NAT connections do),
the manager will log in again each time, and every process pauses briefly while it does. The fix for that is a stable
egress IP (a small VPS), or a proxy that has one. Check with:

```powershell
1..12 | % { (curl.exe -s https://api.ipify.org); Start-Sleep 5 }
```

One address repeated 12 times means a stable IP. More than one address means unstable.

## Operations

- Start `availability` first; wait for `published key set v1 (N keys)`. The others wait for it and say so.
- Keys on the account that are not used (other names, old IPs) count toward the limit of 10. If you see
  `failed to create ... key(s)`, delete the unused ones at developer.clashofclans.com.
- Restarting `availability` logs in again and publishes a new version; the others pick it up on their own.
