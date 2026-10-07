// Billing (Stripe) at the frontend's paths. Port of the old
// baasix-endpoint-billing extension (same method+path for every route),
// except the webhook which is done properly here: the Stripe signature is
// verified with WebCrypto HMAC-SHA256 over the RAW request body (the old
// backend re-fetched the event by id because its JSON parser ate the body).
//
//   GET  /billing/plans | /billing/config | /billing/subscription |
//        /billing/usage | /billing/storage | /billing/invoices
//   POST /billing/checkout {planSlug, successUrl?, cancelUrl?} -> {url}
//   POST /billing/portal {returnUrl?} -> {url}
//   POST /billing/trial
//   POST /billing/webhook   (PUBLIC — Stripe calls this; signature-verified)
//
// Super-admin plan CRUD stays in Phase 8.
import { Hono, type Context } from "hono";
import { and, count, eq, isNull, lt, sum } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import {
  campaignTemplates,
  campaigns,
  files,
  platformConnections,
  subscriptionPlans,
  subscriptions,
  users,
  usageCounters,
  workspaceMembers,
  workspaces,
} from "../db/schema/index.js";
import { authMiddleware, sessionOf, tenantStatusGuard } from "../lib/auth.js";
import { HttpError } from "../lib/filter.js";
import { getPlanEntitlements } from "../lib/limits.js";
import { decryptRowSecrets } from "../lib/secrets.js";
import {
  billingSettingsFor,
  priceIdFor,
  stripeClient,
  verifyStripeSignature,
  type BillingEnv,
} from "../lib/stripe.js";
import { syncSubscription } from "../lib/billing-sync.js";
import type { Env } from "../index.js";

type AppContext = Context<{ Bindings: Env }>;

const billingEnv = (c: AppContext): BillingEnv => ({
  STRIPE_SECRET_KEY: c.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: c.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET: c.env.STRIPE_WEBHOOK_SECRET,
  SECRET_KEY: c.env.SECRET_KEY,
  APP_URL: c.env.APP_URL,
});

interface AccountCtx {
  accountId: string;
  isOwner: boolean;
  email: string;
  sub: Record<string, any> | null;
}

/** Session's tenant is the billing account; attach its subscription row. */
async function accountOf(c: AppContext): Promise<AccountCtx> {
  const session = sessionOf(c);
  if (!session?.userId) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const accountId = session.tenantId;
  if (!accountId) throw new HttpError(400, "No active account", "NO_ACCOUNT");
  const db = getDb(c.env.DB);
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.account_id, accountId)).limit(1);
  const sub = (subs[0] as unknown as Record<string, any> | undefined) ?? null;
  let plan: Record<string, any> | null = null;
  if (sub?.plan_id) {
    const plans = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, sub.plan_id as string)).limit(1);
    plan = (plans[0] as unknown as Record<string, any> | undefined) ?? null;
  }
  return { accountId, isOwner: session.isAccountOwner, email: session.email, sub: sub ? { ...sub, plan } : null };
}

/** Live byte total from the files table (running total — deletes move it). */
export async function storageBytesFor(db: Db, accountId: string): Promise<number> {
  const rows = await db
    .select({ bytes: sum(files.sizeBytes) })
    .from(files)
    .where(eq(files.tenantId, accountId));
  return Number(rows[0]?.bytes || 0);
}

const monthPeriodStart = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

export const billingRouter = new Hono<{ Bindings: Env }>();
billingRouter.use(authMiddleware);
billingRouter.use(tenantStatusGuard);

/* ------------------------------------------------------------------ */
/* Intro offer: the first 1,000 registered users get Pro at ₹100/year. */
/* Rank is by registration order, so early users keep their intro price */
/* even after the offer fills up.                                       */
/* ------------------------------------------------------------------ */
export const INTRO_OFFER_LIMIT = 1000;
export const INTRO_PLAN_SLUG = "pro";

async function introOfferFor(db: Db, userId: string) {
  const me = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1);
  const totalRows = await db.select({ n: count() }).from(users);
  const totalUsers = Number(totalRows[0]?.n ?? 0);
  let rank = totalUsers;
  if (me[0]) {
    const before = await db
      .select({ n: count() })
      .from(users)
      .where(lt(users.createdAt, me[0].createdAt));
    rank = Number(before[0]?.n ?? 0) + 1;
  }
  return {
    limit: INTRO_OFFER_LIMIT,
    priceInr: 100,
    interval: "year",
    planSlug: INTRO_PLAN_SLUG,
    registeredUsers: totalUsers,
    spotsLeft: Math.max(0, INTRO_OFFER_LIMIT - totalUsers),
    eligible: rank <= INTRO_OFFER_LIMIT,
    rank,
  };
}

billingRouter.get("/billing/intro-offer", async (c) => {
  const db = getDb(c.env.DB);
  const session = sessionOf(c);
  if (!session?.userId) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  return c.json({ data: await introOfferFor(db, session.userId) });
});

billingRouter.get("/billing/plans", async (c) => {
  const db = getDb(c.env.DB);
  const { settings } = await stripeClient(billingEnv(c), db);
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isActive, true))
    .limit(50);
  const data = (rows as unknown as Record<string, any>[])
    .filter((p) => p.isPublic !== false)
    .sort((a, b) => Number(a.displayOrder || 0) - Number(b.displayOrder || 0))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      audience: p.audience,
      priceSek: Number(p.price),
      currency: p.currency,
      billingInterval: p.billingInterval,
      trialDays: p.trialDays,
      entitlements: p.entitlements,
      stripePriceId: (settings.testMode ? p.stripePriceId : p.stripePriceIdLive) || null,
      publishedLive: Boolean(p.stripePriceIdLive),
      isActive: p.isActive,
      displayOrder: p.displayOrder,
    }));
  return c.json({ data });
});

billingRouter.get("/billing/config", async (c) => {
  const db = getDb(c.env.DB);
  const { settings } = await stripeClient(billingEnv(c), db);
  return c.json({
    data: {
      publishableKey: settings.publishableKey,
      currency: settings.currency.toUpperCase(),
      trialDays: settings.trialDays,
      testMode: settings.testMode,
      stripeConfigured: settings.stripeConfigured,
    },
  });
});

billingRouter.get("/billing/subscription", async (c) => {
  const { sub } = await accountOf(c);
  return c.json({ data: sub });
});

billingRouter.get("/billing/storage", async (c) => {
  const db = getDb(c.env.DB);
  const { accountId } = await accountOf(c);
  const { entitlements } = await getPlanEntitlements(db, accountId);
  return c.json({
    data: {
      bytes: await storageBytesFor(db, accountId),
      limitMb: typeof entitlements.storageMb === "number" ? entitlements.storageMb : null,
    },
  });
});

/**
 * Every plan limit with actual usage. Monthly flows come from
 * `usage_counters`; ceilings are counted live (deleting a template or
 * pausing a campaign frees the slot immediately). `-1`/absent = unlimited.
 */
billingRouter.get("/billing/usage", async (c) => {
  const db = getDb(c.env.DB);
  const { accountId } = await accountOf(c);
  const { entitlements } = await getPlanEntitlements(db, accountId);
  const periodStart = monthPeriodStart();

  const counters = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.account_id, accountId), eq(usageCounters.periodStart, periodStart)))
    .limit(50);
  const counted: Record<string, number> = {};
  for (const r of counters as unknown as Record<string, any>[]) counted[r.metricKey] = Number(r.count || 0);

  const countWhere = async (table: any, ...conds: any[]) => {
    const rows = await db.select({ n: count() }).from(table).where(and(eq(table.account_id, accountId), ...conds));
    return Number(rows[0]?.n || 0);
  };

  const [campaignsActive, connections, templates, wsCount, memberRows] = await Promise.all([
    countWhere(campaigns, eq(campaigns.status, "active")),
    countWhere(platformConnections, eq(platformConnections.status, "healthy")),
    countWhere(campaignTemplates, eq(campaignTemplates.isGallery, false)),
    db
      .select({ n: count() })
      .from(workspaces)
      .where(and(eq(workspaces.account_id, accountId), isNull(workspaces.deletedAt)))
      .then((r) => Number(r[0]?.n || 0)),
    db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.account_id, accountId), eq(workspaceMembers.status, "active")))
      .limit(1000),
  ]);
  const seats = new Set((memberRows as unknown as Record<string, any>[]).map((m) => m.member_id).filter(Boolean)).size;

  const lim = (key: string): number | null =>
    typeof entitlements[key] === "number" && (entitlements[key] as number) >= 0 ? (entitlements[key] as number) : null;
  const row = (metricKey: string, count: number, key: string, unit?: string) => ({
    metricKey,
    count,
    limit: lim(key),
    unlimited: lim(key) === null,
    ...(unit ? { unit } : {}),
  });

  return c.json({
    data: [
      row("ai_generations", counted.ai_generations || 0, "aiGenerations"),
      row("scheduled_posts", counted.scheduled_posts || 0, "scheduledPostsPerMonth"),
      row("brand_crawls", counted.brand_crawls || 0, "brandCrawlsPerMonth"),
      row("active_campaigns", campaignsActive, "activeCampaigns"),
      row("platform_connections", connections, "platformConnections"),
      row("templates", templates, "templatesLimit"),
      row("workspaces", wsCount, "workspaces"),
      row("team_seats", seats, "teamSeats"),
      {
        metricKey: "storage_mb",
        count: Math.ceil((await storageBytesFor(db, accountId)) / 1048576),
        limit: lim("storageMb"),
        unlimited: lim("storageMb") === null,
        unit: "MB",
      },
    ],
  });
});

billingRouter.get("/billing/invoices", async (c) => {
  const db = getDb(c.env.DB);
  const { sub } = await accountOf(c);
  const { client } = await stripeClient(billingEnv(c), db);
  if (!client || !sub?.stripeCustomerId) return c.json({ data: [] });
  const limit = Math.min(Number(c.req.query("limit")) || 12, 100);
  const startingAfter = c.req.query("startingAfter");
  const inv = await client.listInvoices({
    customer: sub.stripeCustomerId as string,
    limit,
    ...(startingAfter ? { startingAfter } : {}),
  });
  return c.json({
    data: inv.data.map((i: any) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      amountDue: i.amount_due,
      currency: i.currency,
      created: i.created ? new Date(i.created * 1000).toISOString() : null,
      pdfUrl: i.invoice_pdf,
      hostedUrl: i.hosted_invoice_url,
    })),
    meta: {
      hasMore: Boolean(inv.has_more),
      nextCursor: inv.has_more ? inv.data[inv.data.length - 1]?.id ?? null : null,
    },
  });
});

billingRouter.post("/billing/checkout", async (c) => {
  const db = getDb(c.env.DB);
  const { accountId, sub, isOwner, email } = await accountOf(c);
  if (!isOwner) throw new HttpError(403, "Only the account owner can change the plan", "FORBIDDEN");
  const { client, settings } = await stripeClient(billingEnv(c), db);
  if (!client) throw new HttpError(503, "Stripe is not configured", "BILLING_UNCONFIGURED");

  const body = await c.req.json().catch(() => ({}));
  const slug = body?.planSlug;
  const plans = slug
    ? await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.slug, slug)).limit(1)
    : [];
  const plan = (plans[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!plan || !plan.isActive) throw new HttpError(404, `Plan '${slug}' not found`, "NOT_FOUND");
  // Intro offer: Pro is ₹100/year for the first 1,000 registered users only.
  if (plan.slug === INTRO_PLAN_SLUG) {
    const session = sessionOf(c);
    const intro = await introOfferFor(db, session?.userId ?? "");
    if (!intro.eligible) {
      throw new HttpError(403, "The intro offer is fully claimed — all 1,000 spots are taken", "INTRO_OFFER_FULL");
    }
  }

  // Custom plans are assigned by an administrator, never bought — the slug is guessable.
  if (plan.isPublic === false) throw new HttpError(403, "This plan is not available for self-service purchase", "FORBIDDEN");

  let customerId = sub?.stripeCustomerId as string | undefined;
  if (!customerId) {
    const created = await client.createCustomer({
      email: email || undefined,
      metadata: { accountId },
    });
    customerId = created.id;
    if (sub) {
      await db.update(subscriptions).set({ stripeCustomerId: customerId, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id as string));
    }
  }

  // priceIdFor throws in live mode when the plan was never published to live
  // Stripe, rather than silently charging through an ad-hoc price_data price.
  const priceId = priceIdFor(plan, settings.testMode);
  const appUrl = c.env.APP_URL || "https://adreacher.app";
  const session = await client.createCheckoutSession({
    customer: customerId,
    priceId,
    priceData: priceId
      ? null
      : {
          currency: String(plan.currency || settings.currency).toLowerCase(),
          unitAmount: Math.round(Number(plan.price) * 100),
          interval: plan.billingInterval || "month",
          productName: `AdReacher ${plan.name} plan`,
        },
    successUrl: body?.successUrl || `${appUrl}/dashboard/settings?tab=billing&checkout=success`,
    cancelUrl: body?.cancelUrl || `${appUrl}/dashboard/settings?tab=billing&checkout=cancelled`,
    metadata: { accountId, planSlug: plan.slug as string },
  });
  return c.json({ data: { url: session.url, sessionId: session.id } });
});

billingRouter.post("/billing/portal", async (c) => {
  const db = getDb(c.env.DB);
  const { sub, isOwner } = await accountOf(c);
  if (!isOwner) throw new HttpError(403, "Only the account owner can manage billing", "FORBIDDEN");
  const { client } = await stripeClient(billingEnv(c), db);
  if (!client) throw new HttpError(503, "Stripe is not configured", "BILLING_UNCONFIGURED");
  if (!sub?.stripeCustomerId) throw new HttpError(404, "No Stripe customer yet — choose a plan first", "NOT_FOUND");
  const body = await c.req.json().catch(() => ({}));
  const appUrl = c.env.APP_URL || "https://adreacher.app";
  const session = await client.createPortalSession({
    customer: sub.stripeCustomerId as string,
    returnUrl: body?.returnUrl || `${appUrl}/dashboard/settings?tab=billing`,
  });
  return c.json({ data: { url: session.url } });
});

billingRouter.post("/billing/trial", async (c) => {
  const { sub } = await accountOf(c);
  return c.json({ data: sub, message: sub ? "Trial already active" : "No subscription" });
});

/* ---------------- public webhook (no auth — Stripe calls this) ---------------- */
// Exported as a standalone handler: it MUST be registered on the main app
// BEFORE any "/"-mounted sub-app with a bare `use()` (Hono merges those
// into the shared router as global middleware for later routes). See index.ts.

export async function handleBillingWebhook(c: AppContext) {
  const db = getDb(c.env.DB);
  const settings = await billingSettingsFor(billingEnv(c), db);
  if (!settings.webhookSecret) {
    throw new HttpError(503, "Stripe webhook is not configured", "BILLING_UNCONFIGURED");
  }
  // Raw body FIRST — any JSON parsing before signature verification breaks it.
  const raw = await c.req.text();
  await verifyStripeSignature(raw, c.req.header("stripe-signature"), settings.webhookSecret);

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid webhook payload", "WEBHOOK_BAD_PAYLOAD");
  }

  const { client } = await stripeClient(billingEnv(c), db);
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data?.object || {};
      const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
      if (subId && client) {
        await syncSubscription(db, await client.getSubscription(subId));
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await syncSubscription(db, event.data?.object || {});
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data?.object || {};
      const cust = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
      if (cust) {
        const rows = await db.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, cust)).limit(1);
        const row = rows[0] as unknown as Record<string, any> | undefined;
        if (row) {
          await db
            .update(subscriptions)
            .set({ status: "past_due", updatedAt: new Date() })
            .where(eq(subscriptions.id, row.id as string));
        }
      }
      break;
    }
    default:
      break;
  }
  return c.json({ received: true, type: event.type || "unknown" });
}
