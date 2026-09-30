// Phase 6: billing — priceIdFor discipline, Stripe webhook signature
// verification, subscription sync, and settings resolution. fetch and D1
// are stubbed; no network or keys needed.
import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpError } from "../src/lib/filter.js";
import {
  billingSettingsFor,
  priceIdFor,
  signStripePayload,
  verifyStripeSignature,
} from "../src/lib/stripe.js";
import { syncSubscription } from "../src/lib/billing-sync.js";

const SECRET = "whsec_test_secret_1234567890abcdef";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("priceIdFor", () => {
  const plan = { slug: "pro", name: "Pro", stripePriceId: "price_test_1", stripePriceIdLive: "price_live_1" };

  it("returns the test price in test mode", () => {
    expect(priceIdFor(plan, true)).toBe("price_test_1");
  });

  it("returns the live price in live mode when published", () => {
    expect(priceIdFor(plan, false)).toBe("price_live_1");
  });

  it("refuses silent live fallback when the plan was never published live", () => {
    const unpublished = { ...plan, stripePriceIdLive: null };
    let err: any = null;
    try {
      priceIdFor(unpublished, false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("PLAN_NOT_PUBLISHED_LIVE");
  });

  it("returns null in test mode when no test price exists", () => {
    expect(priceIdFor({ slug: "x", stripePriceId: null }, true)).toBeNull();
  });
});

describe("verifyStripeSignature", () => {
  const raw = JSON.stringify({ id: "evt_123", type: "checkout.session.completed" });

  it("accepts a valid signature", async () => {
    const header = await signStripePayload(raw, SECRET);
    await expect(verifyStripeSignature(raw, header, SECRET)).resolves.toBeUndefined();
  });

  it("rejects a tampered payload", async () => {
    const header = await signStripePayload(raw, SECRET);
    await expect(verifyStripeSignature(raw + "x", header, SECRET)).rejects.toMatchObject({
      status: 400,
      code: "WEBHOOK_BAD_SIGNATURE",
    });
  });

  it("rejects the wrong secret", async () => {
    const header = await signStripePayload(raw, "whsec_other");
    await expect(verifyStripeSignature(raw, header, SECRET)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a missing signature header", async () => {
    await expect(verifyStripeSignature(raw, null, SECRET)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a stale timestamp (replay protection)", async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const header = await signStripePayload(raw, SECRET, old);
    await expect(verifyStripeSignature(raw, header, SECRET)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a malformed header", async () => {
    await expect(verifyStripeSignature(raw, "not-a-signature", SECRET)).rejects.toMatchObject({ status: 400 });
  });
});

describe("billingSettingsFor", () => {
  const emptyDb = { select: () => ({ from: () => ({ limit: () => Promise.resolve([]) }) }) } as any;

  it("uses env vars when no settings row exists", async () => {
    const s = await billingSettingsFor(
      { STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_PUBLISHABLE_KEY: "pk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_x" },
      emptyDb,
    );
    expect(s.secretKey).toBe("sk_test_abc");
    expect(s.stripeConfigured).toBe(true);
    expect(s.testMode).toBe(true);
    expect(s.currency).toBe("sek");
  });

  it("reports unconfigured when nothing is set", async () => {
    const s = await billingSettingsFor({}, emptyDb);
    expect(s.stripeConfigured).toBe(false);
    expect(s.webhookSecret).toBeNull();
  });

  it("a live key forces live mode", async () => {
    const s = await billingSettingsFor({ STRIPE_SECRET_KEY: "sk_live_abc" }, emptyDb);
    expect(s.testMode).toBe(false);
  });
});

/** Programmable fake Db for syncSubscription (select/update/insert chains). */
function fakeDb(opts: { subs?: any[]; plans?: any[] }) {
  const calls: any[] = [];
  const chain = (rows: any[]) => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
  return {
    calls,
    db: {
      select: (cols?: any) => {
        calls.push({ op: "select", cols });
        // subscriptionPlans lookup selects {id}; subscriptions selects all
        const isPlan = cols && typeof cols === "object" && "id" in cols && !("status" in cols);
        return chain(isPlan ? (opts.plans ?? []) : (opts.subs ?? []));
      },
      update: (t: any) => {
        calls.push({ op: "update" });
        return { set: (data: any) => { calls.push({ op: "set", data }); return { where: () => Promise.resolve() }; } };
      },
      insert: (t: any) => {
        calls.push({ op: "insert" });
        return { values: (data: any) => { calls.push({ op: "values", data }); return Promise.resolve(); } };
      },
    } as any,
  };
}

const stripeSub = (over: any = {}) => ({
  id: "sub_123",
  status: "active",
  customer: "cus_123",
  trial_end: null,
  current_period_start: 1700000000,
  current_period_end: 1702600000,
  cancel_at_period_end: false,
  canceled_at: null,
  items: { data: [{ current_period_start: 1700000000, current_period_end: 1702600000 }] },
  metadata: { accountId: "acct_1", planSlug: "pro" },
  ...over,
});

describe("syncSubscription", () => {
  it("creates a subscription row from a Stripe subscription", async () => {
    const { db, calls } = fakeDb({ subs: [], plans: [{ id: "plan_pro" }] });
    const out = await syncSubscription(db, stripeSub());
    expect(out).not.toBeNull();
    expect(out!.status).toBe("active");
    expect(out!.stripeSubscriptionId).toBe("sub_123");
    expect(out!.plan_id).toBe("plan_pro");
    expect(calls.some((c) => c.op === "insert")).toBe(true);
  });

  it("updates the existing row for the account", async () => {
    const existing = { id: "row_1", account_id: "acct_1", plan_id: "plan_old" };
    const { db, calls } = fakeDb({ subs: [existing], plans: [{ id: "plan_pro" }] });
    const out = await syncSubscription(db, stripeSub({ status: "past_due" }));
    expect(out!.status).toBe("past_due");
    const set = calls.find((c) => c.op === "set");
    expect(set.data.status).toBe("past_due");
    expect(set.data.account_id).toBe("acct_1");
  });

  it("resolves the account via the Stripe customer when metadata is absent", async () => {
    const existing = { id: "row_9", account_id: "acct_9", plan_id: "plan_old" };
    const { db } = fakeDb({ subs: [existing], plans: [] });
    const out = await syncSubscription(db, stripeSub({ metadata: {} }));
    expect(out!.account_id).toBe("acct_9");
  });

  it("returns null when the account cannot be resolved", async () => {
    const { db } = fakeDb({ subs: [], plans: [] });
    expect(await syncSubscription(db, stripeSub({ metadata: {}, customer: "cus_unknown" }))).toBeNull();
  });

  it("maps unknown Stripe statuses to incomplete", async () => {
    const { db } = fakeDb({ subs: [], plans: [] });
    const out = await syncSubscription(db, stripeSub({ status: "weird_status" }));
    expect(out!.status).toBe("incomplete");
  });
});
