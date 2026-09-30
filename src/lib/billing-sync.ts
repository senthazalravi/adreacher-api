// Mirror a Stripe subscription onto the account's `subscriptions` row.
// Port of the old lib/stripe.js syncSubscription (sans notify — notifications
// are Phase 8).
import { eq } from "drizzle-orm";
import { subscriptionPlans, subscriptions } from "../db/schema/index.js";
import type { Db } from "../db/index.js";

const ts = (n: any): Date | null => (n ? new Date(Number(n) * 1000) : null);

const KNOWN_STATUSES = ["trialing", "active", "past_due", "canceled", "incomplete", "paused"];

function customerIdOf(v: any): string | null {
  return typeof v === "string" ? v : v?.id || null;
}

/**
 * Upsert the account's subscription row from a Stripe subscription object.
 * Resolves the account from `metadata.accountId`, falling back to the
 * existing subscription row for the Stripe customer.
 */
export async function syncSubscription(
  db: Db,
  sub: Record<string, any>,
): Promise<Record<string, any> | null> {
  let accountId: string | null = sub.metadata?.accountId || null;
  const custId = customerIdOf(sub.customer);
  if (!accountId && custId) {
    const existing = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeCustomerId, custId))
      .limit(1);
    accountId = (existing[0]?.account_id as string) || null;
  }
  if (!accountId) return null;

  const current = (
    await db.select().from(subscriptions).where(eq(subscriptions.account_id, accountId)).limit(1)
  )[0] as unknown as Record<string, any> | undefined;

  const slug: string = sub.metadata?.planSlug || (current as any)?.planSlug || "basic";
  let planId: string | null = (current?.plan_id as string) || null;
  if (slug) {
    const plans = await db.select({ id: subscriptionPlans.id }).from(subscriptionPlans).where(eq(subscriptionPlans.slug, slug)).limit(1);
    if (plans[0]) planId = plans[0].id as string;
  }

  const item = sub.items?.data?.[0];
  const status: string = KNOWN_STATUSES.includes(sub.status)
    ? sub.status
    : sub.status === "unpaid"
      ? "past_due"
      : "incomplete";

  const data = {
    account_id: accountId,
    plan_id: planId,
    stripeCustomerId: custId,
    stripeSubscriptionId: sub.id as string,
    status: status as "trialing" | "active" | "past_due" | "canceled" | "incomplete" | "paused",
    trialEndsAt: ts(sub.trial_end),
    currentPeriodStart: ts(sub.current_period_start ?? item?.current_period_start),
    currentPeriodEnd: ts(sub.current_period_end ?? item?.current_period_end),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    canceledAt: ts(sub.canceled_at),
    updatedAt: new Date(),
  };

  if (current) {
    await db.update(subscriptions).set(data).where(eq(subscriptions.id, current.id as string));
    return { ...(current as object), ...data };
  }
  const id = crypto.randomUUID();
  await db.insert(subscriptions).values({ id, createdAt: new Date(), ...data });
  return { id, ...data };
}
