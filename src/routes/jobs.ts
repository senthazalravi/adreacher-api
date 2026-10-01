// Worker job run history + manual retry, polled by the admin UI.
//   GET  /workers/jobs?name=&status=&limit=
//   GET  /workers/jobs/:id
//   POST /workers/jobs/:id/retry   (re-runs the named job inline)
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { jobRuns } from "../db/schema/index.js";
import { HttpError } from "../lib/filter.js";
import { recordRun } from "../lib/job-runs.js";
import { JOBS, jobContext } from "../jobs/index.js";
import type { Env } from "../index.js";

const router = new Hono<{ Bindings: Env }>();

const publicRun = (r: Record<string, any>) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  durationMs: r.durationMs,
  result: r.result,
  error: r.error,
});

router.get("/workers/jobs", async (c) => {
  const db = getDb(c.env.DB);
  const name = c.req.query("name");
  const status = c.req.query("status");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const conds = [
    ...(name ? [eq(jobRuns.name, name)] : []),
    ...(status ? [eq(jobRuns.status, status as any)] : []),
  ];
  const rows = await db
    .select()
    .from(jobRuns)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(jobRuns.startedAt))
    .limit(limit);
  return c.json({ data: rows.map(publicRun), totalCount: rows.length });
});

router.get("/workers/jobs/:id", async (c) => {
  const db = getDb(c.env.DB);
  const row = (
    await db.select().from(jobRuns).where(eq(jobRuns.id, c.req.param("id"))).limit(1)
  )[0] as unknown as Record<string, any> | undefined;
  if (!row) throw new HttpError(404, "Job run not found", "NOT_FOUND");
  return c.json({ data: publicRun(row) });
});

router.post("/workers/jobs/:id/retry", async (c) => {
  const db = getDb(c.env.DB);
  const row = (
    await db.select().from(jobRuns).where(eq(jobRuns.id, c.req.param("id"))).limit(1)
  )[0] as unknown as Record<string, any> | undefined;
  if (!row) throw new HttpError(404, "Job run not found", "NOT_FOUND");
  const def = JOBS[row.name];
  if (!def) throw new HttpError(400, `Unknown job "${row.name}"`, "UNKNOWN_JOB");
  const ctx = jobContext(c.env);
  const result = await recordRun(ctx.db, row.name, () => def.run(ctx));
  return c.json({ data: { retried: row.name, result } });
});

export default router;
