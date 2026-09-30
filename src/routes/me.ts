// Post-login session routes: context bootstrap, active workspace,
// tenant account fields, workspace deletion.

import { Hono, type Context } from "hono";
import { getDb } from "../db/index.js";
import { and, eq, inArray, isNull, count } from "drizzle-orm";
import type { Env } from "../index.js";
import { authMiddleware, allowedWorkspaceIds, requireRole } from "../lib/auth.js";
import { HttpError } from "../lib/filter.js";
import { users, tenants } from "../db/schema/identity.js";
import { workspaces, workspaceMembers } from "../db/schema/core.js";
import { workspaceSettings } from "../db/schema/ops.js";
import { campaigns } from "../db/schema/campaigns.js";
import { posts, scheduledPosts } from "../db/schema/content.js";
import { files } from "../db/schema/identity.js";

type Db = ReturnType<typeof getDb>;
type AppContext = Context<{ Bindings: Env }>;

const me = new Hono<{ Bindings: Env }>();

me.use("*", authMiddleware);

function sanitizeUser(row: Record<string, unknown>): Record<string, unknown> {
  const { passwordHash: _ph, totpSecret: _ts, ...rest } = row;
  return rest;
}

async function readJson(c: AppContext): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_BODY");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object", "INVALID_BODY");
  }
  return body as Record<string, unknown>;
}

me.get("/context", async (c) => {
  const s = c.get("session");
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.userId) });
  if (!user) return c.json({ error: { code: "NOT_FOUND" } }, 404);
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, s.tenantId) });
  const allowed = await allowedWorkspaceIds(db, s);
  const wsRows =
    allowed === null
      ? await db.query.workspaces.findMany({
          where: and(eq(workspaces.account_id, s.tenantId), isNull(workspaces.deletedAt)),
        })
      : allowed.length
        ? await db.query.workspaces.findMany({
            where: and(
              eq(workspaces.account_id, s.tenantId),
              isNull(workspaces.deletedAt),
            ),
          }).then((rows) => rows.filter((r) => allowed.includes(r.id)))
        : [];
  const list = wsRows.map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault }));
  const activeWorkspaceId =
    user.activeWorkspaceId && list.some((w) => w.id === user.activeWorkspaceId)
      ? user.activeWorkspaceId
      : (list.find((w) => w.isDefault)?.id ?? list[0]?.id ?? null);
  return c.json({
    data: {
      user: sanitizeUser(user as unknown as Record<string, unknown>),
      tenant: tenant
        ? { id: tenant.id, name: tenant.name, status: tenant.status, type: tenant.type }
        : null,
      workspaces: list,
      activeWorkspaceId,
    },
  });
});

me.post("/active-workspace", async (c) => {
  const s = c.get("session");
  const body = await readJson(c);
  const workspaceId = String(body["workspaceId"] ?? "");
  if (!workspaceId) throw new HttpError(400, "workspaceId required", "INVALID_BODY");
  const db = getDb(c.env.DB);
  const allowed = await allowedWorkspaceIds(db, s);
  if (allowed !== null && !allowed.includes(workspaceId)) {
    throw new HttpError(403, "Workspace not accessible", "WORKSPACE_FORBIDDEN");
  }
  await db
    .update(users)
    .set({ activeWorkspaceId: workspaceId, updatedAt: new Date() })
    .where(eq(users.id, s.userId));
  return c.json({ data: { ok: true, activeWorkspaceId: workspaceId } });
});

me.patch("/account", requireRole("accountOwner", "platformAdmin"), async (c) => {
  const s = c.get("session");
  const body = await readJson(c);
  const patch: Record<string, unknown> = {};
  for (const k of ["orgNumber", "billingEmail", "contactPerson", "phones", "address", "country"]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Nothing to update", "INVALID_BODY");
  }
  const db = getDb(c.env.DB);
  await db
    .update(tenants)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tenants.id, s.tenantId));
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, s.tenantId) });
  return c.json({ data: { tenant } });
});

me.delete("/workspaces/:id", async (c) => {
  const s = c.get("session");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // Only a workspace owner, the account owner, or a platform admin may delete.
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspace_id, id),
      eq(workspaceMembers.member_id, s.userId),
      eq(workspaceMembers.status, "active"),
    ),
  });
  if (!s.platformAdmin && !s.isAccountOwner && membership?.role !== "owner") {
    throw new HttpError(403, "Only the workspace owner can delete it", "FORBIDDEN");
  }
  const ws = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, id), isNull(workspaces.deletedAt)),
  });
  if (!ws) return c.json({ error: { code: "NOT_FOUND" } }, 404);
  if (!s.platformAdmin && ws.account_id !== s.tenantId) {
    throw new HttpError(403, "Workspace not accessible", "WORKSPACE_FORBIDDEN");
  }

  // Refuse while content remains — explicit, since D1 has no ON DELETE CASCADE here.
  for (const [table, col] of [
    [campaigns, campaigns.workspace_id],
    [posts, posts.workspace_id],
    [scheduledPosts, scheduledPosts.workspace_id],
  ] as const) {
    const n = await db.select({ value: count() }).from(table).where(eq(col, id));
    if ((n[0]?.value ?? 0) > 0) {
      return c.json(
        { error: { code: "WORKSPACE_NOT_EMPTY", message: "Delete or move the remaining campaigns and posts first" } },
        409,
      );
    }
  }

  // Remove files (R2 objects best-effort + rows), then memberships/settings/workspace.
  const fileRows = await db.query.files.findMany({
    where: eq(files.folder, `workspaces/${id}`),
  });
  let freedBytes = 0;
  for (const f of fileRows) {
    freedBytes += f.sizeBytes ?? 0;
    try {
      await c.env.R2.delete(f.r2Key);
    } catch {
      /* best-effort */
    }
  }
  if (fileRows.length) {
    await db.delete(files).where(inArray(files.id, fileRows.map((f) => f.id)));
  }
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspace_id, id));
  await db.delete(workspaceSettings).where(eq(workspaceSettings.workspace_id, id));
  await db.delete(workspaces).where(eq(workspaces.id, id));

  return c.json({
    data: { id, deleted: true, filesDeleted: fileRows.length, freedBytes },
  });
});

export default me;
