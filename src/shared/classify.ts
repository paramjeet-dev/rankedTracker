/**
 * Turns whatever the Clash client throws into a decision.
 *
 * Why this exists: clashofclans.js calls `res.body.json()` before it looks at the status code, so when a
 * gateway/WAF answers with an HTML page the caller only sees `SyntaxError: Unexpected token '<'` and never
 * learns the HTTP status. Real API errors arrive as `HttpError` with `status` and `reason`
 * (notFound, accessDenied.invalidIp, requestThrottled, inMaintenance, unknownException, ...).
 */
export type FailureKind =
  | 'unavailable' // gateway/proxy/network down or an HTML body: close the gate, never blame the entity
  | 'maintenance' // official Clash maintenance: close the gate
  | 'auth' // key/IP rejected: close the gate and re-login
  | 'throttled' // 429: slow down and retry
  | 'timeout' // request aborted or timed out: retry, slow down
  | 'server' // 500-class or truncated body: retry with backoff, counts against the entity
  | 'not_found' // permanent
  | 'bad_request' // permanent
  | 'forbidden' // permanent (e.g. private war log)
  | 'aborted' // caller cancelled
  | 'unknown';

export interface Classified {
  kind: FailureKind;
  status?: number;
  reason?: string;
  message: string;
  /** Do not retry; the entity itself is the problem. */
  permanent: boolean;
  /** Close the shared gate; every worker should pause until a healthy heartbeat. */
  closesGate: boolean;
  /** Evidence the API is overloaded: the pacer should cut its rate. */
  pressure: boolean;
}

const HTML_BODY = /<html|<!doctype|<head|Unexpected token '?<'?/i;
const TRUNCATED_BODY = /Unexpected end of JSON|Unterminated string|Expected .* in JSON|JSON input/i;
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED'
]);
const TIMEOUT_CODES = new Set(['UND_ERR_ABORTED', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

function make(kind: FailureKind, base: { status?: number; reason?: string; message: string }): Classified {
  const permanent = kind === 'not_found' || kind === 'bad_request' || kind === 'forbidden' || kind === 'aborted';
  const closesGate = kind === 'unavailable' || kind === 'maintenance' || kind === 'auth';
  const pressure = kind === 'throttled' || kind === 'timeout' || kind === 'unavailable';
  return { kind, permanent, closesGate, pressure, ...base };
}

export function classifyError(err: unknown): Classified {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const message = String(e['message'] ?? err ?? '');
  const status = typeof e['status'] === 'number' ? (e['status'] as number) : undefined;
  const reason = typeof e['reason'] === 'string' ? (e['reason'] as string) : undefined;
  const name = typeof e['name'] === 'string' ? (e['name'] as string) : '';
  const cause = (typeof e['cause'] === 'object' && e['cause'] !== null ? e['cause'] : {}) as Record<string, unknown>;
  const code =
    typeof e['code'] === 'string' ? (e['code'] as string) : typeof cause['code'] === 'string' ? (cause['code'] as string) : undefined;
  const base = { message, ...(status !== undefined && { status }), ...(reason !== undefined && { reason }) };

  // 1. Typed API errors (HttpError): status/reason are authoritative.
  if (reason === 'inMaintenance' || status === 503) return make('maintenance', base);
  if (reason === 'privateWarLog') return make('forbidden', base);
  if (status === 403 || reason?.startsWith('accessDenied')) return make('auth', base);
  if (status === 429 || reason === 'requestThrottled') return make('throttled', base);
  if (status === 404 || reason === 'notFound' || reason === 'notInWar') return make('not_found', base);
  if (status === 400 || reason === 'badRequest') return make('bad_request', base);
  if (status === 408 || reason === 'requestAborted') return make('timeout', base);
  if (status === 502 || status === 504 || (status !== undefined && status >= 520 && status <= 530)) {
    return make('unavailable', base);
  }
  if (status !== undefined && status >= 500) {
    return make(/maintenance/i.test(message) ? 'maintenance' : 'server', base);
  }

  // 2. No status: the failure happened before or while reading the body.
  if (HTML_BODY.test(message)) return make('unavailable', { ...base, reason: 'html_body' });
  if (name === 'SyntaxError' || TRUNCATED_BODY.test(message)) return make('server', { ...base, reason: 'truncated_body' });
  if (code !== undefined && NETWORK_CODES.has(code)) return make('unavailable', { ...base, reason: code });
  if (/fetch failed/i.test(message)) return make('unavailable', base);
  if ((code !== undefined && TIMEOUT_CODES.has(code)) || name === 'AbortError' || name === 'TimeoutError') {
    return make('timeout', base);
  }
  return make('unknown', base);
}

/** Stable key for the "what exactly is failing" breakdown in metrics. */
export function errorKey(c: Classified): string {
  return `${c.kind}:${c.status ?? '-'}:${c.reason ?? '-'}`;
}
