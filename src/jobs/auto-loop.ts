// Nightly 03:20 UTC: run the campaigns whose auto-optimise interval has come
// due. Deliberately after creative top-up (02:10) so the two AI jobs never
// contend for quota. Port of extensions/baasix-schedule-auto-loop.
import { runDueLoops } from "../lib/auto-optimize.js";
import type { JobCtx } from "./index.js";

export async function runAutoLoop(ctx: JobCtx): Promise<Record<string, any>> {
  return runDueLoops(ctx.db, ctx.env);
}
