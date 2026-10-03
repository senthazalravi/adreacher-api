// Phase 8: post scheduling — queue posts to connected social platforms,
// calendar view, publish-now, cancel. Mounted by src/index.ts.
import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import {
  adPlatforms,
  platformConnections,
  posts,
  scheduledPosts,
  workspaceMembers,
  workspaces,
} from "../db/schema/index.js";
import { HttpError } from "../lib/filter.js";
import {
  authMiddleware,
  getJwtSecret,
  sessionOf,
  tenantStatusGuard,
  type Session,
} from "../lib/auth.js";
import { publishScheduledPost } from "../jobs/post-publisher.js";
import type { Env } from "../index.js";

const router = new Hono<{ Bindings: Env }>();

router.use("/scheduled-posts*", authMiddleware);
router.use("/scheduled-posts*", tenantStatusGuard);

/** DB status -> UI status. */
const UI_STATUS: Record<string, string> = {
  queued: "pending",
  publishing: "processing",
};
const toUiStatus = (status: string): string => UI_STATUS[status] ?? status;

const PRIORITIES = ["low", "normal", "high"] as const;
const STATUSES = ["queued", "publishing", "published", "failed", "cancelled"] as const;

/**
 * Auth rule for every endpoint: the caller is authenticated (guaranteed by
 * authMiddleware), the target workspace belongs to the caller's tenant
 * (skipped for platformAdmin), and the caller has an active
 * workspaceMembers row unless platformAdmin || isAccountOwner.
 */
async function requireWorkspaceAccess(db: Db, s: Session, workspaceId: string) {
  const ws = (
    await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  )[0] as unknown as Record<string, any> | undefined;
  if (!ws || (!s.platformAdmin && ws.account_id !== s.tenantId)) {
    throw new HttpError(404, "Workspace not found", "WORKSPACE_NOT_FOUND");
  }
  if (s.platformAdmin || s.isAccountOwner) return ws;
  const membership = (
    await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspace_id, workspaceId),
          eq(workspaceMembers.member_id, s.userId),
          eq(workspaceMembers.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!membership) {
    throw new HttpError(403, "No access to this workspace", "WORKSPACE_FORBIDDEN");
  }
  return ws;
}

async function getScheduledPost(db: Db, id: string) {
  const row = (
    await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1)
  )[0] as unknown as Record<string, any> | undefined;
  return row;
}

/** Batch-resolve platform / post display names for a set of rows. */
async function resolveLookups(db: Db, rows: Record<string, any>[]) {
  const platformIds = [
    ...new Set(rows.map((r) => r.platform_id).filter((x): x is string => !!x)),
  ];
  const postIds = [...new Set(rows.map((r) => r.post_id).filter((x): x is string => !!x))];
  const [plats, psts] = await Promise.all([
    platformIds.length
      ? db.select().from(adPlatforms).where(inArray(adPlatforms.id, platformIds))
      : Promise.resolve([] as (typeof adPlatforms.$inferSelect)[]),
    postIds.length
      ? db.select().from(posts).where(inArray(posts.id, postIds))
      : Promise.resolve([] as (typeof posts.$inferSelect)[]),
  ]);
  return {
    platforms: new Map(plats.map((p) => [p.id, p])),
    postsById: new Map(psts.map((p) => [p.id, p])),
  };
}

/** Full UI row shape for a scheduled post. */
async function shapeRow(
  db: Db,
  row: Record<string, any>,
  lookups?: Awaited<ReturnType<typeof resolveLookups>>,
) {
  const lk = lookups ?? (await resolveLookups(db, [row]));
  const platform = row.platform_id ? lk.platforms.get(row.platform_id) : undefined;
  const post = row.post_id ? lk.postsById.get(row.post_id) : undefined;
  return {
    id: row.id,
    postId: row.post_id ?? null,
    userId: "",
    platformId: row.platform_id ?? null,
    platformName: platform?.name ?? null,
    platformSlug: platform?.code ?? null,
    connectionId: row.connection_id ?? null,
    workspaceId: row.workspace_id,
    scheduledAt: row.scheduledAt,
    status: toUiStatus(row.status),
    publishedAt: row.publishedAt ?? null,
    errorMessage: row.errorMessage ?? null,
    attempts: row.attempts ?? 0,
    lastAttemptAt: row.lastAttemptAt ?? null,
    nextRetryAt: row.nextRetryAt ?? null,
    externalPostId: row.externalPostId ?? null,
    priority: row.priority ?? "normal",
    postName: post?.title ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Accept YYYY-MM-DD (whole day in UTC) or a full ISO datetime. */
function parseDateParam(raw: string | undefined, dflt: Date, endOfDay: boolean): Date {
  if (!raw) return dflt;
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    d = new Date(endOfDay ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`);
  } else {
    d = new Date(raw);
  }
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, `Invalid date "${raw}"`, "INVALID_DATE");
  }
  return d;
}

// GET /scheduled-posts/calendar?workspaceId=&startDate=&endDate=
router.get("/scheduled-posts/calendar", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspaceAccess(db, s, workspaceId);

  const now = new Date();
  const start = parseDateParam(c.req.query("startDate"), now, false);
  const end = parseDateParam(
    c.req.query("endDate"),
    new Date(now.getTime() + 30 * 86400_000),
    true,
  );
  if (end < start) throw new HttpError(400, "endDate is before startDate", "INVALID_DATE_RANGE");

  const CAP = 500;
  const rows = (await db
    .select()
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.workspace_id, workspaceId),
        gte(scheduledPosts.scheduledAt, start),
        lte(scheduledPosts.scheduledAt, end),
        ne(scheduledPosts.status, "cancelled"),
      ),
    )
    .orderBy(asc(scheduledPosts.scheduledAt))
    .limit(CAP + 1)) as unknown as Record<string, any>[];
  const truncated = rows.length > CAP;
  const page = truncated ? rows.slice(0, CAP) : rows;
  const lk = await resolveLookups(db, page);
  const events = page.map((r) => {
    const platform = r.platform_id ? lk.platforms.get(r.platform_id) : undefined;
    const post = r.post_id ? lk.postsById.get(r.post_id) : undefined;
    return {
      id: r.id,
      postId: r.post_id ?? null,
      postName: post?.title ?? null,
      platformId: r.platform_id ?? null,
      platformName: platform?.name ?? null,
      platformSlug: platform?.code ?? null,
      scheduledAt: r.scheduledAt,
      status: toUiStatus(r.status),
    };
  });
  return c.json({
    data: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      truncated,
      events,
    },
  });
});

// GET /scheduled-posts?workspaceId=&status=&platformId=&postId=&limit=&page=
router.get("/scheduled-posts", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspaceAccess(db, s, workspaceId);

  let status = c.req.query("status");
  if (status === "pending") status = "queued";
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    throw new HttpError(400, `Unknown status "${status}"`, "INVALID_STATUS");
  }
  const platformId = c.req.query("platformId");
  const postId = c.req.query("postId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 200);
  const pageNum = Math.max(Number(c.req.query("page")) || 1, 1);

  const conds = [eq(scheduledPosts.workspace_id, workspaceId)];
  if (status) conds.push(eq(scheduledPosts.status, status as (typeof STATUSES)[number]));
  if (platformId) conds.push(eq(scheduledPosts.platform_id, platformId));
  if (postId) conds.push(eq(scheduledPosts.post_id, postId));

  const all = (await db
    .select()
    .from(scheduledPosts)
    .where(and(...conds))
    .orderBy(desc(scheduledPosts.scheduledAt))) as unknown as Record<string, any>[];
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const items = all.slice((pageNum - 1) * limit, pageNum * limit);
  const lk = await resolveLookups(db, items);
  return c.json({
    data: await Promise.all(items.map((r) => shapeRow(db, r, lk))),
    meta: { total, page: pageNum, limit, pages },
  });
});

// GET /scheduled-posts/:id
router.get("/scheduled-posts/:id", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const row = await getScheduledPost(db, c.req.param("id"));
  if (!row || !row.workspace_id) {
    throw new HttpError(404, "Scheduled post not found", "NOT_FOUND");
  }
  await requireWorkspaceAccess(db, s, row.workspace_id);
  return c.json({ data: await shapeRow(db, row) });
});

// POST /scheduled-posts
router.post("/scheduled-posts", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { workspaceId, postId, scheduledAt, platformId, platformSlug, connectionId } = body;
  const priority = body.priority ?? "normal";
  if (!workspaceId || !postId || !scheduledAt) {
    throw new HttpError(400, "workspaceId, postId and scheduledAt are required", "BAD_REQUEST");
  }
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    throw new HttpError(400, `Unknown priority "${priority}"`, "INVALID_PRIORITY");
  }
  await requireWorkspaceAccess(db, s, workspaceId);

  const post = (
    await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspace_id, workspaceId)))
      .limit(1)
  )[0] as unknown as Record<string, any> | undefined;
  if (!post) throw new HttpError(404, "Post not found in this workspace", "POST_NOT_FOUND");

  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) {
    throw new HttpError(400, `Invalid scheduledAt "${scheduledAt}"`, "INVALID_DATE");
  }

  // Resolve platform: explicit id wins, otherwise platformSlug -> adPlatforms.code.
  let pid: string | null = platformId ?? null;
  if (!pid && platformSlug) {
    const platform = (
      await db.select().from(adPlatforms).where(eq(adPlatforms.code, platformSlug)).limit(1)
    )[0];
    if (!platform) throw new HttpError(400, `Unknown platform "${platformSlug}"`, "UNKNOWN_PLATFORM");
    pid = platform.id;
  }

  // Resolve connection: explicit id (must belong to the workspace), otherwise
  // the workspace's connection for this platform (any workspace connection if
  // no platform was given).
  let cid: string | null = connectionId ?? null;
  if (cid) {
    const conn = (
      await db
        .select()
        .from(platformConnections)
        .where(
          and(
            eq(platformConnections.id, cid),
            eq(platformConnections.workspace_id, workspaceId),
          ),
        )
        .limit(1)
    )[0];
    if (!conn) throw new HttpError(404, "Platform connection not found", "CONNECTION_NOT_FOUND");
  } else {
    const connConds = [eq(platformConnections.workspace_id, workspaceId)];
    if (pid) connConds.push(eq(platformConnections.platform_id, pid));
    const conn = (
      await db
        .select()
        .from(platformConnections)
        .where(and(...connConds))
        .limit(1)
    )[0] as unknown as Record<string, any> | undefined;
    if (!conn) {
      throw new HttpError(400, "No platform connection for this workspace", "NO_CONNECTION");
    }
    cid = conn.id;
  }

  const now = new Date();
  const createdRows = (await db
    .insert(scheduledPosts)
    .values({
      workspace_id: workspaceId,
      post_id: postId,
      platform_id: pid,
      connection_id: cid,
      account_id: s.tenantId,
      scheduledAt: when,
      status: "queued",
      priority,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning()) as unknown as Record<string, any>[];
  const created = createdRows[0];
  if (!created) throw new HttpError(500, "Failed to create scheduled post", "CREATE_FAILED");

  await db
    .update(posts)
    .set({ status: "scheduled", scheduledAt: when, updatedAt: now })
    .where(eq(posts.id, postId));

  return c.json({ data: await shapeRow(db, created) }, 201);
});

// POST /scheduled-posts/:id/publish-now
router.post("/scheduled-posts/:id/publish-now", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const row = await getScheduledPost(db, c.req.param("id"));
  if (!row || !row.workspace_id) {
    throw new HttpError(404, "Scheduled post not found", "NOT_FOUND");
  }
  await requireWorkspaceAccess(db, s, row.workspace_id);
  if (row.status === "published") {
    throw new HttpError(409, "Scheduled post is already published", "ALREADY_PUBLISHED");
  }

  // Reset to queued for immediate pickup, then publish inline.
  const now = new Date();
  await db
    .update(scheduledPosts)
    .set({
      status: "queued",
      scheduledAt: now,
      nextRetryAt: null,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(scheduledPosts.id, row.id));

  const result = await publishScheduledPost(db, c.env as any, getJwtSecret(c.env), row.id);
  const fresh = await getScheduledPost(db, row.id);
  const shaped = await shapeRow(db, fresh ?? { ...row, status: "queued", scheduledAt: now });
  return c.json({ data: { ...shaped, result } });
});

// POST /scheduled-posts/:id/cancel
router.post("/scheduled-posts/:id/cancel", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const row = await getScheduledPost(db, c.req.param("id"));
  if (!row || !row.workspace_id) {
    throw new HttpError(404, "Scheduled post not found", "NOT_FOUND");
  }
  await requireWorkspaceAccess(db, s, row.workspace_id);
  if (row.status === "published") {
    throw new HttpError(409, "Scheduled post is already published", "ALREADY_PUBLISHED");
  }

  const now = new Date();
  await db
    .update(scheduledPosts)
    .set({ status: "cancelled", nextRetryAt: null, updatedAt: now })
    .where(eq(scheduledPosts.id, row.id));
  if (row.post_id) {
    await db
      .update(posts)
      .set({ status: "draft", scheduledAt: null, updatedAt: now })
      .where(eq(posts.id, row.post_id));
  }
  const fresh = await getScheduledPost(db, row.id);
  return c.json({ data: await shapeRow(db, fresh ?? { ...row, status: "cancelled" }) });
});

// PATCH /scheduled-posts/:id — reschedule / tweak a queued scheduled post.
router.patch("/scheduled-posts/:id", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const row = await getScheduledPost(db, c.req.param("id"));
  if (!row || !row.workspace_id) {
    throw new HttpError(404, "Scheduled post not found", "NOT_FOUND");
  }
  await requireWorkspaceAccess(db, s, row.workspace_id);
  if (row.status === "published" || row.status === "publishing") {
    throw new HttpError(409, `Cannot update a ${row.status} scheduled post`, "IMMUTABLE");
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const patch: Record<string, any> = {};

  if (body.priority !== undefined) {
    if (!(PRIORITIES as readonly string[]).includes(body.priority)) {
      throw new HttpError(400, `Unknown priority "${body.priority}"`, "INVALID_PRIORITY");
    }
    patch.priority = body.priority;
  }
  if (body.scheduledAt !== undefined) {
    const when = new Date(body.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new HttpError(400, `Invalid scheduledAt "${body.scheduledAt}"`, "INVALID_DATE");
    }
    patch.scheduledAt = when;
  }
  if (body.platformId !== undefined || body.platformSlug !== undefined) {
    let pid: string | null = body.platformId ?? null;
    if (!pid && body.platformSlug) {
      const platform = (
        await db.select().from(adPlatforms).where(eq(adPlatforms.code, body.platformSlug)).limit(1)
      )[0];
      if (!platform) throw new HttpError(400, `Unknown platform "${body.platformSlug}"`, "UNKNOWN_PLATFORM");
      pid = platform.id;
    }
    patch.platform_id = pid;
  }
  if (body.connectionId !== undefined) {
    if (body.connectionId) {
      const conn = (
        await db
          .select()
          .from(platformConnections)
          .where(
            and(
              eq(platformConnections.id, body.connectionId),
              eq(platformConnections.workspace_id, row.workspace_id),
            ),
          )
          .limit(1)
      )[0];
      if (!conn) throw new HttpError(404, "Platform connection not found", "CONNECTION_NOT_FOUND");
      patch.connection_id = body.connectionId;
    } else {
      patch.connection_id = null;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Nothing to update", "BAD_REQUEST");
  }
  patch.updatedAt = new Date();
  await db.update(scheduledPosts).set(patch).where(eq(scheduledPosts.id, row.id));
  const fresh = await getScheduledPost(db, row.id);
  return c.json({ data: await shapeRow(db, fresh ?? { ...row, ...patch }) });
});

// DELETE /scheduled-posts/:id — remove a queued/cancelled/failed scheduled post.
router.delete("/scheduled-posts/:id", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const row = await getScheduledPost(db, c.req.param("id"));
  if (!row || !row.workspace_id) {
    throw new HttpError(404, "Scheduled post not found", "NOT_FOUND");
  }
  await requireWorkspaceAccess(db, s, row.workspace_id);
  if (row.status === "published" || row.status === "publishing") {
    throw new HttpError(409, `Cannot delete a ${row.status} scheduled post`, "IMMUTABLE");
  }
  await db.delete(scheduledPosts).where(eq(scheduledPosts.id, row.id));
  return c.json({ data: { deleted: true, id: row.id } });
});

export default router;
