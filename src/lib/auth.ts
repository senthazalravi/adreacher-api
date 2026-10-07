// Auth middleware, role guards, tenant-status guard, and server-side
// workspace scoping. Port of the RULES in the old lib/access.js — the
// `svc()` wrapper is gone; scoping resolves workspace_members LIVE per
// request (no denormalized clientWorkspaceIds array).

import type { Context, Next } from "hono";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableColumns } from "drizzle-orm";
import type { Env } from "../index.js";
import { verifyJwt } from "./jwt.js";
import { HttpError } from "./filter.js";
import { getDb, type Db } from "../db/index.js";
import { users, tenants } from "../db/schema/identity.js";
import { workspaces, workspaceMembers } from "../db/schema/core.js";

export interface Session {
  userId: string;
  tenantId: string;
  email: string;
  platformAdmin: boolean;
  isAccountOwner: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    session: Session;
  }
}

export function getJwtSecret(env: Env): string {
  const s = env.JWT_SECRET || env.SECRET_KEY;
  if (!s) throw new Error("JWT_SECRET or SECRET_KEY must be set");
  return s;
}

/** Read the session attached by authMiddleware. */
export function sessionOf(c: Context): Session {
  return (c as unknown as Context<{ Variables: { session: Session } }>).get("session");
}

function bearerToken(c: Context): string | null {
  const h = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

function unauthorized(): Response {
  return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, { status: 401 });
}

class UnauthorizedError extends Error {}

/** Verify the Bearer JWT and load the session. Throws UnauthorizedError on failure. */
export async function authenticate(c: Context<{ Bindings: Env }>): Promise<Session> {
  const raw = bearerToken(c);
  if (!raw) throw new UnauthorizedError();
  let payload;
  try {
    payload = await verifyJwt(raw, getJwtSecret(c.env));
  } catch {
    throw new UnauthorizedError();
  }
  if (!payload || payload.type !== "access") throw new UnauthorizedError();

  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, payload.sub), isNull(users.deletedAt)),
  });
  if (!user) throw new UnauthorizedError();

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, payload.tenantId) });
  if (!tenant || tenant.deletedAt) throw new UnauthorizedError();

  return {
    userId: user.id,
    tenantId: tenant.id,
    email: user.email,
    platformAdmin: user.platformAdmin === true,
    isAccountOwner: tenant.ownerId === user.id,
  };
}

/** Verifies the Bearer JWT and attaches the session. 401 on missing/invalid. */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  let session: Session;
  try {
    session = await authenticate(c);
  } catch {
    return unauthorized();
  }
  (c as unknown as Context<{ Variables: { session: Session } }>).set("session", session);
  await next();
}

/** Role guard: at least one of the given roles required. */
export function requireRole(...roles: Array<"platformAdmin" | "accountOwner">) {
  return async function roleGuard(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
    const s = sessionOf(c);
    const ok = roles.some(
      (r) => (r === "platformAdmin" && s.platformAdmin) || (r === "accountOwner" && s.isAccountOwner),
    );
    if (!ok) {
      return c.json({ error: { code: "FORBIDDEN", message: "Insufficient role" } }, 403);
    }
    await next();
  };
}

/**
 * Tenant-status guard (port of the old tenant-status hook).
 * suspended → reads OK, writes → 402. closed → everything 403. Platform admins exempt.
 */
export async function tenantStatusGuard(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const s = sessionOf(c);
  if (s.platformAdmin) {
    await next();
    return;
  }
  const db = getDb(c.env.DB);
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, s.tenantId) });
  if (!tenant || tenant.status === "closed" || tenant.deletedAt) {
    return c.json({ error: { code: "TENANT_CLOSED", message: "This account is closed" } }, 403);
  }
  if (tenant.status === "suspended" && ["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method)) {
    return c.json(
      {
        error: {
          code: "TENANT_SUSPENDED",
          message: "This account is suspended — writes are disabled",
        },
      },
      402,
    );
  }
  await next();
}

/** The user's active workspace, verified against live memberships. */
export async function activeWorkspaceId(db: Db, s: Session): Promise<string | null> {
  if (s.platformAdmin) return null;
  const user = await db.query.users.findFirst({
    where: eq(users.id, s.userId),
    columns: { activeWorkspaceId: true },
  });
  const allowed = (await allowedWorkspaceIds(db, s)) ?? [];
  if (user?.activeWorkspaceId && allowed.includes(user.activeWorkspaceId)) {
    return user.activeWorkspaceId;
  }
  return allowed[0] ?? null;
}

/**
 * Workspace ids the session may touch: active memberships ∩ active workspaces
 * of the session's tenant. Resolved live per request — never cached, never
 * denormalized. Returns null for platform admins (unrestricted).
 */
export async function allowedWorkspaceIds(
  db: Db,
  session: Session,
): Promise<string[] | null> {
  if (session.platformAdmin) return null;
  const memberships = await db
    .select({ workspace_id: workspaceMembers.workspace_id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.member_id, session.userId),
        eq(workspaceMembers.status, "active"),
      ),
    );
  const ids = [...new Set(memberships.map((m) => m.workspace_id).filter((v): v is string => !!v))];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.id, ids),
        eq(workspaces.account_id, session.tenantId),
        eq(workspaces.status, "active"),
        isNull(workspaces.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Extra WHERE fragment enforcing server-side scoping for an /items table.
 * Undefined = unrestricted (platform admin, or a table with no scoping columns).
 */
export async function scopeItemsWhere(
  c: Context<{ Bindings: Env }>,
  table: SQLiteTable,
  tableName: string,
): Promise<SQL | undefined> {
  const s = sessionOf(c);
  if (!s) return undefined;
  if (s.platformAdmin) return undefined;
  const cols = getTableColumns(table) as Record<string, AnySQLiteColumn>;
  const db = getDb(c.env.DB);

  // Never expose token rows through /items to non-admins.
  if (tableName === "user_tokens") {
    const idCol = cols["id"];
    return idCol ? eq(idCol, "__none__") : undefined;
  }
  if (tableName === "users") {
    const tenantCol = cols["tenantId"];
    const idCol = cols["id"];
    if (s.isAccountOwner && tenantCol) return eq(tenantCol, s.tenantId);
    return idCol ? eq(idCol, s.userId) : undefined;
  }
  if (tableName === "tenants") {
    const idCol = cols["id"];
    return idCol ? eq(idCol, s.tenantId) : undefined;
  }
  if (tableName === "campaign_templates") {
    // The shared template gallery (isGallery) is readable by every workspace,
    // alongside the caller's own templates — the frontend's library query
    // relies on this; without it gallery rows only reach their owner tenant.
    const wsCol2 = cols["workspace_id"];
    const galCol = cols["isGallery"];
    if (wsCol2 && galCol) {
      const allowed = await allowedWorkspaceIds(db, s);
      return or(inArray(wsCol2, allowed ?? []), eq(galCol, true)) as SQL;
    }
  }
  if (tableName === "agency_clients") {
    const agencyCol = cols["agency_id"];
    const clientCol = cols["client_id"];
    if (agencyCol && clientCol) {
      return or(eq(agencyCol, s.tenantId), eq(clientCol, s.tenantId)) as SQL;
    }
    return undefined;
  }

  const wsCol = cols["workspace_id"];
  if (wsCol) {
    const allowed = await allowedWorkspaceIds(db, s);
    // allowed === null handled above (platform admin). Empty array → matches nothing.
    return inArray(wsCol, allowed ?? []);
  }
  const acctCol = cols["account_id"];
  if (acctCol) {
    return eq(acctCol, s.tenantId);
  }
  const tenantCol = cols["tenantId"];
  if (tenantCol) {
    return eq(tenantCol, s.tenantId);
  }
  return undefined;
}

/**
 * Enforce scoping on writes: stamp the tenant, and reject workspace ids the
 * session may not touch. Mutates a copy of `values` and returns it.
 */
export async function enforceWriteScope(
  c: Context<{ Bindings: Env }>,
  table: SQLiteTable,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const s = sessionOf(c);
  if (!s) return values;
  if (s.platformAdmin) return values;
  const cols = getTableColumns(table) as Record<string, AnySQLiteColumn>;
  const out = { ...values };
  const db = getDb(c.env.DB);

  const wsCol = cols["workspace_id"];
  if (wsCol) {
    if (out["workspace_id"] == null) {
      // Default new rows into the user's active workspace so they stay
      // visible to their own tenant (NULL workspace rows would be
      // filtered out by the read scope).
      const active = await activeWorkspaceId(db, s);
      if (active) out["workspace_id"] = active;
    } else {
      const allowed = await allowedWorkspaceIds(db, s);
      if (!allowed || !allowed.includes(String(out["workspace_id"]))) {
        throw new HttpError(403, "Workspace not accessible", "WORKSPACE_FORBIDDEN");
      }
    }
  }
  const acctCol = cols["account_id"];
  if (acctCol) {
    if (out["account_id"] != null && out["account_id"] !== s.tenantId) {
      throw new HttpError(403, "Cross-tenant write denied", "TENANT_FORBIDDEN");
    }
    out["account_id"] = s.tenantId;
  }
  const tenantCol = cols["tenantId"];
  if (tenantCol) {
    if (out["tenantId"] != null && out["tenantId"] !== s.tenantId) {
      throw new HttpError(403, "Cross-tenant write denied", "TENANT_FORBIDDEN");
    }
    out["tenantId"] = s.tenantId;
  }
  return out;
}
