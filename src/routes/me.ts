// Post-login session routes: context bootstrap, active workspace,
// tenant account fields, workspace deletion.

import { Hono, type Context } from "hono";
import { getDb } from "../db/index.js";
import { and, count, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Env } from "../index.js";
import { authMiddleware, allowedWorkspaceIds, requireRole } from "../lib/auth.js";
import { HttpError } from "../lib/filter.js";
import { users, tenants } from "../db/schema/identity.js";
import { workspaces, workspaceMembers, agencyClients, agencyStaffWorkspaces } from "../db/schema/core.js";
import { workspaceSettings, userProfiles, subscriptionPlans, subscriptions, usageCounters } from "../db/schema/ops.js";
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

  // Platform role in the frontend's vocabulary.
  let role = "user";
  if (s.platformAdmin) role = "administrator";
  else if (s.isAccountOwner) role = "account_owner";
  else {
    const staffRow = await db.query.agencyStaffWorkspaces.findFirst({
      where: and(
        eq(agencyStaffWorkspaces.staff_id, user.id),
        eq(agencyStaffWorkspaces.agency_id, s.tenantId),
        eq(agencyStaffWorkspaces.status, "active"),
      ),
    });
    if (staffRow) role = "agency_staff";
  }

  const profile = await db.query.userProfiles.findFirst({
    where: eq(userProfiles.owner_id, user.id),
  });

  const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : null);

  const account = tenant
    ? {
        id: tenant.id,
        name: tenant.name,
        type: tenant.type,
        tenant_Id: tenant.id,
        orgNumber: tenant.orgNumber ?? null,
        billingEmail: tenant.billingEmail ?? null,
        contactPerson: tenant.contactPerson ?? null,
        contactPhone: null,
        contactWhatsapp: null,
        address: tenant.address ?? {},
        country: tenant.country ?? null,
        defaultCurrency: "SEK",
        status: tenant.status,
        createdAt: iso(tenant.createdAt),
        onboardingCompletedAt: null,
      }
    : null;

  // Workspaces visible to this session, with the caller's role attached.
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
              inArray(workspaces.id, allowed),
            ),
          })
        : [];
  const memberships = await db.query.workspaceMembers.findMany({
    where: and(eq(workspaceMembers.member_id, user.id), eq(workspaceMembers.status, "active")),
  });
  const memberByWs = new Map(memberships.map((m) => [m.workspace_id as string, m.role as string]));
  const wsList = wsRows.map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug ?? null,
    websiteUrl: w.websiteUrl ?? null,
    industry: w.industry ?? null,
    descriptor: w.descriptor ?? null,
    timezone: w.timezone,
    currency: w.currency,
    locale: w.locale,
    logo_Id: w.logo_Id ?? null,
    status: w.status,
    onboardingState: w.onboardingState,
    onboardingCompletedAt: iso(w.onboardingCompletedAt),
    isDefault: w.isDefault === true,
    myRole: memberByWs.get(w.id) ?? (role === "account_owner" ? "owner" : "editor"),
    createdAt: iso(w.createdAt),
  }));
  const activeWorkspaceId =
    user.activeWorkspaceId && wsList.some((w) => w.id === user.activeWorkspaceId)
      ? user.activeWorkspaceId
      : (wsList.find((w) => w.isDefault)?.id ?? wsList[0]?.id ?? null);
  const activeWorkspace = wsList.find((w) => w.id === activeWorkspaceId) ?? null;

  // Subscription + merged plan entitlements.
  let subscription: Record<string, unknown> | null = null;
  let entitlements: Record<string, unknown> = {};
  if (tenant) {
    const sub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.account_id, tenant.id),
    });
    if (sub) {
      const plan = sub.plan_id
        ? await db.query.subscriptionPlans.findFirst({ where: eq(subscriptionPlans.id, sub.plan_id) })
        : null;
      entitlements = { ...((plan?.entitlements ?? {}) as Record<string, unknown>), ...((sub.entitlementOverrides ?? {}) as Record<string, unknown>) };
      subscription = {
        id: sub.id,
        status: sub.status,
        trialEndsAt: iso(sub.trialEndsAt),
        currentPeriodEnd: iso(sub.currentPeriodEnd),
        plan: plan ? { slug: plan.slug, name: plan.name } : null,
      };
    }
  }

  // Current-period usage counters.
  const usage: Record<string, { count: number; limit: number | null }> = {};
  if (tenant) {
    const now = new Date();
    const counters = await db.query.usageCounters.findMany({
      where: and(
        eq(usageCounters.account_id, tenant.id),
        lte(usageCounters.periodStart, now),
        gte(usageCounters.periodEnd, now),
      ),
    });
    for (const u of counters) {
      usage[u.metricKey] = {
        count: u.count ?? 0,
        limit: (u.limitValue ?? (entitlements[u.metricKey] as number | null) ?? null) as number | null,
      };
    }
  }

  // Agency client list.
  let agency: Record<string, unknown> | null = null;
  if (tenant?.type === "agency") {
    const links = await db.query.agencyClients.findMany({
      where: and(eq(agencyClients.agency_id, tenant.id), eq(agencyClients.status, "active")),
    });
    agency = {
      clientCount: links.length,
      clients: links.map((l) => ({ linkId: l.id, id: l.client_id, name: null, tenant_Id: l.client_id })),
    };
  }

  const tenantsList = tenant
    ? [
        {
          tenant_Id: tenant.id,
          name: tenant.name,
          accountId: tenant.id,
          accountType: tenant.type,
          role,
          current: true,
        },
      ]
    : [];

  return c.json({
    data: {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        avatar_Id: null,
        avatarUrl: user.avatarUrl ?? null,
      },
      role,
      tenant_Id: tenant?.id ?? null,
      profile: profile
        ? {
            id: profile.id,
            preferredLanguage: profile.preferredLanguage ?? "en",
            timezone: profile.timezone ?? null,
            address: profile.address ?? {},
            consents: profile.consents ?? {},
            lastActiveAccount_Id: profile.lastActiveAccount_Id ?? null,
            lastActiveWorkspace_Id: profile.lastActiveWorkspace_Id ?? null,
            uiPreferences: profile.uiPreferences ?? {},
            onboardingChecklist: profile.onboardingChecklist ?? {},
          }
        : null,
      account,
      workspaces: wsList,
      activeWorkspace,
      subscription,
      entitlements,
      usage,
      agency,
      tenants: tenantsList,
      suggestedTenant_Id: null,
      // Slim shape kept for backward compatibility.
      tenant: tenant
        ? { id: tenant.id, name: tenant.name, status: tenant.status, type: tenant.type }
        : null,
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
