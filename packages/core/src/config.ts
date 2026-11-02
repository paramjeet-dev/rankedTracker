export const cfg = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://coc:coc@localhost:5432/coc",
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:8787",
  gatewaySecret: process.env.GATEWAY_SECRET ?? "",
  rawDir: process.env.RAW_DIR ?? "./data/raw",
  rawRetentionDays: Number(process.env.RAW_RETENTION_DAYS ?? 30),
  memberlogDepth: Number(process.env.MEMBERLOG_DEPTH ?? 1), // 0..1 coverage dial: share of each group's members whose log is fetched
};
export const envNum = (k: string, d: number) => Number(process.env[k] ?? d);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const log = (proc: string, ...a: unknown[]) => console.log(new Date().toISOString(), `[${proc}]`, ...a);
