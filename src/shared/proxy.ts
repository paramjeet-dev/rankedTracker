import 'dotenv/config';
import { ProxyAgent, Socks5ProxyAgent, fetch, setGlobalDispatcher, type Dispatcher } from 'undici';
import type { Client } from 'clashofclans.js';
import { createLogger } from './logger.js';

const log = createLogger('proxy');

/** The API host the library talks to; its own connection pool is bound to this origin. */
const API_ORIGIN = 'https://api.clashofclans.com';

/**
 * OUTBOUND_PROXY_URL sends every request to the Clash API and to the developer portal (login, key list) through a
 * proxy, so Clash always sees the proxy's IP instead of this machine's. Keys are tied to one IP; with a proxy on a
 * server with a fixed address they stay valid when the home IP changes.
 *
 *   socks5://127.0.0.1:1080   SOCKS5, e.g. `ssh -D 127.0.0.1:1080 user@vps`   (undici marks this as experimental)
 *   http://127.0.0.1:8888     HTTP CONNECT proxy, e.g. tinyproxy behind `ssh -L`
 *
 * Postgres and Valkey connections are plain sockets and are never affected.
 */
export function proxyUrl(): string | null {
  const raw = process.env['OUTBOUND_PROXY_URL']?.trim();
  return raw ? raw : null;
}

export function buildDispatcher(url: string): Dispatcher {
  const u = new URL(url);
  if (u.protocol === 'socks5:' || u.protocol === 'socks:') return new Socks5ProxyAgent(url);
  if (u.protocol === 'http:' || u.protocol === 'https:') return new ProxyAgent({ uri: url });
  throw new Error(`OUTBOUND_PROXY_URL must start with socks5://, http:// or https:// (got ${u.protocol})`);
}

/** Never log credentials that may be part of the proxy URL. */
export function describeProxy(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
}

let installed: { url: string; d: Dispatcher } | null = null;

function dispatcherFor(url: string): Dispatcher {
  if (installed?.url !== url) installed = { url, d: buildDispatcher(url) };
  return installed.d;
}

/**
 * Routes this process's Clash traffic through the proxy. The library uses two paths and both must go through it:
 *  1. login / key list / key create / IP check use the global fetch dispatcher;
 *  2. API requests use a connection pool the library builds for api.clashofclans.com (replaced here).
 * Returns false when no proxy is configured (nothing changes).
 */
export function applyOutboundProxy(client: Client): boolean {
  const url = proxyUrl();
  if (!url) return false;
  const d = dispatcherFor(url);
  setGlobalDispatcher(d);

  const handler = client.rest.requestHandler as unknown as { dispatcher?: unknown };
  if (!('dispatcher' in handler)) {
    throw new Error('Unsupported clashofclans.js version: no request dispatcher to route through the proxy');
  }
  // The library only calls dispatcher.request({ path, ... }) on a pool bound to one origin; add the origin.
  handler.dispatcher = {
    request: (opts: Record<string, unknown>) => d.request({ ...opts, origin: API_ORIGIN } as Dispatcher.RequestOptions),
    close: () => d.close(),
    destroy: () => d.destroy()
  };
  log.info(`routing Clash traffic through ${describeProxy(url)}`);
  return true;
}

/** The public IP Clash will see, through the proxy when one is configured. */
export async function egressIp(timeoutMs = 10_000): Promise<string> {
  const url = proxyUrl();
  if (url) setGlobalDispatcher(dispatcherFor(url));
  const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(timeoutMs) });
  return (await res.text()).trim();
}
