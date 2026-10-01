// Run-history ledger for scheduled jobs. Port of the old lib/job-runs.js:
// every job is wrapped in recordRun so each run is recorded in `job_runs`
// (start → finish), and a silently dead schedule is visible as "no run since…"
// rather than being invisible.
//
// Recording never breaks the job itself: all ledger writes are best-effort.
import { desc, eq } from "drizzle-orm";
import { jobRuns } from "../db/schema/index.js";
import type { Db } from "../db/index.js";

const KEEP_RUNS = 200; // per job — enough history to be useful, small enough to never need pruning care

export type JobResult = Record<string, any>;

/**
 * Wrap a job function so each run is recorded. Returns whatever the job
 * returns, and re-throws on failure. A run that reported item failures is
 * recorded as failed (not a clean success) so partial failures stay visible.
 */
export async function recordRun<T extends JobResult>(
  db: Db,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = new Date();
  let id: string | null = null;
  try {
    const rows = await db
      .insert(jobRuns)
      .values({ name, status: "processing", startedAt: started })
      .returning({ id: jobRuns.id });
    id = rows[0]?.id ?? null;
  } catch {
    /* recording is best-effort — never let it stop the job */
  }
  try {
    const result = await fn();
    // Most jobs catch their own per-item errors and report a count rather
    // than throwing, so a run that reported failures must not be recorded
    // as a clean success — that would hide exactly what this ledger exists
    // to surface.
    const reported = Number((result as any)?.errors ?? (result as any)?.failed ?? 0) || 0;
    const status = reported > 0 ? "failed" : "completed";
    if (id) {
      await db
        .update(jobRuns)
        .set({
          status,
          finishedAt: new Date(),
          durationMs: Date.now() - started.getTime(),
          result: { ...(result || {}), durationMs: Date.now() - started.getTime() },
          ...(reported > 0
            ? { error: { message: `${reported} item${reported === 1 ? "" : "s"} failed during the run`, partial: true } }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, id))
        .catch(() => {});
    }
    void prune(db, name);
    return result;
  } catch (e) {
    if (id) {
      await db
        .update(jobRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: {
            message: (e as Error)?.message || String(e),
            stack: ((e as Error)?.stack || "").split("\n").slice(0, 4).join("\n"),
            durationMs: Date.now() - started.getTime(),
          },
          updatedAt: new Date(),
        })
        .where(eq(jobRuns.id, id))
        .catch(() => {});
    }
    throw e;
  }
}

/** Keep the history bounded; a schedule that runs every minute would otherwise grow forever. */
async function prune(db: Db, name: string): Promise<void> {
  try {
    const rows = await db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(eq(jobRuns.name, name))
      .orderBy(desc(jobRuns.startedAt))
      .limit(KEEP_RUNS + 50);
    for (const r of rows.slice(KEEP_RUNS)) {
      await db.delete(jobRuns).where(eq(jobRuns.id, r.id)).catch(() => {});
    }
  } catch {
    /* pruning is housekeeping, not correctness */
  }
}
