// Usage metering for AI generations. Port of the old lib/usage.js
// checkAndIncrement (plan-limit enforcement + counter increment).
//
// The entitlement comes from the plan (see lib/limits.ts); when the plan has
// no entitlement for the metric, usage is recorded but not capped (billing
// proper is Phase 6).
import { and, eq } from "drizzle-orm";
import { usageCounters } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { PlanLimitError, getPlanEntitlements } from "./limits.js";

function monthPeriod(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Usage-counter metric keys (snake_case) → plan entitlement keys (camelCase).
 * The old backend's /billing/usage mapped these; checkAndIncrement must use
 * the same mapping or plan caps silently never apply.
 */
const METRIC_ENTITLEMENT: Record<string, string> = {
  ai_generations: "aiGenerations",
  brand_crawls: "brandCrawlsPerMonth",
  scheduled_posts: "scheduledPostsPerMonth",
};

const entitlementFor = (entitlements: Record<string, any>, metricKey: string): number | null => {
  const raw = entitlements[METRIC_ENTITLEMENT[metricKey] ?? metricKey];
  return raw == null ? null : Number(raw);
};

/**
 * Charge `n` units of `metricKey` against the account's plan. Throws
 * 402/PLAN_LIMIT_REACHED when the entitlement is exhausted.
 */
export async function checkAndIncrement(
  db: Db,
  { accountId, workspaceId, metricKey, n = 1 }: { accountId: string; workspaceId?: string | null; metricKey: string; n?: number },
): Promise<{ count: number; limit: number | null }> {
  const { start, end } = monthPeriod();
  const { entitlements, planSlug } = await getPlanEntitlements(db, accountId);
  const limit = entitlementFor(entitlements, metricKey);

  const rows = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.account_id, accountId), eq(usageCounters.metricKey, metricKey), eq(usageCounters.periodStart, start)));
  const row = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  const current = Number(row?.count || 0);

  if (limit !== null && current + n > limit) {
    throw new PlanLimitError(
      { metric: metricKey, limit, current, entitlement: metricKey, plan: planSlug },
      `Your plan allows ${limit} ${metricKey} per month; upgrade for more.`,
    );
  }

  const next = current + n;
  if (row) {
    await db.update(usageCounters).set({ count: next, updatedAt: new Date() }).where(eq(usageCounters.id, row.id));
  } else {
    await db.insert(usageCounters).values({
      metricKey,
      periodStart: start,
      periodEnd: end,
      count: next,
      limitValue: limit,
      workspace_id: workspaceId || null,
      account_id: accountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return { count: next, limit };
}

/**
 * Record `n` units of a flow metric without enforcing a cap (storage bytes,
 * uploads — running totals the plan may not cap). Negative `n` decrements.
 * Keyed by (account_id, metric, month period) like checkAndIncrement.
 */
export async function recordUsage(
  db: Db,
  { accountId, workspaceId, metricKey, n = 1 }: { accountId: string; workspaceId?: string | null; metricKey: string; n?: number },
): Promise<{ count: number }> {
  const { start, end } = monthPeriod();
  const rows = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.account_id, accountId), eq(usageCounters.metricKey, metricKey), eq(usageCounters.periodStart, start)));
  const row = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  const next = Number(row?.count || 0) + n;
  if (row) {
    await db.update(usageCounters).set({ count: next, updatedAt: new Date() }).where(eq(usageCounters.id, row.id));
  } else {
    await db.insert(usageCounters).values({
      metricKey,
      periodStart: start,
      periodEnd: end,
      count: next,
      limitValue: null,
      workspace_id: workspaceId || null,
      account_id: accountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return { count: next };
}
