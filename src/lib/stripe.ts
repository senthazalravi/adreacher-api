// Stripe billing client. Port of the old lib/stripe.js — fetch-based (no Node
// Stripe SDK on Workers), same test/live key discipline.
//
// Credential resolution: worker env vars first (`STRIPE_SECRET_KEY`,
// `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`), then the decrypted
// `billing_settings` row. `testMode` comes from the row (default true); a
// `sk_test_` key also forces test mode. In live mode a plan without a live
// Stripe price is refused loudly (see priceIdFor) rather than silently
// charging through an ad-hoc price_data fallback.
import { eq } from "drizzle-orm";
import { billingSettings } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { decryptRowSecrets } from "./secrets.js";
import { HttpError } from "./filter.js";

export interface BillingEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SECRET_KEY?: string;
  APP_URL?: string;
}

export interface BillingSettings {
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  currency: string;
  trialDays: number;
  testMode: boolean;
  stripeConfigured: boolean;
}

/**
 * Resolve the Stripe credentials for the account's current mode.
 * Env vars win (they're the deployment's deliberate choice); the
 * `billing_settings` row is the fallback for keys stored via the UI.
 */
export async function billingSettingsFor(env: BillingEnv, db: Db): Promise<BillingSettings> {
  let row: Record<string, any> | null = null;
  try {
    const rows = await db.select().from(billingSettings).limit(1);
    row = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  } catch {
    row = null;
  }
  if (row && env.SECRET_KEY) {
    try {
      row = await decryptRowSecrets("billing_settings", row, env.SECRET_KEY);
    } catch {
      /* keep the encrypted row unreadable rather than failing */
    }
  }
  const testMode = row?.testMode ?? true;
  const secretKey = env.STRIPE_SECRET_KEY || row?.stripeSecretKey || null;
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY || row?.stripePublishableKey || null;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || row?.stripeWebhookSecret || null;
  const liveKey = secretKey?.startsWith("sk_live_") ?? false;
  return {
    secretKey,
    publishableKey,
    webhookSecret,
    currency: String(row?.defaultCurrency || "SEK").toLowerCase(),
    trialDays: Number(row?.trialDays ?? 14),
    testMode: liveKey ? false : testMode,
    stripeConfigured: Boolean(secretKey),
  };
}

/**
 * The Stripe price to charge for a plan in the current mode.
 *
 * In live mode a missing price id is fatal on purpose. Checkout's `price_data`
 * fallback would silently create a one-off price at the DB amount — the
 * customer is charged correctly but the subscription is not attached to the
 * catalogue, so reporting and upgrades quietly break. Better to refuse and say
 * the plan is not published to live Stripe yet.
 */
export function priceIdFor(plan: Record<string, any> | null | undefined, testMode: boolean): string | null {
  const id = testMode ? plan?.stripePriceId : plan?.stripePriceIdLive;
  if (!testMode && !id) {
    throw new HttpError(
      409,
      `Plan "${plan?.name || plan?.slug}" has no live Stripe price yet. Publish it to live Stripe in Billing settings before selling it.`,
      "PLAN_NOT_PUBLISHED_LIVE",
    );
  }
  return id || null;
}

const formEncode = (params: Record<string, any>): string => {
  const body = new URLSearchParams();
  const add = (key: string, v: any) => {
    if (v === undefined || v === null) return;
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v)) add(`${key}[${k}]`, val);
    } else {
      body.set(key, String(v));
    }
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return body.toString();
};

/** Minimal fetch-based Stripe REST client (form-encoded, Bearer auth). */
export class StripeClient {
  constructor(private secretKey: string) {}

  private async req<T>(method: string, path: string, params: Record<string, any> = {}): Promise<T> {
    const url = `https://api.stripe.com/v1${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
    if (method === "GET") {
      const qs = formEncode(params);
      const res = await fetch(qs ? `${url}?${qs}` : url, init);
      return this.parse<T>(res);
    }
    init.body = formEncode(params);
    const res = await fetch(url, init);
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text().catch(() => "");
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = data?.error?.message || `Stripe request failed (${res.status})`;
      throw new HttpError(res.status >= 500 ? 502 : 400, msg, "STRIPE_ERROR");
    }
    return data as T;
  }

  get<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    return this.req<T>("GET", path, params);
  }

  post<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    return this.req<T>("POST", path, params);
  }

  createCheckoutSession(p: {
    customer: string;
    priceId?: string | null;
    priceData?: { currency: string; unitAmount: number; interval: string; productName: string } | null;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ id: string; url: string }> {
    const line = p.priceId
      ? { price: p.priceId, quantity: 1 }
      : {
          price_data: {
            currency: p.priceData!.currency,
            unit_amount: p.priceData!.unitAmount,
            recurring: { interval: p.priceData!.interval },
            product_data: { name: p.priceData!.productName },
          },
          quantity: 1,
        };
    return this.post("/checkout/sessions", {
      mode: "subscription",
      customer: p.customer,
      "line_items[0][price]": (line as any).price,
      "line_items[0][quantity]": 1,
      ...((line as any).price_data
        ? {
            "line_items[0][price_data][currency]": (line as any).price_data.currency,
            "line_items[0][price_data][unit_amount]": (line as any).price_data.unit_amount,
            "line_items[0][price_data][recurring][interval]": (line as any).price_data.recurring.interval,
            "line_items[0][price_data][product_data][name]": (line as any).price_data.product_data.name,
          }
        : {}),
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      "subscription_data[metadata][accountId]": p.metadata.accountId,
      "subscription_data[metadata][planSlug]": p.metadata.planSlug,
      "metadata[accountId]": p.metadata.accountId,
      "metadata[planSlug]": p.metadata.planSlug,
    });
  }

  createPortalSession(p: { customer: string; returnUrl: string }): Promise<{ url: string }> {
    return this.post("/billing_portal/sessions", { customer: p.customer, return_url: p.returnUrl });
  }

  createCustomer(p: { email?: string; name?: string; metadata: Record<string, string> }): Promise<{ id: string }> {
    return this.post("/customers", {
      email: p.email,
      name: p.name,
      "metadata[accountId]": p.metadata.accountId,
      "metadata[tenant_Id]": p.metadata.accountId,
    });
  }

  listInvoices(p: { customer: string; limit: number; startingAfter?: string }): Promise<{ data: any[]; has_more: boolean }> {
    return this.get("/invoices", {
      customer: p.customer,
      limit: p.limit,
      ...(p.startingAfter ? { starting_after: p.startingAfter } : {}),
    });
  }

  getSubscription(id: string): Promise<any> {
    return this.get(`/subscriptions/${encodeURIComponent(id)}`);
  }
}

/** Stripe client for the account's current mode, or null when unconfigured. */
export async function stripeClient(
  env: BillingEnv,
  db: Db,
): Promise<{ client: StripeClient | null; settings: BillingSettings }> {
  const settings = await billingSettingsFor(env, db);
  const client = settings.secretKey ? new StripeClient(settings.secretKey) : null;
  return { client, settings };
}

/* ---------------- webhook signature verification ---------------- */

/**
 * Verify a Stripe webhook signature against the RAW request body.
 * Stripe sends `t=<unix ts>,v1=<hex hmac>[,v1=...]`; the signature is
 * HMAC-SHA256(`${t}.${rawBody}`, webhookSecret). Throws HttpError on any
 * mismatch — never trust the parsed JSON body for this.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): Promise<void> {
  if (!header) throw new HttpError(400, "Missing Stripe signature", "WEBHOOK_BAD_SIGNATURE");
  const parts: Record<string, string[]> = {};
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i < 0) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    (parts[k] ||= []).push(v);
  }
  const ts = Number(parts.t?.[0]);
  const sigs = parts.v1 || [];
  if (!Number.isFinite(ts) || sigs.length === 0) {
    throw new HttpError(400, "Malformed Stripe signature", "WEBHOOK_BAD_SIGNATURE");
  }
  // Replay protection: Stripe allows 5 minutes of clock skew.
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    throw new HttpError(400, "Stripe signature timestamp outside tolerance", "WEBHOOK_BAD_SIGNATURE");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ok = sigs.some((s) => timingSafeEqualHex(s, hex));
  if (!ok) throw new HttpError(400, "Stripe signature verification failed", "WEBHOOK_BAD_SIGNATURE");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Build a Stripe signature header (used by tests). */
export async function signStripePayload(rawBody: string, secret: string, ts = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${ts},v1=${hex}`;
}
