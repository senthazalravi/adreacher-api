import { Hono } from "hono";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import items from "./routes/items.js";
import filesRouter from "./routes/files.js";
import auth from "./routes/auth.js";
import me from "./routes/me.js";
import platforms from "./routes/platforms.js";
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
  /** Platform OAuth overrides (same ADS_<CODE>_* names as the old backend). */
  ADS_X_REDIRECT_URI?: string;
  ADS_BING_REDIRECT_URI?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ data: { status: "ok" } }));

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

app.route("/items", items);
app.route("/me", me);
app.route("/", filesRouter);
app.route("/", platforms);

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

export default app;
