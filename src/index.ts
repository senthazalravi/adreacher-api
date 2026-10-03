import { Hono } from "hono";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import items from "./routes/items.js";
import filesRouter from "./routes/files.js";
import auth from "./routes/auth.js";
import me from "./routes/me.js";
import platforms from "./routes/platforms.js";
import { campaignsRouter } from "./routes/campaigns.js";
import aiRouter from "./routes/ai.js";
import { billingRouter, handleBillingWebhook } from "./routes/billing.js";
import jobsRouter from "./routes/jobs.js";
import notificationsRouter from "./routes/notifications.js";
import schedulingRouter from "./routes/scheduling.js";
import agencyRouter from "./routes/agency.js";
import superAdminRouter from "./routes/super-admin.js";
import onboardingRouter from "./routes/onboarding.js";
import { dispatchCron } from "./jobs/index.js";
import { authMiddleware, tenantStatusGuard } from "./lib/auth.js";
import { HttpError } from "./lib/filter.js";

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  JWT_SECRET?: string;
  SECRET_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Public URL of this API worker (for OAuth redirect_uri). */
  API_PUBLIC_URL?: string;
  /** Public URL of the frontend app (for email links). */
  APP_URL?: string;
  /** AI studio (Gemini text, fal.ai images). */
  GEMINI_API_KEY?: string;
  AI_TEXT_MODEL?: string;
  AI_FALLBACK_MODEL?: string;
  FAL_API_KEY?: string;
  FAL_KEY?: string;
  /** Platform OAuth overrides (same ADS_<CODE>_* names as the old backend). */
  ADS_X_REDIRECT_URI?: string;
  ADS_BING_REDIRECT_URI?: string;
  /** Stripe billing. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ data: { status: "ok" } }));

// Public Stripe webhook — registered BEFORE any "/"-mounted sub-app: those
// use bare `use()` middleware which Hono merges into the shared router as
// global middleware for subsequently-registered routes. Registered here, the
// handler runs first and returns without calling next(), so auth never fires.
// The request is authenticated by the Stripe signature instead.
app.post("/billing/webhook", handleBillingWebhook);

// Public: auth flows (login/register/oauth hand the token to the caller).
app.route("/auth", auth);

// Everything else requires a session; writes additionally respect tenant status.
// (filesRouter applies its own auth: uploads/deletes need a session, public
// asset serving stays open so ad platforms can fetch creatives by URL.)
app.use("/items/*", authMiddleware);
app.use("/items/*", tenantStatusGuard);
app.use("/me/*", authMiddleware);
app.use("/me/*", tenantStatusGuard);
app.use("/platforms*", authMiddleware);
app.use("/platforms*", tenantStatusGuard);
app.use("/platform-connections*", authMiddleware);
app.use("/platform-connections*", tenantStatusGuard);
app.use("/platform-configs*", authMiddleware);
app.use("/platform-configs*", tenantStatusGuard);
app.use("/workers/*", authMiddleware);
app.use("/workers/*", tenantStatusGuard);

app.route("/items", items);
app.route("/me", me);
app.route("/", filesRouter);
app.route("/", platforms);
// Onboarding BEFORE the routers below: campaignsRouter/aiRouter/billingRouter
// use bare `use()` (no path), which Hono merges as global middleware for all
// subsequently-registered routes. Onboarding's /scrape endpoints are public,
// so they must be registered before that leaked auth middleware exists.
app.route("/", onboardingRouter);
app.route("/", campaignsRouter);
app.route("/", aiRouter);
// Billing: the router's own middleware skips POST /billing/webhook
// (public, Stripe-signature-verified).
app.route("/", billingRouter);
// Worker job history (admin UI polls these).
app.route("/", jobsRouter);
// Phase 8: notifications, scheduling, agency, super-admin.
// Each router applies its own auth guards (super-admin requires platformAdmin).
app.route("/", notificationsRouter);
app.route("/", schedulingRouter);
app.route("/", agencyRouter);
app.route("/", superAdminRouter);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 400;
    return c.json(
      {
        error: {
          code: err.code ?? (status === 404 ? "NOT_FOUND" : "BAD_REQUEST"),
          message: err.message,
          ...(err instanceof Object && "detail" in err && (err as { detail?: unknown }).detail
            ? { detail: (err as { detail?: unknown }).detail }
            : {}),
        },
      },
      status as 400,
    );
  }
  console.error("Unhandled error", err);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "Unknown error",
      },
    },
    500,
  );
});

app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));

// Cron Triggers dispatch here (see "triggers.crons" in wrangler.jsonc).
// Each tick runs the matching job wrapped in recordRun; unknown schedules
// are logged and ignored so a stray trigger can never crash the worker.
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchCron(event.cron, env));
  },
};
