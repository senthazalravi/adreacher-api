// User notifications.
//   GET    /notifications               list (newest first, paged)
//   GET    /notifications/unread/count  unread count
//   POST   /notifications/mark-seen     {ids?} — mark seen (all if omitted)
//   DELETE /notifications               clear (delete all of the user's)
import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { notifications } from "../db/schema/index.js";
import { HttpError } from "../lib/filter.js";
import { authMiddleware, sessionOf, tenantStatusGuard } from "../lib/auth.js";
import { notify } from "../lib/notify.js";
import type { Env } from "../index.js";

const router = new Hono<{ Bindings: Env }>();

router.use("/notifications*", authMiddleware);
router.use("/notifications*", tenantStatusGuard);

const publicRow = (r: Record<string, any>) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body,
  data: r.data ?? {},
  seenAt: r.seenAt,
  createdAt: r.createdAt,
});

router.get("/notifications", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, s.userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ data: rows.map(publicRow) });
});

router.get("/notifications/unread/count", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, s.userId), isNull(notifications.seenAt)));
  return c.json({ data: { count: rows.length } });
});

router.post("/notifications/mark-seen", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : undefined;
  let marked = 0;
  if (ids?.length) {
    for (const id of ids) {
      await db
        .update(notifications)
        .set({ seenAt: new Date() })
        .where(and(eq(notifications.id, id), eq(notifications.userId, s.userId)));
      marked++;
    }
  } else {
    await db
      .update(notifications)
      .set({ seenAt: new Date() })
      .where(and(eq(notifications.userId, s.userId), isNull(notifications.seenAt)));
    marked = -1; // all
  }
  return c.json({ data: { marked } });
});

router.delete("/notifications", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  await db.delete(notifications).where(eq(notifications.userId, s.userId));
  return c.json({ data: { cleared: true } });
});

// Internal helper for tests/other modules.
export { notify };

export default router;
