import postgres from "postgres";
import { cfg, envNum } from "./config.js";
export const sql = postgres(cfg.databaseUrl, { max: envNum("PG_POOL", 12), onnotice: () => {}, idle_timeout: 30 });
