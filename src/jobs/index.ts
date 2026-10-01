// Shared plumbing for scheduled jobs (Phase 7): job context, the paused-
// account helper, and the name → handler registry used by the cron dispatcher
// and the /workers/jobs retry endpoint.
import type { R2Bucket } from "@cloudflare/workers-types";
import { inArray } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import { tenants } from "../db/schema/index.js";
import type { Env } from "../index.js";
import { recordRun } from "../lib/job-runs.js";
import { runAnalyticsSync } from "./analytics-sync.js";
import { runAutoLoop } from "./auto-loop.js";
import { runConnectionHealth } from "./connection-health.js";
import { runCreativeTopup } from "./creative-topup.js";
import { runPostPublisher } from "./post-publisher.js";

export interface JobCtx {
  db: Db;
  env: Record<string, string | undefined>;
  secretKey: string;
  r2: R2Bucket;
}

/** Build the context every job needs from the Worker env. */
export function jobContext(env: Env): JobCtx {
  const secretKey = env.SECRET_KEY;
  if (!secretKey) throw new Error("SECRET_KEY is not configured — jobs cannot decrypt platform tokens");
  return {
    db: getDb(env.DB),
    env: env as unknown as Record<string, string | undefined>,
    secretKey,
    r2: env.R2,
  };
}

/** Account ids whose tenants are suspended or closed — jobs must not spend or act for them. */
export async function pausedAccountIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.status, ["suspended", "closed"]));
  return new Set(rows.map((r) => r.id));
}

export interface JobDef {
  /** 5-field cron expression (Workers Cron Triggers). */
  cron: string;
  /** Human description for the admin UI. */
  description: string;
  run: (ctx: JobCtx) => Promise<Record<string, any>>;
}

export const JOBS: Record<string, JobDef> = {
  "analytics-sync": {
    cron: "0 */6 * * *",
    description: "Every 6h: pull 7-day insights for live/paused/publishing/failed platform campaigns.",
    run: runAnalyticsSync,
  },
  "auto-loop": {
    cron: "20 3 * * *",
    description: "Nightly 03:20 UTC: run due auto-optimise loops (after creative top-up).",
    run: runAutoLoop,
  },
  "connection-health": {
    cron: "17 * * * *",
    description: "Hourly: refresh expiring tokens, flip healthy→expiring→expired, notify owners.",
    run: runConnectionHealth,
  },
  "creative-topup": {
    cron: "10 2 * * *",
    description: "Nightly 02:10 UTC: top up the Approve queue to 6 pending for active AI workspaces.",
    run: runCreativeTopup,
  },
  "post-publisher": {
    cron: "* * * * *",
    description: "Every minute: publish due scheduled posts (retry backoff in lib).",
    run: runPostPublisher,
  },
};

const CRON_TO_JOB: Record<string, string> = Object.fromEntries(
  Object.entries(JOBS).map(([name, def]) => [def.cron, name]),
);

/** Job name for a cron expression, or undefined if none is registered. */
export function jobNameForCron(cron: string): string | undefined {
  return CRON_TO_JOB[cron];
}

/** Dispatch a cron trigger to the right job, wrapped in recordRun. */
export async function dispatchCron(cron: string, env: Env): Promise<void> {
  const name = jobNameForCron(cron);
  if (!name) {
    console.warn(`[cron] no job registered for schedule "${cron}"`);
    return;
  }
  const ctx = jobContext(env);
  const def = JOBS[name];
  if (!def) {
    console.warn(`[cron] no job registered for schedule "${cron}"`);
    return;
  }
  try {
    const result = await recordRun(ctx.db, name, () => def.run(ctx));
    console.info(`[cron:${name}] ${JSON.stringify(result)}`);
  } catch (e) {
    console.error(`[cron:${name}] failed:`, (e as Error)?.message || e);
  }
}
