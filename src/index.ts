import { Hono } from "hono";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import items from "./routes/items.js";
import filesRouter from "./routes/files.js";
import { HttpError } from "./lib/filter.js";

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ data: { status: "ok" } }));

app.route("/items", items);
app.route("/", filesRouter);

// TODO(phase-2): auth middleware — e.g.
//   app.use("/items/*", authMiddleware);
//   app.use("/files", authMiddleware);
//   app.use("/assets/*", authMiddleware);
// enforcing workspace scoping server-side from the session.

app.onError((err, c) => {
  if (err instanceof HttpError) {
    const status = err.status === 404 ? 404 : 400;
    return c.json(
      {
        error: {
          code: err.code ?? (status === 404 ? "NOT_FOUND" : "BAD_REQUEST"),
          message: err.message,
        },
      },
      status,
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
