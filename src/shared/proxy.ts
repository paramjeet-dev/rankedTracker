import 'dotenv/config';
import { ProxyAgent, Socks5ProxyAgent, fetch, interceptors, setGlobalDispatcher, type Dispatcher } from 'undici';
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

/** CLASH_COMPRESSION=false turns response compression off (default on: the API serves gzip, which is ~10x smaller). */
export function compressionEnabled(): boolean {
  return process.env['CLASH_COMPRESSION']?.trim().toLowerCase() !== 'false';
}

const ACCEPT_ENCODING = 'gzip, deflate';

function withAcceptEncoding(headers: unknown): unknown {
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    return { 'accept-encoding': ACCEPT_ENCODING, ...(headers as Record<string, unknown>) };
  }
  return headers;
}

let announced = false;

/**
 * Prepares how this process talks to the Clash API. Two independent things, both done by replacing the one object the
 * library sends API requests through (`requestHandler.dispatcher`, a connection pool bound to api.clashofclans.com):
 *  - compression: ask for gzip and unpack it before the library reads the JSON (the API supports it; JSON shrinks a lot);
 *  - proxy (OUTBOUND_PROXY_URL): send the requests, and the developer-portal requests that use the global fetch
 *    dispatcher (login, key list, key create, IP check), through a proxy with a fixed IP.
 * Returns what was enabled; with neither, nothing is changed.
 */
export function applyClashTransport(client: Client, opts: { ignoreProxy?: boolean } = {}): { proxy: boolean; compression: boolean } {
  const url = opts.ignoreProxy ? null : proxyUrl();
  const compression = compressionEnabled();
  if (!url && !compression) return { proxy: false, compression: false };

  const handler = client.rest.requestHandler as unknown as { dispatcher?: unknown };
  if (!('dispatcher' in handler)) {
    throw new Error('Unsupported clashofclans.js version: no request dispatcher to wrap');
  }

  let base: Dispatcher;
  let origin: string | undefined;
  if (url) {
    base = dispatcherFor(url);
    setGlobalDispatcher(base); // portal login and key management
    origin = API_ORIGIN;       // a proxy dispatcher is not bound to one origin, the library's pool is
  } else {
    base = handler.dispatcher as Dispatcher; // the library's own pool, already bound to the API origin
  }
  const target = compression ? base.compose(interceptors.decompress()) : base;

  handler.dispatcher = {
    request: (opts: Record<string, unknown>) =>
      target.request({
        ...opts,
        ...(origin ? { origin } : {}),
        ...(compression ? { headers: withAcceptEncoding(opts['headers']) } : {})
      } as Dispatcher.RequestOptions),
    close: () => base.close(),
    destroy: () => base.destroy()
  };
  if (!announced) {
    announced = true;
    log.info(`Clash transport: proxy ${url ? describeProxy(url) : 'off'}, compression ${compression ? 'on' : 'off'}`);
  }
  return { proxy: !!url, compression };
}

/** The public IP Clash will see, through the proxy when one is configured. */
export async function egressIp(timeoutMs = 10_000): Promise<string> {
  const url = proxyUrl();
  if (url) setGlobalDispatcher(dispatcherFor(url));
  const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(timeoutMs) });
  return (await res.text()).trim();
}
