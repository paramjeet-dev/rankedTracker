# Sending Clash traffic through a VPS (fixed IP)

API keys are tied to one IP address. When the home IP changes, every key is rejected (`accessDenied.invalidIp`) and
`availability` keeps logging in again, each login revoking keys made for another address. Routing all Clash traffic through
a server with a fixed IP removes the problem: the PC's own IP no longer matters.

## How it works

`OUTBOUND_PROXY_URL=socks5://127.0.0.1:1080` makes every process send two kinds of requests through the proxy:
the developer portal (login, key list, key create) and the API itself (`api.clashofclans.com`). Postgres and Valkey are
not affected. The proxy is an SSH tunnel to the VPS (`ssh -D`), so the VPS needs nothing installed except the SSH server it
already has. `src/shared/proxy.ts` is the code; `test/proxy.test.ts` tests it against fake SOCKS5 and HTTP proxies, and it
was also tested against a real OpenSSH tunnel (1000 concurrent requests, restricted key, tunnel killed mid-run).

`socks5://` uses undici's SOCKS5 support, which undici marks as experimental (you will see one warning per process).
`http://127.0.0.1:8888` (an HTTP proxy such as tinyproxy behind `ssh -L`) also works and is the older, more mature path,
but tinyproxy uses a process per connection, which is heavy on a 1 GB server.

## What it costs the VPS

- RAM and CPU: one `sshd` process for the tunnel plus encryption of the traffic. Small.
- **Traffic**: every response from Supercell is downloaded by the VPS and sent on to your PC. Profiles and group
  responses are tens of KB each, so at 50 to 100 requests per second this can be several MB/s, which is hundreds of GB a
  day. Check the transfer allowance of your plan, and measure (step 7) before leaving it running.

## 1. On the VPS (once)

A dedicated user whose key can only open connections to the three Clash hosts. It cannot run commands or reach anything
else on the server (your other services are untouched).

    sudo adduser --disabled-password --gecos "" cocproxy
    sudo mkdir -p /home/cocproxy/.ssh
    sudo nano /home/cocproxy/.ssh/authorized_keys      # paste the one line from step 2 (leave this open)
    sudo chown -R cocproxy:cocproxy /home/cocproxy/.ssh
    sudo chmod 700 /home/cocproxy/.ssh && sudo chmod 600 /home/cocproxy/.ssh/authorized_keys

**IPv4 only.** Keys are made for one address. If the VPS has IPv6 and the Clash hosts have IPv6 addresses, the login and the
API calls could leave from different families and be rejected. Check:

    getent ahosts api.clashofclans.com | head
    ip -6 addr show scope global

If both show IPv6, make the server prefer IPv4: `echo 'precedence ::ffff:0:0/96  100' | sudo tee -a /etc/gai.conf`
(takes effect for new connections; restart `sshd` with `sudo systemctl restart ssh` to be sure).

## 2. On the PC (PowerShell, once)

    ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\coc_proxy" -N '""'
    Get-Content "$env:USERPROFILE\.ssh\coc_proxy.pub"

Copy that line. The `authorized_keys` line on the VPS is (one line, then the key you copied):

    restrict,port-forwarding,permitopen="api.clashofclans.com:443",permitopen="developer.clashofclans.com:443",permitopen="api.ipify.org:443" ssh-ed25519 AAAA... 

## 3. Configure

In `.env`:

    OUTBOUND_PROXY_URL=socks5://127.0.0.1:1080

## 4. Start the tunnel (keep this window open)

    powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Server YOUR_VPS_IP

It reconnects by itself if the connection drops. Add `-Port 2222` if your SSH server is not on port 22.

## 5. Check it

    npm run egress

must print your **VPS address**, not your home address. If it fails, the tunnel is not running.

## 6. Switch over

1. Stop every process (`availability`, `discovery`, `profile`, `groups`, `battles`) and any old crawler.
2. In the developer portal delete all keys named `clashofclans.js.keys` (frees the stale slot).
3. Start the tunnel, run `npm run egress`.
4. Start `availability`. It logs `egress IP (what Clash sees): <VPS IP> via proxy`, then `published key set ... (10 keys)`,
   and then stays quiet. The portal now lists keys for the VPS address.
5. Start `groups`, `battles`, `profile`, `discovery` one at a time.

## 7. Measure the traffic

On the VPS, note the counters, wait ten minutes of crawling, read them again:

    cat /proc/net/dev | grep -E 'eth0|ens|enp'      # bytes received / transmitted per interface

Bytes sent in ten minutes x 144 = bytes per day. If that is above your plan, lower the `POOL_*_RPS` values.

## When the tunnel drops

Requests fail with a network error (`ECONNREFUSED`), which the classifier treats as an outage: the gate closes, workers
pause, nothing is marked failed or invalid, and work resumes when the tunnel is back. The PC's IP can change at any time
without effect.

## Going back

Remove `OUTBOUND_PROXY_URL` from `.env`, stop everything, and start `availability` first. It logs in from the home address
and the keys for the VPS address are revoked automatically.
