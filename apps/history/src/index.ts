/** History worker: layer A. One call returns every season the player took part in. */
import { runWorker, cocGet, historyPath, parseHistory, saveHistory, envNum } from "@coc/core";
process.env.PROC_NAME ??= "history";

await runWorker({ name: "history", kinds: ["history"], concurrency: envNum("CONC_HISTORY", 100), rps: envNum("RPS_HISTORY", 15), prefetch: (j) => [{ path: historyPath(j.payload.tag), kind: "history", key: j.payload.tag }], handlers: {
  async history(job) {
    const tag: string = job.payload.tag;
    await saveHistory(tag, parseHistory(await cocGet(historyPath(tag), { kind: "history", key: tag })));
  } } });
