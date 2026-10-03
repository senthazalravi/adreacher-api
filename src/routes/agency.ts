// Phase 8: agency management — client businesses, client workspaces, agency
// staff, client logins (viewers), and portfolio health roll-ups.
//
// Mounted by the parent (src/index.ts); the parent owns mounting, so this
// file only defines and default-exports the router. Every route lives under
// /agency/* and is owner-only (agencyContext + isOwner) EXCEPT
// POST /agency/staff/accept, which is the invitee's own flow: it only needs
// a signed-in session plus a valid invite token.
//
// Response envelope: { data: ... }. Errors: HttpError (mapped to
// { error: { code, message } } by the app-level onError in src/index.ts).

import { Hono, type Context } from "hono";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  ne,
  or,
} from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import type { Env } from "../index.js";
import {
  authMiddleware,
  sessionOf,
  tenantStatusGuard,
  type Session,
} from "../lib/auth.js";
import { HttpError } from "../lib/filter.js";
import { linkEmail, sendMail } from "../lib/mail.js";
import {
  assertPlanAllows,
  getPlanEntitlements,
  PlanLimitError,
} from "../lib/limits.js";
import { bootstrapWorkspace } from "../lib/workspace.js";
import {
  adPlatforms,
  campaignAnalytics,
  campaignPlatforms,
  campaigns,
  clients,
  invites,
  platformConnections,
  tenants,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema/index.js";

type AppContext = Context<{ Bindings: Env }>;
type TenantRow = typeof tenants.$inferSelect;
type MemberRole = "owner" | "admin" | "editor" | "approver" | "viewer";

const router = new Hono<{ Bindings: Env }>();
router.use("/agency*", authMiddleware);
router.use("/agency*", tenantStatusGuard);

// ---------------------------------------------------------------------------
// pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Email validation shared by every agency invite/login endpoint. */
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/** Escape LIKE wildcards so `q` searches match literally. */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function appUrl(env: { APP_URL?: string }): string {
  return (env.APP_URL || "").replace(/\/+$/, "");
}

/** Frontend invite-accept link emailed to invitees. */
export function buildInviteUrl(env: { APP_URL?: string }, token: string): string {
  return `${appUrl(env)}/accept-invite?token=${token}`;
}

export function parsePaging(
  c: AppContext,
  def = 20,
  max = 100,
): { page: number; limit: number; offset: number } {
  const page = Math.max(Math.floor(Number(c.req.query("page"))) || 1, 1);
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query("limit"))) || def, 1), max);
  return { page, limit, offset: (page - 1) * limit };
}

export function pageEnvelope<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): { items: T[]; total: number; page: number; limit: number; pages: number } {
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** Merge a features patch into the stored feature flags (strict booleans). */
export function mergeFeatures(
  current: Record<string, boolean> | null | undefined,
  patch: unknown,
): Record<string, boolean> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new HttpError(400, "features must be an object", "INVALID_BODY");
  }
  const out: Record<string, boolean> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (typeof v !== "boolean") {
      throw new HttpError(400, `features["${k}"] must be a boolean`, "INVALID_BODY");
    }
    out[k] = v;
  }
  return out;
}

// --- health summary ---------------------------------------------------------

export interface HealthFailure {
  workspaceId: string;
  campaignId: string;
  campaignName: string | null;
  platformId: string | null;
  platform: string | null;
  status: string;
  message: string | null;
}

export interface HealthConnectionIssue {
  workspaceId: string;
  platformId: string | null;
  platform: string | null;
  accountName: string | null;
  status: string;
}

export type AttentionItem =
  | {
      type: "platform_failure";
      workspaceId: string;
      campaignId: string;
      campaignName: string | null;
      platform: string | null;
      status: string;
      message: string | null;
    }
  | {
      type: "connection_issue";
      workspaceId: string;
      platform: string | null;
      accountName: string | null;
      status: string;
    };

export type HealthLabel = "failing" | "attention" | "healthy" | "no_activity";

export interface HealthSummary {
  live: number;
  spend7d: number;
  impressions7d: number;
  ctr7d: number;
  attention: AttentionItem[];
  health: HealthLabel;
}

export interface HealthInput {
  live: number;
  analytics: { spend: number; impressions: number; clicks: number }[];
  failures: HealthFailure[];
  connectionIssues: HealthConnectionIssue[];
}

const MAX_ATTENTION = 10;
const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure health math: roll raw rows into the summary the endpoints return.
 * Health label precedence: any platform failure → "failing"; any expiring /
 * expired connection → "attention"; live campaigns → "healthy"; otherwise
 * "no_activity".
 */
export function summarizeHealth(input: HealthInput): HealthSummary {
  const spend7d = round2(input.analytics.reduce((n, a) => n + (a.spend ?? 0), 0));
  const impressions7d = input.analytics.reduce((n, a) => n + (a.impressions ?? 0), 0);
  const clicks = input.analytics.reduce((n, a) => n + (a.clicks ?? 0), 0);
  const ctr7d = impressions7d > 0 ? round2((clicks / impressions7d) * 100) : 0;
  const attention: AttentionItem[] = [
    ...input.failures.map((f) => ({
      type: "platform_failure" as const,
      workspaceId: f.workspaceId,
      campaignId: f.campaignId,
      campaignName: f.campaignName,
      platform: f.platform,
      status: f.status,
      message: f.message,
    })),
    ...input.connectionIssues.map((x) => ({
      type: "connection_issue" as const,
      workspaceId: x.workspaceId,
      platform: x.platform,
      accountName: x.accountName,
      status: x.status,
    })),
  ].slice(0, MAX_ATTENTION);
  const health: HealthLabel =
    input.failures.length > 0
      ? "failing"
      : input.connectionIssues.length > 0
        ? "attention"
        : input.live > 0
          ? "healthy"
          : "no_activity";
  return { live: input.live, spend7d, impressions7d, ctr7d, attention, health };
}

/** Raw, per-workspace health rows fetched from D1 (kept grouped for roll-ups). */
export interface RawHealth {
  liveByWs: Record<string, number>;
  analytics: { workspaceId: string; spend: number; impressions: number; clicks: number }[];
  failures: HealthFailure[];
  connectionIssues: HealthConnectionIssue[];
}

function emptyRawHealth(): RawHealth {
  return { liveByWs: {}, analytics: [], failures: [], connectionIssues: [] };
}

/** Fetch the raw health rows for a set of workspace ids. */
export async function fetchRawHealth(db: Db, workspaceIds: string[]): Promise<RawHealth> {
  if (!workspaceIds.length) return emptyRawHealth();

  const campRows = await db
    .select({ id: campaigns.id, workspaceId: campaigns.workspace_id, name: campaigns.name })
    .from(campaigns)
    .where(and(inArray(campaigns.workspace_id, workspaceIds), isNull(campaigns.deletedAt)));
  const campIds = campRows.map((r) => r.id);
  const campById = new Map(campRows.map((r) => [r.id, r]));

  let platRows: (typeof campaignPlatforms.$inferSelect)[] = [];
  if (campIds.length) {
    platRows = await db
      .select()
      .from(campaignPlatforms)
      .where(inArray(campaignPlatforms.campaign_id, campIds));
  }

  const platformIds = [...new Set(platRows.map((p) => p.platform_id).filter((x): x is string => !!x))];
  // Platform display names come from ad_platforms (platform_id === code).
  const platRows2 = platformIds.length
    ? await db
        .select({ code: adPlatforms.code, name: adPlatforms.name })
        .from(adPlatforms)
        .where(inArray(adPlatforms.code, platformIds))
    : [];
  const platName = new Map(platRows2.map((r) => [r.code, r.name]));

  const liveByWs: Record<string, number> = {};
  for (const p of platRows) {
    const cw = p.campaign_id ? campById.get(p.campaign_id) : undefined;
    const wsId = cw?.workspaceId;
    if (!wsId || p.status !== "live") continue;
    liveByWs[wsId] = (liveByWs[wsId] ?? 0) + 1;
  }

  const failures: HealthFailure[] = [];
  for (const p of platRows) {
    if (p.status !== "failed" && p.status !== "rejected") continue;
    const cw = p.campaign_id ? campById.get(p.campaign_id) : undefined;
    if (!cw?.workspaceId) continue;
    failures.push({
      workspaceId: cw.workspaceId,
      campaignId: p.campaign_id ?? "",
      campaignName: cw.name ?? null,
      platformId: p.platform_id,
      platform: p.platform_id ? (platName.get(p.platform_id) ?? null) : null,
      status: p.status,
      message: p.platformMessage,
    });
  }

  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const analyticsRows = await db
    .select({
      workspaceId: campaignAnalytics.workspace_id,
      spend: campaignAnalytics.spend,
      impressions: campaignAnalytics.impressions,
      clicks: campaignAnalytics.clicks,
    })
    .from(campaignAnalytics)
    .where(and(inArray(campaignAnalytics.workspace_id, workspaceIds), gte(campaignAnalytics.date, since)));
  const analytics = analyticsRows
    .filter((r) => !!r.workspaceId)
    .map((r) => ({
      workspaceId: r.workspaceId as string,
      spend: r.spend ?? 0,
      impressions: r.impressions ?? 0,
      clicks: r.clicks ?? 0,
    }));

  const connRows = await db
    .select()
    .from(platformConnections)
    .where(
      and(
        inArray(platformConnections.workspace_id, workspaceIds),
        inArray(platformConnections.status, ["expiring", "expired"]),
        isNull(platformConnections.deletedAt),
      ),
    );
  const connectionIssues: HealthConnectionIssue[] = connRows
    .filter((r) => !!r.workspace_id)
    .map((r) => ({
      workspaceId: r.workspace_id as string,
      platformId: r.platform_id,
      platform: r.platform_id ? (platName.get(r.platform_id) ?? null) : null,
      accountName: r.externalAccountName,
      status: r.status,
    }));

  return { liveByWs, analytics, failures, connectionIssues };
}

/**
 * Summarize raw health, optionally scoped to a subset of the fetched
 * workspace ids (used for per-client slices of one bulk fetch).
 */
export function summarizeRaw(raw: RawHealth, workspaceIds?: string[]): HealthSummary {
  const inScope = (wsId: string) => !workspaceIds || workspaceIds.includes(wsId);
  const live = workspaceIds
    ? workspaceIds.reduce((n, id) => n + (raw.liveByWs[id] ?? 0), 0)
    : Object.values(raw.liveByWs).reduce((a, b) => a + b, 0);
  return summarizeHealth({
    live,
    analytics: raw.analytics.filter((a) => inScope(a.workspaceId)),
    failures: raw.failures.filter((f) => inScope(f.workspaceId)),
    connectionIssues: raw.connectionIssues.filter((x) => inScope(x.workspaceId)),
  });
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

export interface AgencyContext {
  s: Session;
  tenant: TenantRow;
  isOwner: boolean;
}

/**
 * Core agency guard, testable without a Context: the session's tenant must be
 * an agency tenant (platform admins bypass). Throws 401/403 HttpError.
 */
export async function resolveAgencyContext(
  db: Db,
  s: Session | undefined,
): Promise<{ tenant: TenantRow; isOwner: boolean }> {
  if (!s) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, s.tenantId) });
  if (!tenant) throw new HttpError(403, "Agency account not found", "NO_TENANT");
  if (!s.platformAdmin && tenant.type !== "agency") {
    throw new HttpError(403, "Agency account required", "AGENCY_REQUIRED");
  }
  return { tenant, isOwner: s.platformAdmin || s.isAccountOwner };
}

/** Full guard for request handlers: session must exist, agency tenant. */
export async function agencyContext(c: AppContext): Promise<AgencyContext> {
  const s = sessionOf(c);
  const { tenant, isOwner } = await resolveAgencyContext(getDb(c.env.DB), s);
  return { s: s as Session, tenant, isOwner };
}

/** Owner-only management guard. */
export function assertOwner(s: Session, isOwner: boolean): void {
  if (!isOwner) throw new HttpError(403, "Agency owner access required", "AGENCY_OWNER_REQUIRED");
}

export async function ownerContext(c: AppContext): Promise<AgencyContext> {
  const ctx = await agencyContext(c);
  assertOwner(ctx.s, ctx.isOwner);
  return ctx;
}

// ---------------------------------------------------------------------------
// shared request helpers
// ---------------------------------------------------------------------------

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

const STAFF_ROLES: MemberRole[] = ["owner", "admin", "editor", "approver"];
const ASSIGNABLE_STAFF_ROLES: MemberRole[] = ["admin", "editor", "approver"];

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Load a non-deleted client owned by this agency tenant (404 otherwise). */
async function getClient(db: Db, tenantId: string, id: string) {
  const row = await db.query.clients.findFirst({
    where: and(eq(clients.id, id), eq(clients.agencyTenantId, tenantId), isNull(clients.deletedAt)),
  });
  if (!row) throw new HttpError(404, "Client not found", "NOT_FOUND");
  return row;
}

/** Non-deleted workspace ids of one client. */
async function clientWorkspaceIds(db: Db, tenantId: string, clientId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.account_id, tenantId),
        eq(workspaces.client_id, clientId),
        isNull(workspaces.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** Ensure every id in `ids` is a non-deleted workspace of this client. */
async function requireClientWorkspaces(
  db: Db,
  tenantId: string,
  clientId: string,
  ids: unknown,
): Promise<string[]> {
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
    throw new HttpError(400, "workspaceIds must be an array of workspace ids", "INVALID_BODY");
  }
  const allowed = new Set(await clientWorkspaceIds(db, tenantId, clientId));
  for (const id of ids) {
    if (!allowed.has(id)) throw new HttpError(400, `Workspace ${id} does not belong to this client`, "INVALID_WORKSPACE");
  }
  return [...new Set(ids)];
}

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName };
}

async function usersByIds(db: Db, ids: string[]) {
  if (!ids.length) return [];
  return db
    .select()
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.deletedAt)));
}

/** Insert-or-update a membership row (unique on workspace_id + member_id). */
async function upsertMember(
  db: Db,
  values: {
    workspace_id: string;
    member_id: string;
    account_id: string;
    role: MemberRole;
    status: "invited" | "active" | "revoked";
  },
): Promise<void> {
  await db
    .insert(workspaceMembers)
    .values({
      ...values,
      invitedAt: new Date(),
      acceptedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspace_id, workspaceMembers.member_id],
      set: { role: values.role, status: values.status, updatedAt: new Date() },
    });
}

/**
 * Grant viewer memberships for `userId` in `workspaceIds`, never touching
 * existing non-viewer (staff) rows.
 */
async function grantViewerMemberships(
  db: Db,
  tenantId: string,
  userId: string,
  workspaceIds: string[],
): Promise<void> {
  if (!workspaceIds.length) return;
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        inArray(workspaceMembers.workspace_id, workspaceIds),
        eq(workspaceMembers.member_id, userId),
      ),
    );
  const byWs = new Map(existing.map((m) => [m.workspace_id as string, m]));
  for (const wsId of workspaceIds) {
    const ex = byWs.get(wsId);
    if (ex && ex.role !== "viewer") continue; // staff row — leave it alone
    await upsertMember(db, {
      workspace_id: wsId,
      member_id: userId,
      account_id: tenantId,
      role: "viewer",
      status: "active",
    });
  }
}

async function inviteMail(
  env: Env,
  to: string,
  opts: { heading: string; body: string; token: string },
): Promise<{ inviteUrl: string; emailed: boolean }> {
  const inviteUrl = buildInviteUrl(env, opts.token);
  const mail = linkEmail({
    appUrl: appUrl(env) || "https://adreacher.app",
    heading: opts.heading,
    body: opts.body,
    ctaUrl: inviteUrl,
    ctaLabel: "Accept invite",
  });
  let emailed = false;
  try {
    await sendMail(env, { to, ...mail });
    emailed = true;
  } catch {
    /* best-effort: the invite row + URL are the source of truth */
  }
  return { inviteUrl, emailed };
}

// ---------------------------------------------------------------------------
// 1. list clients
// ---------------------------------------------------------------------------

router.get("/agency/clients", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePaging(c);
  const q = str(c.req.query("q"));
  const status = str(c.req.query("status"));

  const conds = [eq(clients.agencyTenantId, tenant.id), isNull(clients.deletedAt)];
  if (status) {
    if (status !== "active" && status !== "inactive") {
      throw new HttpError(400, 'status must be "active" or "inactive"', "INVALID_QUERY");
    }
    conds.push(eq(clients.status, status));
  }
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conds.push(
      or(
        like(clients.name, pattern),
        like(clients.contactEmail, pattern),
        like(clients.orgNumber, pattern),
      )!,
    );
  }
  const where = and(...conds);

  const totalRows = await db.select({ n: count() }).from(clients).where(where);
  const total = totalRows[0]?.n ?? 0;
  const rows = await db
    .select()
    .from(clients)
    .where(where)
    .orderBy(asc(clients.name))
    .limit(limit)
    .offset(offset);

  // One bulk health fetch for the page's workspaces, sliced per client.
  const clientIds = rows.map((r) => r.id);
  const wsRows = clientIds.length
    ? await db
        .select({ id: workspaces.id, clientId: workspaces.client_id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.account_id, tenant.id),
            inArray(workspaces.client_id, clientIds),
            isNull(workspaces.deletedAt),
          ),
        )
    : [];
  const wsByClient = new Map<string, string[]>();
  for (const w of wsRows) {
    if (!w.clientId) continue;
    const list = wsByClient.get(w.clientId) ?? [];
    list.push(w.id);
    wsByClient.set(w.clientId, list);
  }
  const raw = await fetchRawHealth(
    db,
    wsRows.map((w) => w.id),
  );

  const items = rows.map((r) => {
    const wsIds = wsByClient.get(r.id) ?? [];
    return { ...r, workspaceCount: wsIds.length, health: summarizeRaw(raw, wsIds) };
  });
  return c.json({ data: pageEnvelope(items, total, page, limit) });
});

// ---------------------------------------------------------------------------
// 2. create client (+ first workspace)
// ---------------------------------------------------------------------------

router.post("/agency/clients", async (c) => {
  const { s, tenant } = await ownerContext(c);
  const body = await readJson(c);
  const db = getDb(c.env.DB);

  const name = str(body["name"]);
  if (!name) throw new HttpError(400, "name is required", "INVALID_BODY");
  const currency = (str(body["currency"]) ?? "SEK").toUpperCase();
  const workspaceName = str(body["workspaceName"]) ?? name;

  // Plan limit first so a rejected plan never leaves a half-created client.
  // assertPlanAllows throws 402/PLAN_LIMIT_REACHED (via getPlanEntitlements).
  await assertPlanAllows(db, "workspaces", tenant.id);

  const [client] = await db
    .insert(clients)
    .values({
      agencyTenantId: tenant.id,
      name,
      orgNumber: str(body["orgNumber"]),
      contactPerson: str(body["contactPerson"]),
      contactEmail: str(body["contactEmail"]),
      contactPhone: str(body["contactPhone"]),
      contactWhatsapp: str(body["contactWhatsapp"]),
      websiteUrl: str(body["websiteUrl"]),
      country: str(body["country"]),
      currency,
    })
    .returning();
  if (!client) throw new HttpError(500, "Client creation failed", "CREATE_FAILED");

  const ws = (await bootstrapWorkspace(db, {
    accountId: tenant.id,
    userId: s.userId,
    name: workspaceName,
    extra: { client_id: client.id, currency },
  })) as { id: string };

  return c.json({ data: { clientId: client.id, workspaceId: ws.id, tenant_Id: tenant.id } }, 201);
});

// ---------------------------------------------------------------------------
// 3. client detail
// ---------------------------------------------------------------------------

router.get("/agency/clients/:id", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const client = await getClient(db, tenant.id, id);

  const wsRows = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.account_id, tenant.id),
        eq(workspaces.client_id, id),
        isNull(workspaces.deletedAt),
      ),
    )
    .orderBy(asc(workspaces.name));
  const wsIds = wsRows.map((w) => w.id);
  const wsById = new Map(wsRows.map((w) => [w.id, w]));

  const memberRows = wsIds.length
    ? await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            inArray(workspaceMembers.workspace_id, wsIds),
            eq(workspaceMembers.account_id, tenant.id),
            ne(workspaceMembers.status, "revoked"),
          ),
        )
    : [];
  const userRows = await usersByIds(db, [...new Set(memberRows.map((m) => m.member_id).filter((x): x is string => !!x))]);
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const staff = memberRows
    .filter((m) => m.role !== "viewer" && m.member_id)
    .map((m) => {
      const u = m.member_id ? userById.get(m.member_id) : undefined;
      return {
        userId: m.member_id,
        email: u?.email ?? null,
        firstName: u?.firstName ?? null,
        lastName: u?.lastName ?? null,
        role: m.role,
        status: m.status,
        workspaceId: m.workspace_id,
        workspaceName: m.workspace_id ? (wsById.get(m.workspace_id)?.name ?? null) : null,
      };
    });

  const seen = new Set<string>();
  const logins = memberRows
    .filter((m) => m.role === "viewer" && m.member_id)
    .map((m) => userById.get(m.member_id as string))
    .filter((u): u is typeof users.$inferSelect => !!u && !seen.has(u.id) && (seen.add(u.id), true))
    .map(publicUser);

  const health = summarizeRaw(await fetchRawHealth(db, wsIds), wsIds);

  return c.json({ data: { client, workspaces: wsRows, staff, logins, health } });
});

// ---------------------------------------------------------------------------
// 4. update client
// ---------------------------------------------------------------------------

const CLIENT_UPDATABLE = [
  "name",
  "orgNumber",
  "contactPerson",
  "contactEmail",
  "contactPhone",
  "websiteUrl",
  "country",
  "notes",
  "status",
] as const;

router.patch("/agency/clients/:id", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  await getClient(db, tenant.id, id);
  const body = await readJson(c);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of CLIENT_UPDATABLE) {
    if (!(key in body)) continue;
    if (key === "status") {
      const v = str(body["status"]);
      if (v !== "active" && v !== "inactive") {
        throw new HttpError(400, 'status must be "active" or "inactive"', "INVALID_BODY");
      }
      patch["status"] = v;
    } else if (key === "name") {
      const v = str(body["name"]);
      if (!v) throw new HttpError(400, "name cannot be empty", "INVALID_BODY");
      patch["name"] = v;
    } else {
      patch[key] = str(body[key]);
    }
  }
  if (Object.keys(patch).length === 1) {
    throw new HttpError(400, "No updatable fields provided", "INVALID_BODY");
  }
  const [updated] = await db.update(clients).set(patch).where(eq(clients.id, id)).returning();
  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// 5. delete client (soft)
// ---------------------------------------------------------------------------

router.delete("/agency/clients/:id", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  await getClient(db, tenant.id, id);

  const owned = await clientWorkspaceIds(db, tenant.id, id);
  if (owned.length) {
    throw new HttpError(
      409,
      `Client still owns ${owned.length} workspace(s); detach or delete them first`,
      "CLIENT_HAS_WORKSPACES",
    );
  }
  await db
    .update(clients)
    .set({ deletedAt: new Date(), status: "inactive", updatedAt: new Date() })
    .where(eq(clients.id, id));
  return c.json({ data: { id, deleted: true } });
});

// ---------------------------------------------------------------------------
// 6. client feature flags
// ---------------------------------------------------------------------------

router.patch("/agency/clients/:id/features", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const client = await getClient(db, tenant.id, id);
  const body = await readJson(c);

  const features = mergeFeatures(client.features, body["features"]);
  const [updated] = await db
    .update(clients)
    .set({ features, updatedAt: new Date() })
    .where(eq(clients.id, id))
    .returning();
  return c.json({ data: { clientId: id, features: updated?.features ?? features } });
});

// ---------------------------------------------------------------------------
// 8. client logins (viewers) — list
// ---------------------------------------------------------------------------

router.get("/agency/clients/:id/logins", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  await getClient(db, tenant.id, id);
  const wsIds = await clientWorkspaceIds(db, tenant.id, id);

  const memberRows = wsIds.length
    ? await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            inArray(workspaceMembers.workspace_id, wsIds),
            eq(workspaceMembers.role, "viewer"),
            ne(workspaceMembers.status, "revoked"),
          ),
        )
    : [];
  const userRows = await usersByIds(db, [...new Set(memberRows.map((m) => m.member_id).filter((x): x is string => !!x))]);
  const seen = new Set<string>();
  const items = userRows
    .filter((u) => !seen.has(u.id) && (seen.add(u.id), true))
    .map(publicUser);
  return c.json({ data: { items } });
});

// ---------------------------------------------------------------------------
// 9. client logins — invite a viewer
// ---------------------------------------------------------------------------

router.post("/agency/clients/:id/logins", async (c) => {
  const { s, tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const client = await getClient(db, tenant.id, id);
  const body = await readJson(c);

  const email = str(body["email"])?.toLowerCase() ?? "";
  if (!isValidEmail(email)) throw new HttpError(400, "Valid email required", "INVALID_EMAIL");
  const firstName = str(body["firstName"]);

  const workspaceIds =
    body["workspaceIds"] === undefined
      ? await clientWorkspaceIds(db, tenant.id, id)
      : await requireClientWorkspaces(db, tenant.id, id, body["workspaceIds"]);

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);
  const [invite] = await db
    .insert(invites)
    .values({
      email,
      tenantId: tenant.id,
      role: "viewer",
      token,
      expiresAt,
      invitedBy: s.userId,
      workspaceIds,
    })
    .returning();
  if (!invite) throw new HttpError(500, "Invite creation failed", "CREATE_FAILED");

  // Existing users get their viewer memberships immediately; brand-new
  // emails get the invite and are attached on accept (see /staff/accept).
  const user = await db.query.users.findFirst({
    where: and(eq(users.email, email), isNull(users.deletedAt)),
  });
  if (user) {
    await grantViewerMemberships(db, tenant.id, user.id, workspaceIds);
  }

  const { inviteUrl, emailed } = await inviteMail(c.env, email, {
    heading: "You've been invited",
    body:
      `${client.name} (via ${tenant.name} on AdReacher) gave ` +
      `${firstName ? `${firstName} ` : ""}you viewer access to ` +
      `${workspaceIds.length} workspace(s). This invite expires in 7 days.`,
    token,
  });
  return c.json({ data: { inviteId: invite.id, email, inviteUrl, emailed } }, 201);
});

// ---------------------------------------------------------------------------
// 10. client logins — replace a viewer's workspace set
// ---------------------------------------------------------------------------

router.patch("/agency/clients/:id/logins/:loginId", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const loginId = c.req.param("loginId");
  await getClient(db, tenant.id, id);
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, loginId), isNull(users.deletedAt)),
  });
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
  const body = await readJson(c);

  const wsIds = await clientWorkspaceIds(db, tenant.id, id);
  if (body["workspaceIds"] === undefined) {
    // No-op: report the current viewer memberships.
    const current = wsIds.length
      ? await db
          .select({ workspace_id: workspaceMembers.workspace_id })
          .from(workspaceMembers)
          .where(
            and(
              inArray(workspaceMembers.workspace_id, wsIds),
              eq(workspaceMembers.member_id, loginId),
              eq(workspaceMembers.role, "viewer"),
              ne(workspaceMembers.status, "revoked"),
            ),
          )
      : [];
    return c.json({
      data: { userId: loginId, workspaceIds: current.map((r) => r.workspace_id) },
    });
  }
  const next = await requireClientWorkspaces(db, tenant.id, id, body["workspaceIds"]);

  const existing = wsIds.length
    ? await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            inArray(workspaceMembers.workspace_id, wsIds),
            eq(workspaceMembers.member_id, loginId),
            eq(workspaceMembers.role, "viewer"),
          ),
        )
    : [];
  const existingWs = new Set(existing.map((m) => m.workspace_id as string));
  const nextSet = new Set(next);

  const toRemove = existing.filter((m) => !nextSet.has(m.workspace_id as string));
  if (toRemove.length) {
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.member_id, loginId),
          inArray(
            workspaceMembers.workspace_id,
            toRemove.map((m) => m.workspace_id as string),
          ),
          eq(workspaceMembers.role, "viewer"),
        ),
      );
  }
  for (const wsId of next) {
    if (existingWs.has(wsId)) continue;
    await upsertMember(db, {
      workspace_id: wsId,
      member_id: loginId,
      account_id: tenant.id,
      role: "viewer",
      status: "active",
    });
  }
  return c.json({ data: { userId: loginId, workspaceIds: next } });
});

// ---------------------------------------------------------------------------
// 11. client logins — remove a viewer
// ---------------------------------------------------------------------------

router.delete("/agency/clients/:id/logins/:loginId", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const loginId = c.req.param("loginId");
  await getClient(db, tenant.id, id);

  const only = str(c.req.query("workspaceId"));
  const wsIds = only
    ? await requireClientWorkspaces(db, tenant.id, id, [only])
    : await clientWorkspaceIds(db, tenant.id, id);

  let removed = 0;
  if (wsIds.length) {
    const doomed = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          inArray(workspaceMembers.workspace_id, wsIds),
          eq(workspaceMembers.member_id, loginId),
          eq(workspaceMembers.role, "viewer"),
        ),
      );
    removed = doomed.length;
    if (removed) {
      await db.delete(workspaceMembers).where(
        inArray(
          workspaceMembers.id,
          doomed.map((r) => r.id),
        ),
      );
    }
  }
  return c.json({ data: { userId: loginId, removed } });
});

// ---------------------------------------------------------------------------
// 12. assign agency staff to a client's workspaces
// ---------------------------------------------------------------------------

router.post("/agency/clients/:id/staff", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  await getClient(db, tenant.id, id);
  const body = await readJson(c);

  const userIdRaw = str(body["userId"]);
  const emailRaw = str(body["email"])?.toLowerCase();
  if (!userIdRaw && !emailRaw) {
    throw new HttpError(400, "userId or email is required", "INVALID_BODY");
  }
  const user = userIdRaw
    ? await db.query.users.findFirst({ where: and(eq(users.id, userIdRaw), isNull(users.deletedAt)) })
    : await db.query.users.findFirst({ where: and(eq(users.email, emailRaw as string), isNull(users.deletedAt)) });
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");
  if (user.tenantId !== tenant.id) {
    throw new HttpError(400, "User is not part of this agency", "NOT_AGENCY_STAFF");
  }

  const role = str(body["role"]) ?? "editor";
  if (!(STAFF_ROLES as string[]).includes(role)) {
    throw new HttpError(400, `role must be one of ${STAFF_ROLES.join(", ")}`, "INVALID_BODY");
  }
  if (role === "viewer") {
    throw new HttpError(400, "Use the client logins endpoint for viewer access", "INVALID_BODY");
  }

  const workspaceIds =
    body["workspaceIds"] === undefined
      ? await clientWorkspaceIds(db, tenant.id, id)
      : await requireClientWorkspaces(db, tenant.id, id, body["workspaceIds"]);

  for (const wsId of workspaceIds) {
    await upsertMember(db, {
      workspace_id: wsId,
      member_id: user.id,
      account_id: tenant.id,
      role: role as MemberRole,
      status: "active",
    });
  }
  return c.json({ data: { userId: user.id, workspaceIds, role } }, 201);
});

// ---------------------------------------------------------------------------
// 13. remove agency staff from a client's workspaces
// ---------------------------------------------------------------------------

router.delete("/agency/clients/:id/staff/:userId", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const userId = c.req.param("userId");
  await getClient(db, tenant.id, id);
  const wsIds = await clientWorkspaceIds(db, tenant.id, id);

  let removed = 0;
  if (wsIds.length) {
    const doomed = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          inArray(workspaceMembers.workspace_id, wsIds),
          eq(workspaceMembers.member_id, userId),
          ne(workspaceMembers.role, "viewer"),
        ),
      );
    removed = doomed.length;
    if (removed) {
      await db.delete(workspaceMembers).where(
        inArray(
          workspaceMembers.id,
          doomed.map((r) => r.id),
        ),
      );
    }
  }
  return c.json({ data: { userId, removed } });
});

// ---------------------------------------------------------------------------
// 14. add a workspace to an existing client
// ---------------------------------------------------------------------------

router.post("/agency/clients/:id/workspaces", async (c) => {
  const { s, tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const client = await getClient(db, tenant.id, id);
  const body = await readJson(c);

  const name = str(body["name"]) ?? str(body["workspaceName"]) ?? client.name;
  const currency = (str(body["currency"]) ?? client.currency ?? "SEK").toUpperCase();

  await assertPlanAllows(db, "workspaces", tenant.id);

  const ws = (await bootstrapWorkspace(db, {
    accountId: tenant.id,
    userId: s.userId,
    name,
    extra: { client_id: id, currency },
  })) as { id: string };
  return c.json({ data: { clientId: id, workspaceId: ws.id } }, 201);
});

// ---------------------------------------------------------------------------
// 15. list workspaces (agency-wide)
// ---------------------------------------------------------------------------

router.get("/agency/workspaces", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePaging(c);
  const q = str(c.req.query("q"));
  const clientFilter = str(c.req.query("client"));

  const conds = [eq(workspaces.account_id, tenant.id), isNull(workspaces.deletedAt)];
  if (clientFilter && clientFilter !== "all") conds.push(eq(workspaces.client_id, clientFilter));
  if (q) conds.push(like(workspaces.name, `%${escapeLike(q)}%`));
  const where = and(...conds);

  const totalRows = await db.select({ n: count() }).from(workspaces).where(where);
  const total = totalRows[0]?.n ?? 0;
  const wsRows = await db
    .select()
    .from(workspaces)
    .where(where)
    .orderBy(asc(workspaces.name))
    .limit(limit)
    .offset(offset);
  const wsIds = wsRows.map((w) => w.id);

  const clientIds = [...new Set(wsRows.map((w) => w.client_id).filter((x): x is string => !!x))];
  const clientRows = clientIds.length
    ? await db.select().from(clients).where(inArray(clients.id, clientIds))
    : [];
  const clientById = new Map(clientRows.map((r) => [r.id, r]));

  const memberRows = wsIds.length
    ? await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            inArray(workspaceMembers.workspace_id, wsIds),
            eq(workspaceMembers.account_id, tenant.id),
            ne(workspaceMembers.status, "revoked"),
          ),
        )
    : [];
  const userRows = await usersByIds(db, [...new Set(memberRows.map((m) => m.member_id).filter((x): x is string => !!x))]);
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const memberView = (m: typeof workspaceMembers.$inferSelect) => {
    const u = m.member_id ? userById.get(m.member_id) : undefined;
    return {
      userId: m.member_id,
      email: u?.email ?? null,
      firstName: u?.firstName ?? null,
      lastName: u?.lastName ?? null,
      role: m.role,
      status: m.status,
    };
  };

  const items = wsRows.map((w) => {
    const members = memberRows.filter((m) => m.workspace_id === w.id);
    const client = w.client_id ? clientById.get(w.client_id) : undefined;
    return {
      ...w,
      client: client ? { id: client.id, name: client.name } : null,
      staff: members.filter((m) => m.role !== "viewer").map(memberView),
      clientUsers: members.filter((m) => m.role === "viewer").map(memberView),
    };
  });
  return c.json({ data: pageEnvelope(items, total, page, limit) });
});

// ---------------------------------------------------------------------------
// 16. sync staff on one workspace
// ---------------------------------------------------------------------------

router.put("/agency/workspaces/:id/staff", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const body = await readJson(c);

  const ws = await db.query.workspaces.findFirst({
    where: and(
      eq(workspaces.id, id),
      eq(workspaces.account_id, tenant.id),
      isNull(workspaces.deletedAt),
    ),
  });
  if (!ws) throw new HttpError(404, "Workspace not found", "NOT_FOUND");

  const userIds = body["userIds"];
  if (!Array.isArray(userIds) || !userIds.every((x) => typeof x === "string")) {
    throw new HttpError(400, "userIds must be an array of user ids", "INVALID_BODY");
  }
  const role = str(body["role"]) ?? "editor";
  if (!(ASSIGNABLE_STAFF_ROLES as string[]).includes(role)) {
    throw new HttpError(400, `role must be one of ${ASSIGNABLE_STAFF_ROLES.join(", ")}`, "INVALID_BODY");
  }

  const uniqueIds = [...new Set(userIds as string[])];
  const userRows = uniqueIds.length ? await usersByIds(db, uniqueIds) : [];
  const foundIds = new Set(userRows.map((u) => u.id));
  const missing = uniqueIds.filter((x) => !foundIds.has(x));
  if (missing.length) {
    throw new HttpError(404, `User(s) not found: ${missing.join(", ")}`, "NOT_FOUND");
  }
  for (const u of userRows) {
    if (u.tenantId !== tenant.id) {
      throw new HttpError(403, `Only agency staff may be assigned (${u.email})`, "NOT_AGENCY_STAFF");
    }
  }

  // Never touch viewer or owner rows — sync only the staff slice.
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspace_id, id),
        ne(workspaceMembers.role, "viewer"),
        ne(workspaceMembers.role, "owner"),
      ),
    );
  const existingIds = new Set(existing.map((m) => m.member_id as string));
  const desired = new Set(uniqueIds);

  const added: string[] = [];
  for (const uid of uniqueIds) {
    if (existingIds.has(uid)) continue;
    await db.insert(workspaceMembers).values({
      workspace_id: id,
      member_id: uid,
      account_id: tenant.id,
      role: role as MemberRole,
      status: "active",
      invitedAt: new Date(),
      acceptedAt: new Date(),
    });
    added.push(uid);
  }
  const removed = existing
    .filter((m) => !desired.has(m.member_id as string))
    .map((m) => m.member_id as string);
  if (removed.length) {
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspace_id, id),
          inArray(workspaceMembers.member_id, removed),
          ne(workspaceMembers.role, "viewer"),
          ne(workspaceMembers.role, "owner"),
        ),
      );
  }
  return c.json({ data: { workspaceId: id, userIds: uniqueIds, added, removed } });
});

// ---------------------------------------------------------------------------
// 17. link / unlink a workspace to a client
// ---------------------------------------------------------------------------

router.patch("/agency/workspaces/:id/client", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const body = await readJson(c);

  const ws = await db.query.workspaces.findFirst({
    where: and(
      eq(workspaces.id, id),
      eq(workspaces.account_id, tenant.id),
      isNull(workspaces.deletedAt),
    ),
  });
  if (!ws) throw new HttpError(404, "Workspace not found", "NOT_FOUND");
  if (!("clientId" in body)) {
    throw new HttpError(400, "clientId is required (null to detach)", "INVALID_BODY");
  }

  const clientIdRaw = body["clientId"];
  let clientId: string | null = null;
  if (clientIdRaw !== null && clientIdRaw !== undefined) {
    clientId = String(clientIdRaw);
    await getClient(db, tenant.id, clientId); // 404 unless it belongs to this agency
  }
  await db
    .update(workspaces)
    .set({ client_id: clientId, updatedAt: new Date() })
    .where(eq(workspaces.id, id));
  return c.json({ data: { workspaceId: id, clientId } });
});

// ---------------------------------------------------------------------------
// 18. agency staff list
// ---------------------------------------------------------------------------

router.get("/agency/staff", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);

  const staffUsers = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), isNull(users.deletedAt)))
    .orderBy(asc(users.email));
  const ids = staffUsers.map((u) => u.id);

  const memberRows = ids.length
    ? await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.account_id, tenant.id),
            inArray(workspaceMembers.member_id, ids),
            ne(workspaceMembers.status, "revoked"),
          ),
        )
    : [];
  const wsIds = [...new Set(memberRows.map((m) => m.workspace_id).filter((x): x is string => !!x))];
  const wsRows = wsIds.length
    ? await db.select().from(workspaces).where(inArray(workspaces.id, wsIds))
    : [];
  const wsById = new Map(wsRows.map((w) => [w.id, w]));
  const clientIds = [...new Set(wsRows.map((w) => w.client_id).filter((x): x is string => !!x))];
  const clientRows = clientIds.length
    ? await db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, clientIds))
    : [];
  const clientNameById = new Map(clientRows.map((r) => [r.id, r.name]));

  const items = staffUsers.map((u) => ({
    ...publicUser(u),
    agencyRole: u.id === tenant.ownerId ? "owner" : "staff",
    platformAdmin: u.platformAdmin === true,
    assignments: memberRows
      .filter((m) => m.member_id === u.id)
      .map((m) => {
        const w = m.workspace_id ? wsById.get(m.workspace_id) : undefined;
        return {
          workspaceId: m.workspace_id,
          workspaceName: w?.name ?? null,
          clientId: w?.client_id ?? null,
          clientName: w?.client_id ? (clientNameById.get(w.client_id) ?? null) : null,
          role: m.role,
          status: m.status,
        };
      }),
  }));
  return c.json({ data: { items } });
});

// ---------------------------------------------------------------------------
// 19. invite agency staff
// ---------------------------------------------------------------------------

const STAFF_INVITE_ROLES = ["agency_staff", "account_owner"] as const;

router.post("/agency/staff/invite", async (c) => {
  const { s, tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const body = await readJson(c);

  const email = str(body["email"])?.toLowerCase() ?? "";
  if (!isValidEmail(email)) throw new HttpError(400, "Valid email required", "INVALID_EMAIL");
  const role = str(body["role"]) ?? "agency_staff";
  if (!(STAFF_INVITE_ROLES as readonly string[]).includes(role)) {
    throw new HttpError(400, `role must be one of ${STAFF_INVITE_ROLES.join(", ")}`, "INVALID_BODY");
  }

  // Idempotent: a live pending invite for this email is returned as-is.
  const existing = await db.query.invites.findFirst({
    where: and(
      eq(invites.email, email),
      eq(invites.tenantId, tenant.id),
      eq(invites.status, "pending"),
    ),
    orderBy: desc(invites.createdAt),
  });
  if (existing && existing.expiresAt.getTime() > Date.now()) {
    return c.json({
      data: {
        id: existing.id,
        email,
        role: existing.role,
        inviteUrl: buildInviteUrl(c.env, existing.token),
        expiresAt: existing.expiresAt,
        emailed: false,
        existing: true,
      },
    });
  }

  const alreadyMember = await db.query.users.findFirst({
    where: and(eq(users.email, email), eq(users.tenantId, tenant.id), isNull(users.deletedAt)),
  });
  if (alreadyMember) {
    throw new HttpError(409, "This user is already part of the agency", "USER_EXISTS");
  }

  // Seat check: tenant users + live pending invites vs plan entitlements.
  const { entitlements, planSlug } = await getPlanEntitlements(db, tenant.id);
  const seatLimit = entitlements.teamSeats ?? entitlements.staffSeats;
  if (seatLimit != null) {
    const userCount = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.tenantId, tenant.id), isNull(users.deletedAt)));
    const inviteCount = await db
      .select({ n: count() })
      .from(invites)
      .where(and(eq(invites.tenantId, tenant.id), eq(invites.status, "pending")));
    const current = (userCount[0]?.n ?? 0) + (inviteCount[0]?.n ?? 0);
    if (current >= Number(seatLimit)) {
      throw new PlanLimitError(
        { metric: "teamSeats", limit: Number(seatLimit), current, plan: planSlug },
        `Your plan allows ${seatLimit} team seats; upgrade to invite more.`,
      );
    }
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);
  const [invite] = await db
    .insert(invites)
    .values({ email, tenantId: tenant.id, role, token, expiresAt, invitedBy: s.userId })
    .returning();
  if (!invite) throw new HttpError(500, "Invite creation failed", "CREATE_FAILED");

  const { inviteUrl, emailed } = await inviteMail(c.env, email, {
    heading: "You've been invited to join an agency",
    body:
      `${tenant.name} invited you to join their AdReacher agency as ${role}. ` +
      "This invite expires in 7 days.",
    token,
  });
  return c.json({ data: { id: invite.id, email, role, inviteUrl, expiresAt, emailed } }, 201);
});

// ---------------------------------------------------------------------------
// 20. list pending staff invites
// ---------------------------------------------------------------------------

router.get("/agency/staff/invites", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(invites)
    .where(and(eq(invites.tenantId, tenant.id), eq(invites.status, "pending")))
    .orderBy(desc(invites.createdAt));
  const now = Date.now();
  const items = rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.status,
    expiresAt: r.expiresAt,
    expired: r.expiresAt.getTime() <= now,
    invitedBy: r.invitedBy,
    createdAt: r.createdAt,
    inviteUrl: buildInviteUrl(c.env, r.token),
  }));
  return c.json({ data: { items } });
});

// ---------------------------------------------------------------------------
// 21. revoke a staff invite
// ---------------------------------------------------------------------------

router.delete("/agency/staff/invites/:id", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const row = await db.query.invites.findFirst({
    where: and(eq(invites.id, id), eq(invites.tenantId, tenant.id)),
  });
  if (!row) throw new HttpError(404, "Invite not found", "NOT_FOUND");
  await db.update(invites).set({ status: "revoked" }).where(eq(invites.id, id));
  return c.json({ data: { id, revoked: true } });
});

// ---------------------------------------------------------------------------
// 22. remove agency staff
// ---------------------------------------------------------------------------

router.delete("/agency/staff/:id", async (c) => {
  const { s, tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  if (id === s.userId) {
    throw new HttpError(400, "You cannot remove yourself", "CANNOT_REMOVE_SELF");
  }
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, id), eq(users.tenantId, tenant.id), isNull(users.deletedAt)),
  });
  if (!user) throw new HttpError(404, "Staff member not found", "NOT_FOUND");
  if (user.id === tenant.ownerId) {
    throw new HttpError(400, "The account owner cannot be removed", "CANNOT_REMOVE_OWNER");
  }

  const doomed = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.account_id, tenant.id),
        eq(workspaceMembers.member_id, id),
      ),
    );
  if (doomed.length) {
    await db.delete(workspaceMembers).where(
      inArray(
        workspaceMembers.id,
        doomed.map((r) => r.id),
      ),
    );
  }
  // tenantId is left as-is: the user keeps their agency account (no orphaning).
  return c.json({ data: { userId: id, assignmentsRemoved: doomed.length } });
});

// ---------------------------------------------------------------------------
// 23. accept an invite (invitee's own flow — NOT owner-only)
// ---------------------------------------------------------------------------

router.post("/agency/staff/accept", async (c) => {
  const s = sessionOf(c);
  if (!s) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const db = getDb(c.env.DB);
  const body = await readJson(c);
  const token = str(body["token"]);
  if (!token) throw new HttpError(400, "token is required", "INVALID_BODY");

  const invite = await db.query.invites.findFirst({ where: eq(invites.token, token) });
  if (!invite) throw new HttpError(404, "Invite not found", "INVITE_NOT_FOUND");
  if (invite.status !== "pending") {
    throw new HttpError(400, `Invite is ${invite.status}`, "INVITE_INVALID");
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    await db.update(invites).set({ status: "expired" }).where(eq(invites.id, invite.id));
    throw new HttpError(410, "Invite has expired", "INVITE_EXPIRED");
  }
  if (invite.email.toLowerCase() !== s.email.toLowerCase()) {
    throw new HttpError(403, "This invite was sent to a different email address", "INVITE_EMAIL_MISMATCH");
  }

  const user = await db.query.users.findFirst({
    where: and(eq(users.id, s.userId), isNull(users.deletedAt)),
  });
  if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");

  await db
    .update(users)
    .set({ tenantId: invite.tenantId, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  if (invite.role === "viewer" && invite.workspaceIds?.length) {
    // Only attach workspaces that still belong to the inviting tenant.
    const wsRows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.account_id, invite.tenantId),
          inArray(workspaces.id, invite.workspaceIds),
          isNull(workspaces.deletedAt),
        ),
      );
    await grantViewerMemberships(
      db,
      invite.tenantId,
      user.id,
      wsRows.map((r) => r.id),
    );
  }

  await db
    .update(invites)
    .set({ status: "accepted", acceptedAt: new Date() })
    .where(eq(invites.id, invite.id));

  const tenantRow = await db.query.tenants.findFirst({ where: eq(tenants.id, invite.tenantId) });
  return c.json({
    data: { tenant_Id: invite.tenantId, tenantName: tenantRow?.name ?? null },
  });
});

// ---------------------------------------------------------------------------
// 24. client users (viewers across agency workspaces)
// ---------------------------------------------------------------------------

router.get("/agency/client-users", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePaging(c);
  const q = str(c.req.query("q"))?.toLowerCase() ?? "";
  const clientFilter = str(c.req.query("client"));
  const workspaceFilter = str(c.req.query("workspace"));

  const wsRows = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.account_id, tenant.id), isNull(workspaces.deletedAt)));
  const wsIds = wsRows.map((w) => w.id);
  const wsById = new Map(wsRows.map((w) => [w.id, w]));

  const memberRows = wsIds.length
    ? await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            inArray(workspaceMembers.workspace_id, wsIds),
            eq(workspaceMembers.role, "viewer"),
            inArray(workspaceMembers.status, ["active", "invited"]),
          ),
        )
    : [];

  const clientIds = [...new Set(wsRows.map((w) => w.client_id).filter((x): x is string => !!x))];
  const clientRows = clientIds.length
    ? await db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, clientIds))
    : [];
  const clientById = new Map(clientRows.map((r) => [r.id, r]));

  const membersByUser = new Map<string, typeof workspaceMembers.$inferSelect[]>();
  for (const m of memberRows) {
    if (!m.member_id) continue;
    const list = membersByUser.get(m.member_id) ?? [];
    list.push(m);
    membersByUser.set(m.member_id, list);
  }
  const userRows = await usersByIds(db, [...membersByUser.keys()]);

  let items = userRows.map((u) => {
    const memberships = (membersByUser.get(u.id) ?? []).filter((m) =>
      m.workspace_id && wsById.has(m.workspace_id),
    );
    const wsList = memberships
      .map((m) => wsById.get(m.workspace_id as string))
      .filter((w): w is typeof workspaces.$inferSelect => !!w);
    const clientList = [...new Map(
      wsList
        .map((w) => w.client_id)
        .filter((x): x is string => !!x)
        .map((cid) => [cid, clientById.get(cid)] as const),
    ).values()].filter((cl): cl is { id: string; name: string } => !!cl);
    return {
      ...publicUser(u),
      clients: clientList.map((cl) => ({ id: cl.id, name: cl.name })),
      workspaces: wsList.map((w) => ({
        id: w.id,
        name: w.name,
        clientId: w.client_id,
        clientName: w.client_id ? (clientById.get(w.client_id)?.name ?? null) : null,
      })),
      _wsIds: wsList.map((w) => w.id),
      _clientIds: clientList.map((cl) => cl.id),
    };
  });

  if (q) {
    items = items.filter((u) =>
      u.email.toLowerCase().includes(q) ||
      (u.firstName ?? "").toLowerCase().includes(q) ||
      (u.lastName ?? "").toLowerCase().includes(q),
    );
  }
  if (clientFilter && clientFilter !== "all") {
    items = items.filter((u) => u._clientIds.includes(clientFilter));
  }
  if (workspaceFilter) {
    items = items.filter((u) => u._wsIds.includes(workspaceFilter));
  }
  items.sort((a, b) => a.email.localeCompare(b.email));

  const total = items.length;
  const pageItems = items.slice(offset, offset + limit).map(({ _wsIds, _clientIds, ...rest }) => rest);
  return c.json({ data: pageEnvelope(pageItems, total, page, limit) });
});

// ---------------------------------------------------------------------------
// 25. update a client user
// ---------------------------------------------------------------------------

router.patch("/agency/client-users/:id", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const body = await readJson(c);

  const patch: Record<string, unknown> = {};
  if ("firstName" in body) patch["firstName"] = str(body["firstName"]);
  if ("lastName" in body) patch["lastName"] = str(body["lastName"]);
  if (!Object.keys(patch).length) {
    throw new HttpError(400, "firstName or lastName is required", "INVALID_BODY");
  }

  // Must be a viewer in this agency.
  const wsIds = (
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.account_id, tenant.id), isNull(workspaces.deletedAt)))
  ).map((r) => r.id);
  const membership = wsIds.length
    ? await db.query.workspaceMembers.findFirst({
        where: and(
          inArray(workspaceMembers.workspace_id, wsIds),
          eq(workspaceMembers.member_id, id),
          eq(workspaceMembers.role, "viewer"),
          ne(workspaceMembers.status, "revoked"),
        ),
      })
    : undefined;
  if (!membership) throw new HttpError(404, "Client user not found", "NOT_FOUND");

  patch["updatedAt"] = new Date();
  const [updated] = await db.update(users).set(patch).where(eq(users.id, id)).returning();
  if (!updated) throw new HttpError(404, "User not found", "NOT_FOUND");
  return c.json({ data: { id, firstName: updated.firstName, lastName: updated.lastName } });
});

// ---------------------------------------------------------------------------
// 26. client dropdown options
// ---------------------------------------------------------------------------

router.get("/agency/client-options", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const q = str(c.req.query("q"));
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query("limit"))) || 20, 1), 100);
  const include = (str(c.req.query("include")) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const base = [eq(clients.agencyTenantId, tenant.id), isNull(clients.deletedAt)];
  const conds: (ReturnType<typeof eq> | ReturnType<typeof or> | undefined)[] = [];
  if (q) conds.push(like(clients.name, `%${escapeLike(q)}%`));
  if (include.length) conds.push(inArray(clients.id, include));
  const where = conds.length ? and(...base, or(...conds)!) : and(...base);

  const rows = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(where)
    .orderBy(asc(clients.name))
    .limit(limit);
  return c.json({ data: { items: rows } });
});

// ---------------------------------------------------------------------------
// 27. workspace dropdown options
// ---------------------------------------------------------------------------

router.get("/agency/workspace-options", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const q = str(c.req.query("q"));
  const clientFilter = str(c.req.query("client"));
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query("limit"))) || 20, 1), 100);
  const include = (str(c.req.query("include")) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const base = [eq(workspaces.account_id, tenant.id), isNull(workspaces.deletedAt)];
  if (clientFilter && clientFilter !== "all") base.push(eq(workspaces.client_id, clientFilter));
  const conds: (ReturnType<typeof eq> | ReturnType<typeof or> | undefined)[] = [];
  if (q) conds.push(like(workspaces.name, `%${escapeLike(q)}%`));
  if (include.length) conds.push(inArray(workspaces.id, include));
  const where = conds.length ? and(...base, or(...conds)!) : and(...base);

  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, clientId: workspaces.client_id })
    .from(workspaces)
    .where(where)
    .orderBy(asc(workspaces.name))
    .limit(limit);
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x))];
  const clientRows = clientIds.length
    ? await db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, clientIds))
    : [];
  const nameById = new Map(clientRows.map((r) => [r.id, r.name]));
  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    clientId: r.clientId,
    clientName: r.clientId ? (nameById.get(r.clientId) ?? null) : null,
  }));
  return c.json({ data: { items } });
});

// ---------------------------------------------------------------------------
// 28. portfolio roll-up
// ---------------------------------------------------------------------------

router.get("/agency/portfolio", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);

  const wsRows = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.account_id, tenant.id),
        eq(workspaces.isDefault, false),
        eq(workspaces.status, "active"),
        isNull(workspaces.deletedAt),
      ),
    );
  const wsIds = wsRows.map((w) => w.id);
  const raw = await fetchRawHealth(db, wsIds);
  const overall = summarizeRaw(raw);

  const wsByClient = new Map<string, string[]>();
  for (const w of wsRows) {
    if (!w.client_id) continue;
    const list = wsByClient.get(w.client_id) ?? [];
    list.push(w.id);
    wsByClient.set(w.client_id, list);
  }
  const clientRows = wsByClient.size
    ? await db
        .select()
        .from(clients)
        .where(
          and(
            inArray(clients.id, [...wsByClient.keys()]),
            isNull(clients.deletedAt),
          ),
        )
    : [];

  const byClient = clientRows
    .map((cl) => {
      const cws = wsByClient.get(cl.id) ?? [];
      const h = summarizeRaw(raw, cws);
      return {
        clientId: cl.id,
        clientName: cl.name,
        workspaces: cws.length,
        liveCampaigns: h.live,
        spend7d: h.spend7d,
        impressions7d: h.impressions7d,
        ctr7d: h.ctr7d,
        health: h.health,
        attentionCount: h.attention.length,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  return c.json({
    data: {
      clients: clientRows.length,
      liveCampaigns: overall.live,
      needAttention: overall.attention.length,
      spend7d: overall.spend7d,
      impressions7d: overall.impressions7d,
      attention: overall.attention,
      byClient,
    },
  });
});

// ---------------------------------------------------------------------------
// 29. agency profile
// ---------------------------------------------------------------------------

router.patch("/agency/profile", async (c) => {
  const { tenant } = await ownerContext(c);
  const db = getDb(c.env.DB);
  const body = await readJson(c);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ("name" in body) {
    const v = str(body["name"]);
    if (!v) throw new HttpError(400, "name cannot be empty", "INVALID_BODY");
    patch["name"] = v;
  }
  if ("orgNumber" in body) patch["orgNumber"] = str(body["orgNumber"]);
  if ("billingEmail" in body) {
    const v = str(body["billingEmail"]);
    if (v && !isValidEmail(v)) throw new HttpError(400, "Valid billingEmail required", "INVALID_EMAIL");
    patch["billingEmail"] = v;
  }
  if ("contactPerson" in body) patch["contactPerson"] = str(body["contactPerson"]);
  if ("country" in body) patch["country"] = str(body["country"]);
  if ("address" in body) {
    const v = body["address"];
    if (v !== null && (typeof v !== "object" || Array.isArray(v))) {
      throw new HttpError(400, "address must be an object", "INVALID_BODY");
    }
    patch["address"] = v;
  }
  // tenants has no dedicated phone columns in this rebuild; contact phones
  // live in the `phones` JSON column.
  if ("contactPhone" in body || "contactWhatsapp" in body) {
    const phones: Record<string, unknown> = { ...((tenant.phones as Record<string, unknown>) ?? {}) };
    if ("contactPhone" in body) phones["contactPhone"] = str(body["contactPhone"]);
    if ("contactWhatsapp" in body) phones["contactWhatsapp"] = str(body["contactWhatsapp"]);
    patch["phones"] = phones;
  }

  const [updated] = await db.update(tenants).set(patch).where(eq(tenants.id, tenant.id)).returning();
  return c.json({ data: updated });
});

export default router;
