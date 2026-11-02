/** History worker: layer A. One call returns every season the player took part in. */
import { runWorker, cocGet, historyPath, parseHistory, saveHistory, envNum } from "@coc/core";
process.env.PROC_NAME ??= "history";

await runWorker({ name: "history", kinds: ["history"], concurrency: envNum("CONC_HISTORY", 20), rps: envNum("RPS_HISTORY", 20), handlers: {
  async history(job) {
    const tag: string = job.payload.tag;
    await saveHistory(tag, parseHistory(await cocGet(historyPath(tag), { kind: "history", key: tag })));
  } } });
