# Gateway mode: ClashKingProxy on the VPS

[ClashKingProxy](https://github.com/ClashKingInc/ClashKingProxy) (MIT, Go, one small binary) is a reverse proxy that holds
a list of API keys, adds one of them to each request (round robin) and forwards `/v1/*` to `api.clashofclans.com`. It passes
gzip through and keeps `/stats` (request counts, status codes, latency). It does **not** raise any Clash rate limit: the
limit is still whatever your keys allow.

## Why use it here

1. **The keys never change.** They are created once, in the developer portal, for the VPS address. Your home IP can
   change as often as it likes. `availability` no longer logs in, so the login/revoke churn is gone.
2. **Much lower latency than the SOCKS tunnel.** TLS to Clash ends on the VPS (about 10 ms from Amazon), and the PC talks
   plain HTTP over a few long-lived SSH forwards (one round trip per request). Through SOCKS every new connection did a TLS
   handshake across the ocean (about 1.4 s). Lower latency means the same number of in-flight requests finishes more
   requests per second.
3. **Gzip still works** end to end (the proxy passes `Accept-Encoding: gzip` and `Content-Encoding` through).
4. `/stats` on the proxy shows exactly what Clash returned (look for 429).

Do **not** point this project at the public `proxy.clashk.ing`: a multi-million-call crawl would load someone else's
service. Run your own.

## 1. Keys (once)

Developer portal, one account:

1. Delete the old keys (an account holds at most 10), for example the ones named `clashofclans.js.keys`.
2. Get the VPS address: on the VPS run `curl -4 -s https://api.ipify.org`.
3. Create 10 keys named `coc-tracker-vps` with **Allowed IP addresses = that address**. Copy the 10 tokens.

## 2. The proxy on the VPS

Keep the keys in a file only root can read, one line, comma separated, no quotes:

    sudo nano /etc/coc-proxy.env          # COC_KEYS=token1,token2,...,token10
    sudo chmod 600 /etc/coc-proxy.env

**Option A, Docker on the VPS** (publishes the port on the loopback address only):

    git clone https://github.com/ClashKingInc/ClashKingProxy.git && cd ClashKingProxy
    docker build -t clashking-proxy .
    docker run -d --name coc-proxy --restart unless-stopped -p 127.0.0.1:8011:8011 --env-file /etc/coc-proxy.env clashking-proxy

**Option B, no Docker on the VPS.** Build on your PC (Docker Desktop) and copy the binary. Use `GOARCH=arm64` if
`uname -m` on the VPS says `aarch64`:

    git clone https://github.com/ClashKingInc/ClashKingProxy.git; cd ClashKingProxy
    docker run --rm -v "${PWD}:/src" -w /src -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 golang:1.26.5-alpine go build -o proxy .
    scp proxy YOUR_USER@VPS_IP:/tmp/proxy

On the VPS:

    sudo mkdir -p /opt/coc-proxy && sudo mv /tmp/proxy /opt/coc-proxy/proxy && sudo chmod 755 /opt/coc-proxy/proxy
    sudo tee /etc/systemd/system/coc-proxy.service >/dev/null <<'UNIT'
    [Unit]
    Description=Clash API key-rotating proxy
    After=network-online.target

    [Service]
    DynamicUser=yes
    EnvironmentFile=/etc/coc-proxy.env
    Environment=HOST=127.0.0.1
    Environment=PORT=8011
    ExecStart=/opt/coc-proxy/proxy
    Restart=always
    MemoryMax=100M

    [Install]
    WantedBy=multi-user.target
    UNIT
    sudo systemctl daemon-reload && sudo systemctl enable --now coc-proxy

Test on the VPS: `curl -s "http://127.0.0.1:8011/v1/locations?limit=1" | head -c 200` must print JSON.

**The proxy has no login of its own.** Anyone who can reach its port can spend your keys. Keep it on `127.0.0.1` (above)
and reach it only through the SSH forward below. Never publish the port.

## 3. The tunnel from the PC

In `/home/cocproxy/.ssh/authorized_keys` on the VPS (the user from `docs/proxy.md`), the key line becomes (one line):

    restrict,port-forwarding,permitopen="127.0.0.1:8011" ssh-ed25519 AAAA...

PowerShell, keep it open:

    powershell -ExecutionPolicy Bypass -File scripts\tunnel-gateway.ps1 -Server YOUR_VPS_IP

## 4. Configure and check

`.env` on the PC:

    CLASH_BASE_URL=http://127.0.0.1:8011/v1

`CLASH_EMAIL`, `CLASH_PASSWORD`, `CLASH_KEY_COUNT` and `OUTBOUND_PROXY_URL` are not used in this mode. Then:

    npm run egress

must show `API call through the gateway: HTTP 200 ... (keys are valid)`. Start `availability` first (it now only probes),
then the others. Each process logs `gateway mode: Clash requests go to http://127.0.0.1:8011/v1`.

If the keys on the VPS are rejected (403), the gate closes and stays closed until a probe succeeds. There is nothing to
re-login: fix the keys in the portal and `COC_KEYS`, then `sudo systemctl restart coc-proxy` (or `docker restart coc-proxy`).

## 5. Rates

Measure on the proxy, not on a guess: `Invoke-RestMethod http://127.0.0.1:8011/stats` shows request counts and status codes
per rolling window. Any 429 means the keys are being pushed too hard: lower the rates by about 20%.

The throttle you observed was 25 to 30 requests per second per key, which is about 250 to 300 in total for 10 keys. Stay
well under it (about 15 per key = 150 in total) and raise in steps of 30%, 15 minutes apart, while `/stats` stays clean and
Postgres keeps up (`docker stats`).

**Backlog preset** (about 150 requests/s; in-flight caps are about 2x the rate because a request now takes about 0.5 s):

| pool | `_RPS` | `_MAX_IN_FLIGHT` |
|---|---|---|
| `POOL_PLAYERS_DISCOVERY_NEW` | 20 | 40 |
| `POOL_PLAYERS_DISCOVERY_REFRESH` | 2 | 6 |
| `POOL_GROUPS` | 20 | 50 |
| `POOL_PLAYERS_PROFILE_NEW` | 60 | 120 |
| `POOL_PLAYERS_PROFILE_REFRESH` | 6 | 12 |
| `POOL_BATTLES` | 40 | 100 (`BATTLES_WORKERS=32`) |

**Steady preset** (about 30 requests/s, enough for the weekly refresh and the battle collection after each rollover):

| pool | `_RPS` | `_MAX_IN_FLIGHT` |
|---|---|---|
| `POOL_PLAYERS_DISCOVERY_NEW` | 3 | 8 |
| `POOL_PLAYERS_DISCOVERY_REFRESH` | 1 | 3 |
| `POOL_GROUPS` | 4 | 10 |
| `POOL_PLAYERS_PROFILE_NEW` | 4 | 10 |
| `POOL_PLAYERS_PROFILE_REFRESH` | 8 | 16 |
| `POOL_BATTLES` | 10 | 30 |

The `new` pools go idle by themselves when their backlog is empty, so the switch to the steady preset is just editing
these numbers and restarting the processes.

If Postgres becomes the limit (high CPU or disk wait in `docker stats` while the API is not throttling), this setting
makes commits much cheaper on Docker for Windows. The cost: a crash can lose the last fraction of a second of commits,
which this project re-collects anyway because every step is repeatable:

    docker compose exec db psql -U coc -d coc -c "ALTER SYSTEM SET synchronous_commit = off;" -c "SELECT pg_reload_conf();"

## Going back

Remove `CLASH_BASE_URL` from `.env` and restart everything. Without it the processes log in again (or use
`OUTBOUND_PROXY_URL`, see `docs/proxy.md`).
