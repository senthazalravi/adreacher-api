// Plan-limit enforcement. Port of the old plan-limits hook:
// assertPlanAllows(kind, accountId) — throws 402/PLAN_LIMIT_REACHED with
// JSON { metric, limit, current, entitlement, plan } when the plan's
// entitlement is exhausted. Billing proper (trials, Stripe) is Phase 6;
// this only enforces the entitlement numbers.
import { and, count, eq, isNull } from "drizzle-orm";
import {
  subscriptionPlans,
  subscriptions,
  workspaces,
} from "../db/schema/index.js";
import { HttpError } from "./filter.js";
import type { Db } from "../db/index.js";

export class PlanLimitError extends HttpError {
  detail: Record<string, unknown>;
  constructor(detail: Record<string, unknown>, message?: string) {
    super(402, message || "Plan limit reached", "PLAN_LIMIT_REACHED");
    this.detail = detail;
  }
}

/** Subscription → plan entitlements, with per-subscription overrides winning. */
export async function getPlanEntitlements(
  db: Db,
  accountId: string,
): Promise<{ entitlements: Record<string, any>; planSlug: string | null }> {
  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.account_id, accountId));
  const active = subs.find((s) =>
    ["trialing", "active", "past_due"].includes(s.status as string),
  ) ?? subs[0];

  if (active?.plan_id) {
    const plans = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, active.plan_id as string));
    const plan = plans[0] as unknown as Record<string, any> | undefined;
    if (plan) {
      return {
        entitlements: {
          ...((plan.entitlements as Record<string, any>) || {}),
          ...((active.entitlementOverrides as Record<string, any>) || {}),
        },
        planSlug: plan.slug as string,
      };
    }
  }
  // No subscription yet — fall back to the seeded `trial` plan's entitlements
  // (see seedPlans in src/db/seed.ts / drizzle/seed-plans.sql). Registration
  // creates one default workspace, so the trial allows a couple more.
  const trialPlans = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.slug, "trial"))
    .limit(1);
  const trial = (trialPlans[0] as unknown as Record<string, any> | undefined) ?? null;
  if (trial) {
    return { entitlements: (trial.entitlements as Record<string, any>) || {}, planSlug: "trial" };
  }
  return { entitlements: { workspaces: 3 }, planSlug: "trial" };
}

async function countWorkspaces(db: Db, accountId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(workspaces)
    .where(and(eq(workspaces.account_id, accountId), isNull(workspaces.deletedAt)));
  return rows[0]?.n ?? 0;
}

/**
 * Assert the account may create one more of `kind`.
 * kind: "workspaces" (Phase 3 uses this on workspace creation).
 */
export async function assertPlanAllows(
  db: Db,
  kind: "workspaces",
  accountId: string,
): Promise<void> {
  const { entitlements, planSlug } = await getPlanEntitlements(db, accountId);
  const limit = entitlements[kind];
  if (limit == null) return; // no entitlement configured → unlimited
  const current = kind === "workspaces" ? await countWorkspaces(db, accountId) : 0;
  if (current >= Number(limit)) {
    throw new PlanLimitError(
      { metric: kind, limit: Number(limit), current, entitlement: kind, plan: planSlug },
      `Your plan allows ${limit} ${kind}; upgrade to add more.`,
    );
  }
}
