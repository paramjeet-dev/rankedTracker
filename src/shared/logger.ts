export interface Logger {
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
}

export function createLogger(tag: string): Logger {
  const line = (level: string, msg: string) => `${new Date().toISOString()} ${level.padEnd(5)} [${tag}] ${msg}`;
  return {
    info: (msg, ...extra) => console.log(line('INFO', msg), ...extra),
    warn: (msg, ...extra) => console.warn(line('WARN', msg), ...extra),
    error: (msg, ...extra) => console.error(line('ERROR', msg), ...extra)
  };
}
