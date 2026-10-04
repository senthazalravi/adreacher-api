// Super-admin API (Phase 8): cross-tenant administration for platform admins.
// Mounted by src/index.ts via app.route("/", router) — do not mount here.
// Every route is {data}-wrapped. Audit entries are written best-effort and
// never throw.
//
// Guard model (default deny):
//   router.use("/super-admin*", authMiddleware);
//   router.use("/super-admin*", requireRole("platformAdmin"));
// The two shadow lifecycle endpoints (/shadow/status, /shadow/stop) run their
// own inline checks instead: a shadow session's Bearer token names the
// impersonated user (who is not an admin), so the blanket platformAdmin guard
// would lock the admin out of exactly the endpoints that manage shadowing.

import { Hono, type Context } from "hono";
import { and, asc, count, desc, eq, gte, inArray, isNull, like, lte, or } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import {
  agencyClients,
  aiSettings,
  auditLog,
  billingSettings,
  jobRuns,
  subscriptionPlans,
  subscriptions,
  tenants,
  usageCounters,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema/index.js";
import type { Env } from "../index.js";
import {
  authMiddleware,
  requireRole,
  sessionOf,
  getJwtSecret,
  type Session,
} from "../lib/auth.js";
import { HttpError } from "../lib/filter.js";
import { signJwt, verifyJwt } from "../lib/jwt.js";
import { JOBS, jobContext } from "../jobs/index.js";
import { recordRun } from "../lib/job-runs.js";
import { hashPassword } from "../lib/password.js";
import { sendMail, linkEmail } from "../lib/mail.js";
import { stripeClient } from "../lib/stripe.js";

const router = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

router.use("/super-admin*", authMiddleware);
// See header comment: the shadow lifecycle endpoints verify the session
// themselves (a shadow token's sub is the impersonated non-admin user).
const platformAdminGuard = requireRole("platformAdmin");
router.use("/super-admin*", async (c, next) => {
  const p = c.req.path;
  if (p === "/super-admin/shadow/status" || p === "/super-admin/shadow/stop") {
    await next();
    return;
  }
  return platformAdminGuard(c, next);
});
router.use("/admin/audit-logs*", authMiddleware);
router.use("/admin/audit-logs*", platformAdminGuard);
router.use("/workers/metrics", authMiddleware);
router.use("/workers/metrics", platformAdminGuard);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TENANT_STATUSES = ["active", "suspended", "closed"] as const;
const MEMBER_ROLES = ["owner", "admin", "editor", "approver", "viewer"] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Pure guard helper — mirrors what requireRole("platformAdmin") enforces. */
export function isPlatformAdmin(s: Pick<Session, "platformAdmin">): boolean {
  return s.platformAdmin === true;
}

/** Best-effort audit entry — never throws, never blocks the request. */
async function logAudit(
  db: Db,
  entry: {
    tenantId?: string | null;
    userId?: string | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    meta?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      tenantId: entry.tenantId ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      meta: (entry.meta ?? null) as Record<string, any> | null,
    });
  } catch {
    /* audit logging is best-effort */
  }
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

/** Like readJson, but an empty/missing body is fine (returns {}). */
async function readJsonOptional(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    /* empty body is fine */
  }
  return {};
}

function appUrl(env: Env): string {
  return (env.APP_URL || "https://adreacher.app").replace(/\/+$/, "");
}

function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "account";
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Public user shape — never leak passwordHash / totpSecret. */
function publicUser(u: Record<string, any>): Record<string, any> {
  const { passwordHash: _ph, totpSecret: _ts, ...rest } = u;
  return rest;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Escape one CSV cell (RFC 4180): quote when it contains , " CR or LF. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Render audit rows as CSV (columns: createdAt,action,entityType,entityId,userId,tenantId,meta). */
export function auditLogsToCsv(rows: Array<Record<string, any>>): string {
  const header = "createdAt,action,entityType,entityId,userId,tenantId,meta";
  const lines = rows.map((r) =>
    [
      iso(r["createdAt"]) ?? "",
      r["action"] ?? "",
      r["entityType"] ?? "",
      r["entityId"] ?? "",
      r["userId"] ?? "",
      r["tenantId"] ?? "",
      r["meta"] == null ? "" : JSON.stringify(r["meta"]),
    ]
      .map(csvEscape)
      .join(","),
  );
  return [header, ...lines].join("\r\n");
}

function pagination(total: number, limit: number, offset: number) {
  return {
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pages: Math.ceil(total / limit),
  };
}

/** Shared ?userId=&action=&entityType=&entityId=&startDate=&endDate= filter compiler. */
function auditFilterConds(c: AppContext) {
  const conds = [];
  const userId = c.req.query("userId");
  if (userId) conds.push(eq(auditLog.userId, userId));
  const action = c.req.query("action");
  if (action) conds.push(eq(auditLog.action, action));
  const entityType = c.req.query("entityType");
  if (entityType) conds.push(eq(auditLog.entityType, entityType));
  const entityId = c.req.query("entityId");
  if (entityId) conds.push(eq(auditLog.entityId, entityId));
  const startDate = c.req.query("startDate");
  if (startDate) {
    const d = new Date(startDate);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, "startDate must be a valid date", "INVALID_QUERY");
    conds.push(gte(auditLog.createdAt, d));
  }
  const endDate = c.req.query("endDate");
  if (endDate) {
    const d = new Date(endDate);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, "endDate must be a valid date", "INVALID_QUERY");
    conds.push(lte(auditLog.createdAt, d));
  }
  return conds;
}

/** Record an AI connectivity-test outcome on the singleton ai_settings row (best-effort). */
async function recordAiTest(
  env: Env,
  provider: "gemini" | "fal",
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    const db = getDb(env.DB);
    const rows = await db
      .select({ id: aiSettings.id, lastTest: aiSettings.lastTest })
      .from(aiSettings)
      .limit(1);
    const prev = (rows[0]?.lastTest ?? {}) as Record<string, unknown>;
    const merged = { ...prev, [provider]: entry };
    if (rows[0]) {
      await db
        .update(aiSettings)
        .set({ lastTest: merged as Record<string, any>, updatedAt: new Date() })
        .where(eq(aiSettings.id, rows[0].id));
    } else {
      await db.insert(aiSettings).values({ lastTest: merged as Record<string, any> });
    }
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------

/** GET /super-admin/tenants?q= — tenants with owner, workspace count, subscription. */
router.get("/super-admin/tenants", async (c) => {
  const db = getDb(c.env.DB);
  const q = (c.req.query("q") ?? "").trim();
  const where = q
    ? and(isNull(tenants.deletedAt), like(tenants.name, `%${q}%`))
    : isNull(tenants.deletedAt);
  const rows = await db.select().from(tenants).where(where).orderBy(asc(tenants.name));
  const data = await Promise.all(
    rows.map(async (t) => {
      const owner = t.ownerId
        ? await db.query.users.findFirst({
            where: eq(users.id, t.ownerId),
            columns: { id: true, email: true, firstName: true, lastName: true },
          })
        : null;
      const wsCount = await db
        .select({ n: count() })
        .from(workspaces)
        .where(and(eq(workspaces.account_id, t.id), isNull(workspaces.deletedAt)));
      const sub = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.account_id, t.id),
        orderBy: [desc(subscriptions.createdAt)],
      });
      let plan: { slug: string; name: string } | null = null;
      if (sub?.plan_id) {
        const p = await db.query.subscriptionPlans.findFirst({
          where: eq(subscriptionPlans.id, sub.plan_id),
        });
        if (p) plan = { slug: p.slug, name: p.name };
      }
      // Fetch workspaces for this tenant (frontend expects array)
      const wsRows = await db
        .select({ id: workspaces.id, name: workspaces.name, onboardingState: workspaces.onboardingState })
        .from(workspaces)
        .where(and(eq(workspaces.account_id, t.id), isNull(workspaces.deletedAt)));
      // Count members across workspaces
      const wsIds = wsRows.map((w) => w.id);
      let memberCount = 0;
      if (wsIds.length > 0) {
        const mc = await db
          .select({ n: count() })
          .from(workspaceMembers)
          .where(inArray(workspaceMembers.workspace_id, wsIds));
        memberCount = mc[0]?.n ?? 0;
      }
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        type: t.type,
        status: t.status,
        tenant_Id: t.id,
        planSlug: t.planSlug,
        billingEmail: t.billingEmail,
        contactPerson: t.contactPerson,
        country: t.country,
        createdAt: t.createdAt,
        owner: owner
          ? { id: owner.id, email: owner.email, firstName: owner.firstName, lastName: owner.lastName }
          : null,
        workspaceCount: wsCount[0]?.n ?? 0,
        workspaces: wsRows.map((w) => ({ id: w.id, name: w.name, onboardingState: w.onboardingState ?? 'pending' })),
        memberCount,
        features: {},
        subscription: sub
          ? {
              id: sub.id,
              status: sub.status,
              planId: sub.plan_id,
              planSlug: plan?.slug ?? null,
              planName: plan?.name ?? null,
              trialEndsAt: sub.trialEndsAt,
            }
          : null,
      };
    }),
  );
  return c.json({ data });
});

/** PATCH /super-admin/tenants/:id/status — active|suspended|closed. */
router.patch("/super-admin/tenants/:id/status", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const tenant_Id = c.req.param("id");
  const body = await readJson(c);
  const status = String(body["status"] ?? "");
  if (!(TENANT_STATUSES as readonly string[]).includes(status)) {
    throw new HttpError(
      400,
      `status must be one of ${TENANT_STATUSES.join(", ")}`,
      "INVALID_STATUS",
    );
  }
  const tenant = await db.query.tenants.findFirst({
    where: and(eq(tenants.id, tenant_Id), isNull(tenants.deletedAt)),
  });
  if (!tenant) throw new HttpError(404, "Tenant not found", "NOT_FOUND");
  await db
    .update(tenants)
    .set({ status: status as (typeof TENANT_STATUSES)[number], updatedAt: new Date() })
    .where(eq(tenants.id, tenant_Id));
  // NOTE: the users table has no status column in this schema, so per-user
  // mirroring on "closed" is intentionally skipped (reported to the parent).
  await logAudit(db, {
    tenantId: tenant_Id,
    userId: s.userId,
    action: "tenant.status.updated",
    entityType: "tenant",
    entityId: tenant_Id,
    meta: { from: tenant.status, to: status },
  });
  return c.json({ data: { tenant_Id, status } });
});

/** POST /super-admin/tenants/:id/plan — assign a subscription plan to a tenant
 * (body: { planSlug } or { planId }). Upserts the tenant's subscription row. */
router.post("/super-admin/tenants/:id/plan", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const tenant_Id = c.req.param("id");
  const body = await readJson(c);
  const planRef = String(body["planSlug"] ?? body["planId"] ?? "").trim();
  if (!planRef) throw new HttpError(400, "planSlug or planId is required", "INVALID_BODY");
  const tenant = await db.query.tenants.findFirst({
    where: and(eq(tenants.id, tenant_Id), isNull(tenants.deletedAt)),
  });
  if (!tenant) throw new HttpError(404, "Tenant not found", "NOT_FOUND");
  const plan =
    (await db.query.subscriptionPlans.findFirst({ where: eq(subscriptionPlans.slug, planRef) })) ??
    (await db.query.subscriptionPlans.findFirst({ where: eq(subscriptionPlans.id, planRef) }));
  if (!plan) throw new HttpError(404, `Plan "${planRef}" not found`, "PLAN_NOT_FOUND");
  const existing = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.account_id, tenant_Id),
  });
  const now = new Date();
  let sub;
  if (existing) {
    await db
      .update(subscriptions)
      .set({ plan_id: plan.id, updatedAt: now })
      .where(eq(subscriptions.id, existing.id));
    sub = { ...existing, plan_id: plan.id };
  } else {
    const inserted = await db
      .insert(subscriptions)
      .values({ account_id: tenant_Id, plan_id: plan.id, status: "active" })
      .returning();
    sub = inserted[0];
    if (!sub) throw new HttpError(500, "Subscription creation failed", "CREATE_FAILED");
  }
  await logAudit(db, {
    tenantId: tenant_Id,
    userId: s.userId,
    action: "tenant.plan.assigned",
    entityType: "tenant",
    entityId: tenant_Id,
    meta: { planSlug: plan.slug, planId: plan.id },
  });
  return c.json({ data: { tenant_Id, planSlug: plan.slug, planId: plan.id, subscriptionId: sub.id } });
});

/**
 * PATCH /super-admin/tenants/:id/features — NOT IMPLEMENTED.
 * The old backend stored feature flags in baasix_Settings.modules, but this
 * schema has no tenant-level settings table (tenants has no features column;
 * workspaceSettings is per-workspace). Needs a migration before it can work.
 */
router.patch("/super-admin/tenants/:id/features", async () => {
  throw new HttpError(
    501,
    "Tenant feature flags have no storage yet: the schema has no tenant-level settings table. Add a migration before enabling this endpoint.",
    "NOT_IMPLEMENTED",
  );
});

/** POST /super-admin/tenants/:id/send-credentials — reset the owner password + email it. */
router.post("/super-admin/tenants/:id/send-credentials", async (c) => {
  const db = getDb(c.env.DB);
  const tenant_Id = c.req.param("id");
  const tenant = await db.query.tenants.findFirst({
    where: and(eq(tenants.id, tenant_Id), isNull(tenants.deletedAt)),
  });
  if (!tenant) throw new HttpError(404, "Tenant not found", "NOT_FOUND");
  if (!tenant.ownerId) throw new HttpError(404, "Tenant has no owner user", "OWNER_NOT_FOUND");
  const owner = await db.query.users.findFirst({
    where: and(eq(users.id, tenant.ownerId), isNull(users.deletedAt)),
  });
  if (!owner) throw new HttpError(404, "Tenant owner user not found", "OWNER_NOT_FOUND");

  const body = await readJsonOptional(c);
  let tempPassword: string;
  if (typeof body["password"] === "string" && body["password"].length > 0) {
    if (body["password"].length < 6) {
      throw new HttpError(400, "Password must be at least 6 characters", "WEAK_PASSWORD");
    }
    tempPassword = body["password"];
  } else {
    tempPassword = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(tempPassword), updatedAt: new Date() })
    .where(eq(users.id, owner.id));

  const loginUrl = `${appUrl(c.env)}/signin`;
  let emailed = false;
  try {
    const mail = linkEmail({
      appUrl: appUrl(c.env),
      heading: "Your AdReacher login credentials",
      body: `A temporary password was created for ${owner.email} by a platform administrator. Sign in and change it right away.`,
      ctaUrl: loginUrl,
      ctaLabel: "Sign in to AdReacher",
    });
    await sendMail(c.env, {
      to: owner.email,
      subject: "AdReacher — your login credentials",
      html: mail.html,
      text: `${mail.text}\n\nTemporary password: ${tempPassword}`,
    });
    emailed = true;
  } catch (e) {
    console.error("[super-admin] send-credentials email failed:", (e as Error)?.message || e);
  }
  return c.json({
    data: { tenantId: tenant_Id, userId: owner.id, email: owner.email, tempPassword, emailed },
  });
});

/** POST /super-admin/agencies — create an agency tenant + owner user. */
router.post("/super-admin/agencies", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const body = await readJson(c);
  const name = String(body["name"] ?? "").trim();
  const email = String(body["email"] ?? "").toLowerCase().trim();
  const password = String(body["password"] ?? "");
  if (!name) throw new HttpError(400, "name is required", "INVALID_BODY");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Valid email required", "INVALID_EMAIL");
  if (password.length < 6) {
    throw new HttpError(400, "Password must be at least 6 characters", "WEAK_PASSWORD");
  }
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) throw new HttpError(409, "A user with this email already exists", "USER_EXISTS");

  const insertedUser = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(password),
      firstName: typeof body["firstName"] === "string" ? body["firstName"] : null,
      lastName: typeof body["lastName"] === "string" ? body["lastName"] : null,
      emailVerified: true,
    })
    .returning({ id: users.id });
  const userId = insertedUser[0]?.id;
  if (!userId) throw new HttpError(500, "Agency creation failed", "CREATE_FAILED");

  const insertedTenant = await db
    .insert(tenants)
    .values({
      name,
      slug: slugify(name),
      type: "agency",
      status: "active",
      ownerId: userId,
      billingEmail: email,
    })
    .returning({ id: tenants.id });
  const tenantId = insertedTenant[0]?.id;
  if (!tenantId) throw new HttpError(500, "Agency creation failed", "CREATE_FAILED");

  await db
    .update(users)
    .set({ tenantId, updatedAt: new Date() })
    .where(eq(users.id, userId));

  let emailed = false;
  try {
    const mail = linkEmail({
      appUrl: appUrl(c.env),
      heading: "Your AdReacher agency account",
      body: `Your agency account "${name}" is ready. Sign in with this email address and the password your administrator set.`,
      ctaUrl: `${appUrl(c.env)}/signin`,
      ctaLabel: "Sign in to AdReacher",
    });
    await sendMail(c.env, { to: email, subject: mail.subject, html: mail.html, text: mail.text });
    emailed = true;
  } catch (e) {
    console.error("[super-admin] agency credentials email failed:", (e as Error)?.message || e);
  }

  await logAudit(db, {
    tenantId,
    userId: s.userId,
    action: "agency.created",
    entityType: "tenant",
    entityId: tenantId,
    meta: { name, email },
  });
  return c.json(
    { data: { tenantId, userId, agencyName: name, email, emailed } },
    201,
  );
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/** GET /super-admin/users/filters — distinct tenants + roles for the admin UI. */
router.get("/super-admin/users/filters", async (c) => {
  const db = getDb(c.env.DB);
  const tRows = await db
    .select({ id: tenants.id, name: tenants.name, type: tenants.type })
    .from(tenants)
    .where(isNull(tenants.deletedAt))
    .orderBy(asc(tenants.name));
  const rRows = await db.selectDistinct({ role: workspaceMembers.role }).from(workspaceMembers);
  const roles: string[] = [
    "platformAdmin",
    ...rRows
      .map((r) => r.role)
      .filter((r): r is MemberRole => r != null)
      .sort(),
  ];
  return c.json({
    data: {
      tenants: tRows.map((t) => ({ tenant_Id: t.id, name: t.name, type: t.type })),
      roles,
    },
  });
});

/** GET /super-admin/users?q=&tenant_Id=&role=&page=&limit= — paged, with memberships. */
router.get("/super-admin/users", async (c) => {
  const db = getDb(c.env.DB);
  const q = (c.req.query("q") ?? "").trim();
  const tenant_Id = c.req.query("tenant_Id");
  const role = c.req.query("role");
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 100);
  const offset = (page - 1) * limit;

  const conds = [isNull(users.deletedAt)];
  if (tenant_Id) conds.push(eq(users.tenantId, tenant_Id));
  if (q) {
    const likeQ = `%${q}%`;
    conds.push(or(like(users.email, likeQ), like(users.firstName, likeQ), like(users.lastName, likeQ))!);
  }
  if (role === "platformAdmin") {
    conds.push(eq(users.platformAdmin, true));
  } else if (role) {
    if (!(MEMBER_ROLES as readonly string[]).includes(role)) {
      throw new HttpError(400, `Unknown role "${role}"`, "INVALID_ROLE");
    }
    const mems = await db
      .select({ member_id: workspaceMembers.member_id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.role, role as MemberRole));
    const ids = [...new Set(mems.map((m) => m.member_id).filter((v): v is string => !!v))];
    if (ids.length === 0) {
      return c.json({ data: [], pagination: pagination(0, limit, offset) });
    }
    conds.push(inArray(users.id, ids));
  }

  const where = and(...conds);
  const totalRows = await db.select({ n: count() }).from(users).where(where);
  const total = totalRows[0]?.n ?? 0;
  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const data = await Promise.all(
    rows.map(async (u) => {
      const memberships = await db
        .select({
          workspace_id: workspaceMembers.workspace_id,
          role: workspaceMembers.role,
          status: workspaceMembers.status,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.member_id, u.id));
      const wsIds = [
        ...new Set(memberships.map((m) => m.workspace_id).filter((v): v is string => !!v)),
      ];
      const wsRows =
        wsIds.length > 0
          ? await db
              .select({ id: workspaces.id, name: workspaces.name })
              .from(workspaces)
              .where(and(inArray(workspaces.id, wsIds), isNull(workspaces.deletedAt)))
          : [];
      const wsName = new Map(wsRows.map((w) => [w.id, w.name]));
      const tenantRow = u.tenantId
        ? await db.query.tenants.findFirst({ where: eq(tenants.id, u.tenantId) })
        : null;
      return {
        ...publicUser(u as unknown as Record<string, any>),
        tenant: tenantRow
          ? { id: tenantRow.id, name: tenantRow.name, type: tenantRow.type, status: tenantRow.status }
          : null,
        memberships: memberships.map((m) => ({
          workspaceId: m.workspace_id,
          workspaceName: wsName.get(m.workspace_id ?? "") ?? null,
          role: m.role,
          status: m.status,
        })),
      };
    }),
  );
  return c.json({ data, pagination: pagination(total, limit, offset) });
});

/** POST /super-admin/users/:id/grant-tenant-admin — flip the user's tenant to agency. */
router.post("/super-admin/users/:id/grant-tenant-admin", async (c) => {
  const db = getDb(c.env.DB);
  const userId = c.req.param("id");
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
  });
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
  if (!user.tenantId) throw new HttpError(400, "User has no tenant", "NO_TENANT");
  await db
    .update(tenants)
    .set({ type: "agency", updatedAt: new Date() })
    .where(eq(tenants.id, user.tenantId));
  return c.json({ data: { accountId: user.tenantId, type: "agency" } });
});

/** POST /super-admin/users/:id/revoke-tenant-admin — flip the user's tenant back to client. */
router.post("/super-admin/users/:id/revoke-tenant-admin", async (c) => {
  const db = getDb(c.env.DB);
  const userId = c.req.param("id");
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
  });
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
  if (!user.tenantId) throw new HttpError(400, "User has no tenant", "NO_TENANT");
  await db
    .update(tenants)
    .set({ type: "client", updatedAt: new Date() })
    .where(eq(tenants.id, user.tenantId));
  return c.json({ data: { accountId: user.tenantId, type: "client" } });
});

// ---------------------------------------------------------------------------
// agency organizations (agency_clients links)
// ---------------------------------------------------------------------------

/** POST /super-admin/organizations/:orgId/members — link a client tenant to an agency. */
router.post("/super-admin/organizations/:orgId/members", async (c) => {
  const db = getDb(c.env.DB);
  const orgId = c.req.param("orgId");
  const org = await db.query.tenants.findFirst({
    where: and(eq(tenants.id, orgId), isNull(tenants.deletedAt)),
  });
  if (!org) throw new HttpError(404, "Organization not found", "NOT_FOUND");
  if (org.type !== "agency") {
    throw new HttpError(400, "Organization is not an agency", "NOT_AGENCY");
  }
  const body = await readJson(c);
  let accountId = typeof body["accountId"] === "string" ? body["accountId"] : null;
  const userId = typeof body["userId"] === "string" ? body["userId"] : null;
  if (!accountId && userId) {
    const u = await db.query.users.findFirst({
      where: and(eq(users.id, userId), isNull(users.deletedAt)),
    });
    if (!u) throw new HttpError(404, "User not found", "NOT_FOUND");
    if (!u.tenantId) throw new HttpError(400, "User has no tenant", "NO_TENANT");
    accountId = u.tenantId;
  }
  if (!accountId) throw new HttpError(400, "accountId or userId is required", "INVALID_BODY");
  const client = await db.query.tenants.findFirst({
    where: and(eq(tenants.id, accountId), isNull(tenants.deletedAt)),
  });
  if (!client) throw new HttpError(404, "Client account not found", "NOT_FOUND");
  if (accountId === orgId) {
    throw new HttpError(400, "An agency cannot be its own client", "INVALID_BODY");
  }
  const existing = await db.query.agencyClients.findFirst({
    where: and(eq(agencyClients.agency_id, orgId), eq(agencyClients.client_id, accountId)),
  });
  if (existing && existing.status === "active") {
    throw new HttpError(409, "Client is already linked to this agency", "ALREADY_MEMBER");
  }
  let rowId: string;
  if (existing) {
    await db
      .update(agencyClients)
      .set({ status: "active", engagementStartedAt: new Date(), updatedAt: new Date() })
      .where(eq(agencyClients.id, existing.id));
    rowId = existing.id;
  } else {
    const inserted = await db
      .insert(agencyClients)
      .values({ agency_id: orgId, client_id: accountId, status: "active", engagementStartedAt: new Date() })
      .returning({ id: agencyClients.id });
    const id = inserted[0]?.id;
    if (!id) throw new HttpError(500, "Failed to link client", "CREATE_FAILED");
    rowId = id;
  }
  return c.json({ data: { id: rowId, agencyId: orgId, clientId: accountId, status: "active" } }, 201);
});

/** DELETE /super-admin/organizations/:orgId/members/:id — end the agency-client link. */
router.delete("/super-admin/organizations/:orgId/members/:id", async (c) => {
  const db = getDb(c.env.DB);
  const orgId = c.req.param("orgId");
  const id = c.req.param("id");
  // :id may be the agency_clients row id or the client tenant id.
  const rows = await db
    .select()
    .from(agencyClients)
    .where(
      and(eq(agencyClients.agency_id, orgId), or(eq(agencyClients.id, id), eq(agencyClients.client_id, id))!),
    );
  if (rows.length === 0) throw new HttpError(404, "Membership not found", "NOT_FOUND");
  for (const r of rows) {
    await db
      .update(agencyClients)
      .set({ status: "ended", engagementEndedAt: new Date(), updatedAt: new Date() })
      .where(eq(agencyClients.id, r.id));
  }
  return c.json({ data: { agencyId: orgId, ended: rows.map((r) => r.id) } });
});

// ---------------------------------------------------------------------------
// shadow (impersonation)
// ---------------------------------------------------------------------------

/** GET /super-admin/shadow/status — is the current Bearer token a shadow token? */
router.get("/super-admin/shadow/status", async (c) => {
  const h = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  let isShadowing = false;
  let shadowedBy: string | null = null;
  if (m?.[1]) {
    try {
      const payload = await verifyJwt(m[1], getJwtSecret(c.env));
      if (payload && payload.shadow === true) {
        isShadowing = true;
        shadowedBy = typeof payload.shadowedBy === "string" ? payload.shadowedBy : null;
      }
    } catch {
      /* treat an unreadable token as not shadowing */
    }
  }
  return c.json({ data: { isShadowing, shadowedBy } });
});

/**
 * POST /super-admin/shadow/stop — confirm leaving shadow mode.
 * The client swaps back to the admin's own token first; the server just
 * confirms the caller is a platform admin (client-side token swap).
 */
router.post("/super-admin/shadow/stop", async (c) => {
  const s = sessionOf(c);
  if (!isPlatformAdmin(s)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Only a platform admin can stop shadowing" } },
      403,
    );
  }
  return c.json({ data: { stopped: true, user: { id: s.userId, email: s.email } } });
});

/** POST /super-admin/shadow/:userId — mint a shadow (impersonation) token. */
router.post("/super-admin/shadow/:userId", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const targetId = c.req.param("userId");
  const target = await db.query.users.findFirst({
    where: and(eq(users.id, targetId), isNull(users.deletedAt)),
  });
  if (!target) throw new HttpError(404, "User not found", "NOT_FOUND");
  if (target.platformAdmin === true) {
    throw new HttpError(403, "Cannot shadow another administrator", "SHADOW_FORBIDDEN");
  }
  const body = await readJsonOptional(c);
  let tenant_Id = target.tenantId;
  const wanted = typeof body["tenant_Id"] === "string" ? body["tenant_Id"] : null;
  if (wanted) {
    const t = await db.query.tenants.findFirst({
      where: and(eq(tenants.id, wanted), isNull(tenants.deletedAt)),
    });
    if (!t) throw new HttpError(404, "Tenant not found", "NOT_FOUND");
    const belongs =
      t.id === target.tenantId ||
      t.ownerId === target.id ||
      (
        await db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.member_id, target.id),
              eq(workspaceMembers.account_id, wanted),
            ),
          )
          .limit(1)
      ).length > 0;
    if (!belongs) throw new HttpError(400, "User does not belong to that tenant", "TENANT_MISMATCH");
    tenant_Id = wanted;
  }
  if (!tenant_Id) throw new HttpError(400, "Target user has no tenant to shadow into", "NO_TENANT");
  const token = await signJwt(
    { sub: target.id, tenantId: tenant_Id, type: "access", shadow: true, shadowedBy: s.userId },
    getJwtSecret(c.env),
  );
  await logAudit(db, {
    tenantId: s.tenantId,
    userId: s.userId,
    action: "admin.shadow.start",
    entityType: "user",
    entityId: target.id,
    meta: { tenant_Id },
  });
  return c.json({
    data: {
      token,
      tenant_Id,
      user: {
        id: target.id,
        email: target.email,
        firstName: target.firstName,
        lastName: target.lastName,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// AI settings (connectivity checks — never leak secret values)
// ---------------------------------------------------------------------------

/** GET /super-admin/ai-settings/env — which provider keys are configured (booleans only). */
router.get("/super-admin/ai-settings/env", (c) => {
  return c.json({
    data: {
      hasGemini: !!c.env.GEMINI_API_KEY,
      hasFal: !!(c.env.FAL_API_KEY || c.env.FAL_KEY),
    },
  });
});

/** POST /super-admin/ai-settings/test — tiny Gemini generateContent probe. */
router.post("/super-admin/ai-settings/test", async (c) => {
  const apiKey = c.env.GEMINI_API_KEY;
  const model = c.env.AI_TEXT_MODEL || "gemini-2.5-flash";
  if (!apiKey) {
    return c.json({ data: { success: false, message: "GEMINI_API_KEY is not configured" } });
  }
  let success = false;
  let message = "";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Return ONLY this JSON: {"ok": true}' }] }],
        }),
      },
    );
    const text = await res.text().catch(() => "");
    if (res.ok) {
      success = true;
      message = "Gemini responded OK";
    } else {
      message = `Gemini request failed (${res.status}): ${text.slice(0, 200)}`;
    }
  } catch (e) {
    message = `Gemini request failed: ${(e as Error)?.message || e}`;
  }
  await recordAiTest(c.env, "gemini", {
    at: new Date().toISOString(),
    success,
    message,
    model,
  });
  return c.json({ data: { success, message, model } });
});

/** POST /super-admin/ai-settings/test-fal — fal queue status probe (ok if not 401/403). */
router.post("/super-admin/ai-settings/test-fal", async (c) => {
  const key = c.env.FAL_API_KEY || c.env.FAL_KEY;
  if (!key) {
    return c.json({ data: { success: false, message: "FAL_API_KEY is not configured" } });
  }
  const db = getDb(c.env.DB);
  let model = "fal-ai/flux/dev";
  try {
    const rows = await db.select({ imageModel: aiSettings.imageModel }).from(aiSettings).limit(1);
    if (rows[0]?.imageModel) model = rows[0].imageModel;
  } catch {
    /* fall back to the default model */
  }
  let success = false;
  let message = "";
  try {
    // A queue status lookup for a bogus request id: fal answers 404 when the
    // key is valid and 401/403 when it is not — either way the key check runs.
    const res = await fetch(
      `https://queue.fal.run/${model}/requests/adreacher-key-check/status`,
      { headers: { Authorization: `Key ${key}` } },
    );
    if (res.status === 401 || res.status === 403) {
      message = `fal rejected the key (${res.status})`;
    } else {
      success = true;
      message = `fal accepted the key (probe answered ${res.status})`;
    }
  } catch (e) {
    message = `fal request failed: ${(e as Error)?.message || e}`;
  }
  await recordAiTest(c.env, "fal", { at: new Date().toISOString(), success, message });
  return c.json({ data: { success, message } });
});

// ---------------------------------------------------------------------------
// audit logs
// ---------------------------------------------------------------------------

/** GET /super-admin/audit-logs?... — paged, newest first. */
router.get("/super-admin/audit-logs", async (c) => {
  const db = getDb(c.env.DB);
  const conds = auditFilterConds(c);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const totalRows = await db.select({ n: count() }).from(auditLog).where(where);
  const total = totalRows[0]?.n ?? 0;
  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ data: rows, pagination: pagination(total, limit, offset) });
});

/** GET /super-admin/audit-logs/export — same filters, CSV download, max 5000 rows. */
router.get("/super-admin/audit-logs/export", async (c) => {
  const db = getDb(c.env.DB);
  const conds = auditFilterConds(c);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(5000);
  const csv = auditLogsToCsv(rows as unknown as Array<Record<string, any>>);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

/** GET /admin/audit-logs/user/:userId — entries for one user, paged. */
router.get("/admin/audit-logs/user/:userId", async (c) => {
  const db = getDb(c.env.DB);
  const userId = c.req.param("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const where = eq(auditLog.userId, userId);
  const totalRows = await db.select({ n: count() }).from(auditLog).where(where);
  const total = totalRows[0]?.n ?? 0;
  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ data: rows, pagination: pagination(total, limit, offset) });
});

/** GET /admin/audit-logs/entity/:type/:id — entries for one entity, paged. */
router.get("/admin/audit-logs/entity/:type/:id", async (c) => {
  const db = getDb(c.env.DB);
  const type = c.req.param("type");
  const id = c.req.param("id");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const where = and(eq(auditLog.entityType, type), eq(auditLog.entityId, id));
  const totalRows = await db.select({ n: count() }).from(auditLog).where(where);
  const total = totalRows[0]?.n ?? 0;
  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ data: rows, pagination: pagination(total, limit, offset) });
});

/** GET /admin/audit-logs/:id — one entry or 404. */
router.get("/admin/audit-logs/:id", async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.query.auditLog.findFirst({
    where: eq(auditLog.id, c.req.param("id")),
  });
  if (!row) throw new HttpError(404, "Audit log entry not found", "NOT_FOUND");
  return c.json({ data: row });
});

// ---------------------------------------------------------------------------
// jobs (Phase 7 registry + run ledger)
// ---------------------------------------------------------------------------

/** GET /super-admin/jobs — per-job summary from the JOBS registry + job_runs ledger. */
router.get("/super-admin/jobs", async (c) => {
  const db = getDb(c.env.DB);
  const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1000);
  const byName = new Map<string, Array<Record<string, any>>>();
  for (const r of runs) {
    const row = r as unknown as Record<string, any>;
    const arr = byName.get(row["name"] as string) ?? [];
    arr.push(row);
    byName.set(row["name"] as string, arr);
  }
  const data = Object.entries(JOBS).map(([name, def]) => {
    const rs = byName.get(name) ?? [];
    const last = rs[0] ?? null;
    return {
      name,
      description: def.description,
      cron: def.cron,
      lastRun: last ? last["startedAt"] : null,
      lastStatus: last ? last["status"] : null,
      lastDurationMs: last ? last["durationMs"] : null,
      runs: rs.length,
      failures: rs.filter((r) => r["status"] === "failed").length,
    };
  });
  return c.json({ data, recordedRuns: runs.length });
});

/** POST /super-admin/jobs/:name — run a registered job inline, recorded in job_runs. */
router.post("/super-admin/jobs/:name", async (c) => {
  const db = getDb(c.env.DB);
  const name = c.req.param("name");
  const def = JOBS[name];
  if (!def) throw new HttpError(404, `Unknown job "${name}"`, "UNKNOWN_JOB");
  let ctx;
  try {
    ctx = jobContext(c.env);
  } catch (e) {
    throw new HttpError(503, (e as Error)?.message || "Job context unavailable", "JOB_UNAVAILABLE");
  }
  const result = await recordRun(ctx.db, name, () => def.run(ctx));
  return c.json({ data: result });
});

/** GET /workers/metrics — worker/job health: run counts from job_runs plus
 * summed usage_counters by metric key. Platform-admin only (router guard). */
router.get("/workers/metrics", async (c) => {
  const db = getDb(c.env.DB);
  const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(2000);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const jobs: Record<string, { total: number; completed: number; failed: number; processing: number; last24h: number }> = {};
  for (const r of runs) {
    const row = r as unknown as Record<string, any>;
    const name = String(row["name"] ?? "unknown");
    const agg = jobs[name] ?? { total: 0, completed: 0, failed: 0, processing: 0, last24h: 0 };
    agg.total += 1;
    if (row["status"] === "completed") agg.completed += 1;
    else if (row["status"] === "failed") agg.failed += 1;
    else agg.processing += 1;
    const started = row["startedAt"] instanceof Date ? row["startedAt"] : new Date(row["startedAt"]);
    if (!Number.isNaN(started.getTime()) && started >= dayAgo) agg.last24h += 1;
    jobs[name] = agg;
  }
  const counters = await db.select().from(usageCounters).limit(2000);
  const usage: Record<string, number> = {};
  for (const u of counters) {
    const row = u as unknown as Record<string, any>;
    const key = String(row["metricKey"] ?? "unknown");
    usage[key] = (usage[key] ?? 0) + (Number(row["count"]) || 0);
  }
  return c.json({ data: { jobs, usage, recordedRuns: runs.length } });
});

// ---------------------------------------------------------------------------
// subscription plans
// ---------------------------------------------------------------------------

/** GET /super-admin/plans — list subscription plans. */
router.get("/super-admin/plans", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .orderBy(asc(subscriptionPlans.displayOrder), asc(subscriptionPlans.name));
  return c.json({ data: rows });
});

/** POST /super-admin/plans — create a plan. */
router.post("/super-admin/plans", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const body = await readJson(c);
  const slug = String(body["slug"] ?? "").trim();
  const name = String(body["name"] ?? "").trim();
  if (!slug) throw new HttpError(400, "slug is required", "INVALID_BODY");
  if (!name) throw new HttpError(400, "name is required", "INVALID_BODY");
  const existing = await db.query.subscriptionPlans.findFirst({
    where: eq(subscriptionPlans.slug, slug),
  });
  if (existing) throw new HttpError(409, `Plan "${slug}" already exists`, "PLAN_EXISTS");
  const entitlements = body["entitlements"] ?? {};
  if (typeof entitlements !== "object" || entitlements === null || Array.isArray(entitlements)) {
    throw new HttpError(400, "entitlements must be an object", "INVALID_BODY");
  }
  const inserted = await db
    .insert(subscriptionPlans)
    .values({ slug, name, entitlements: entitlements as Record<string, any> })
    .returning();
  const plan = inserted[0];
  if (!plan) throw new HttpError(500, "Plan creation failed", "CREATE_FAILED");
  await logAudit(db, {
    tenantId: s.tenantId,
    userId: s.userId,
    action: "plan.created",
    entityType: "plan",
    entityId: slug,
    meta: { name },
  });
  return c.json({ data: plan }, 201);
});

const PLAN_UPDATABLE = [
  "name",
  "audience",
  "price",
  "currency",
  "billingInterval",
  "trialDays",
  "isActive",
  "displayOrder",
  "entitlements",
] as const;

/** PATCH /super-admin/plans/:slug — update name/entitlements and safe scalar fields. */
router.patch("/super-admin/plans/:slug", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const slug = c.req.param("slug");
  const plan = await db.query.subscriptionPlans.findFirst({
    where: eq(subscriptionPlans.slug, slug),
  });
  if (!plan) throw new HttpError(404, "Plan not found", "NOT_FOUND");
  const body = await readJson(c);
  const patch: Record<string, unknown> = {};
  for (const key of PLAN_UPDATABLE) {
    if (!(key in body)) continue;
    const v = body[key];
    switch (key) {
      case "name":
      case "currency":
      case "billingInterval":
        patch[key] = String(v);
        break;
      case "audience": {
        const a = String(v);
        if (!["client", "agency", "both"].includes(a)) {
          throw new HttpError(400, 'audience must be "client", "agency" or "both"', "INVALID_BODY");
        }
        patch[key] = a;
        break;
      }
      case "price": {
        const n = Number(v);
        if (Number.isNaN(n)) throw new HttpError(400, "price must be a number", "INVALID_BODY");
        patch[key] = n;
        break;
      }
      case "trialDays":
      case "displayOrder": {
        const n = Math.trunc(Number(v));
        if (Number.isNaN(n)) throw new HttpError(400, `${key} must be a number`, "INVALID_BODY");
        patch[key] = n;
        break;
      }
      case "isActive":
        patch[key] = v === true || v === "true" || v === 1;
        break;
      case "entitlements":
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new HttpError(400, "entitlements must be an object", "INVALID_BODY");
        }
        patch[key] = v;
        break;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Nothing to update", "INVALID_BODY");
  }
  patch["updatedAt"] = new Date();
  await db
    .update(subscriptionPlans)
    .set(patch as any)
    .where(eq(subscriptionPlans.id, plan.id));
  await logAudit(db, {
    tenantId: s.tenantId,
    userId: s.userId,
    action: "plan.updated",
    entityType: "plan",
    entityId: slug,
    meta: { fields: Object.keys(patch) },
  });
  const fresh = await db.query.subscriptionPlans.findFirst({
    where: eq(subscriptionPlans.id, plan.id),
  });
  return c.json({ data: fresh });
});

/** DELETE /super-admin/plans/:slug — delete (409 when subscriptions reference it). */
router.delete("/super-admin/plans/:slug", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const slug = c.req.param("slug");
  const plan = await db.query.subscriptionPlans.findFirst({
    where: eq(subscriptionPlans.slug, slug),
  });
  if (!plan) throw new HttpError(404, "Plan not found", "NOT_FOUND");
  const refs = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.plan_id, plan.id))
    .limit(1);
  if (refs.length > 0) {
    throw new HttpError(409, `Plan "${slug}" is referenced by subscriptions`, "PLAN_IN_USE");
  }
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, plan.id));
  await logAudit(db, {
    tenantId: s.tenantId,
    userId: s.userId,
    action: "plan.deleted",
    entityType: "plan",
    entityId: slug,
  });
  return c.json({ data: { slug, deleted: true } });
});

/** POST /super-admin/plans/:slug/publish — publish = set isActive true. */
router.post("/super-admin/plans/:slug/publish", async (c) => {
  const db = getDb(c.env.DB);
  const s = sessionOf(c);
  const slug = c.req.param("slug");
  const plan = await db.query.subscriptionPlans.findFirst({
    where: eq(subscriptionPlans.slug, slug),
  });
  if (!plan) throw new HttpError(404, "Plan not found", "NOT_FOUND");
  await db
    .update(subscriptionPlans)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(subscriptionPlans.id, plan.id));
  await logAudit(db, {
    tenantId: s.tenantId,
    userId: s.userId,
    action: "plan.published",
    entityType: "plan",
    entityId: slug,
  });
  return c.json({ data: { slug, published: true } });
});

// ---------------------------------------------------------------------------
// billing mode + transactions
// ---------------------------------------------------------------------------

/**
 * POST /super-admin/billing/mode — body { mode: "test" | "live" }.
 * Persisted as billing_settings.testMode on the singleton row (the closest
 * this schema has to a billing mode flag); secrets columns are untouched.
 */
router.post("/super-admin/billing/mode", async (c) => {
  const db = getDb(c.env.DB);
  const body = await readJson(c);
  const raw = body["mode"];
  let testMode: boolean;
  if (raw === "test" || raw === true) testMode = true;
  else if (raw === "live" || raw === false) testMode = false;
  else throw new HttpError(400, 'mode must be "test" or "live"', "INVALID_MODE");
  const existing = await db.select({ id: billingSettings.id }).from(billingSettings).limit(1);
  if (existing[0]) {
    await db
      .update(billingSettings)
      .set({ testMode, updatedAt: new Date() })
      .where(eq(billingSettings.id, existing[0].id));
  } else {
    await db.insert(billingSettings).values({ testMode });
  }
  return c.json({ data: { mode: testMode ? "test" : "live", testMode } });
});

/**
 * GET /super-admin/transactions — transactions read live from Stripe.
 * Without a configured Stripe key there is nothing to read: { data: [] }.
 */
router.get("/super-admin/transactions", async (c) => {
  const db = getDb(c.env.DB);
  const { client, settings } = await stripeClient(c.env, db);
  if (!client || !settings.secretKey) return c.json({ data: [] });
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 100);
  let charges: { data: Array<Record<string, any>> };
  try {
    charges = await client.get<{ data: Array<Record<string, any>> }>("/charges", { limit });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Stripe request failed: ${(e as Error)?.message || e}`, "STRIPE_ERROR");
  }
  const data = (charges.data ?? []).map((ch) => ({
    id: ch["id"],
    amount: ch["amount"],
    currency: ch["currency"],
    status: ch["status"],
    paid: ch["paid"] ?? null,
    created: ch["created"] ?? null,
    customer: ch["customer"] ?? null,
    description: ch["description"] ?? null,
    receiptUrl: ch["receipt_url"] ?? null,
  }));
  return c.json({ data });
});

export default router;
