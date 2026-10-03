// Phase 8: public website→brand onboarding. A visitor pastes their site URL,
// gets a scrape draft token, watches the scrape progress, then (after
// sign-up/sign-in) claims the draft into a new or existing workspace.
//
// Public (no auth):  POST /onboarding/scrape, GET /onboarding/scrape/:token
// Authed:            POST /onboarding/claim,  POST /onboarding/rescan
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { HttpError } from "../lib/filter.js";
import { allowedWorkspaceIds, authMiddleware, sessionOf, tenantStatusGuard } from "../lib/auth.js";
import { getDb, type Db } from "../db/index.js";
import { brandProfiles, brandScrapeDrafts, userProfiles, workspaces } from "../db/schema/index.js";
import {
  STEPS,
  applyBrandToWorkspace,
  buildScrapeContext,
  extractBrand,
  normalizeUrl,
  storeScrapedAssets,
} from "../lib/brand-scrape.js";
import { bootstrapWorkspace } from "../lib/workspace.js";
import type { Env } from "../index.js";

const DRAFT_TTL_MS = 24 * 3600 * 1000;

type StepState = { key: string; label: string; status: string };

/** Map the extractor's step keys onto the draft's pipeline statuses. */
const PIPELINE_STATUS_FOR: Record<string, string> = {
  fetch: "fetching",
  read: "reading",
  extract: "extracting",
  draft: "drafting",
};

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-testable)                                        */
/* ------------------------------------------------------------------ */

/** Shape a draft row for the public poll endpoint. */
export function toPublicDraft(draft: Record<string, any>): Record<string, any> {
  return {
    token: draft.token,
    sourceUrl: draft.sourceUrl,
    status: draft.status,
    steps: draft.steps || [],
    result: draft.status === "ready" ? draft.result ?? null : null,
    error: draft.error || null,
    claimed: !!draft.claimedAt,
  };
}

/**
 * Name resolution for claim, in priority order:
 * accountName > workspaceName > manual.name > result.business.name > hostname.
 */
export function resolveClaimName(input: {
  accountName?: string | null;
  workspaceName?: string | null;
  manual?: { name?: string | null } | null;
  result?: Record<string, any> | null;
  sourceUrl?: string | null;
}): string | null {
  const name = (
    input.accountName ||
    input.workspaceName ||
    input.manual?.name ||
    input.result?.business?.name ||
    ""
  ).trim();
  if (name) return name;
  if (input.sourceUrl) {
    try {
      return new URL(input.sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Background scrape                                                    */
/* ------------------------------------------------------------------ */

async function runScrape(db: Db, env: Env, draftId: string): Promise<void> {
  const rows = await db.select().from(brandScrapeDrafts).where(eq(brandScrapeDrafts.id, draftId)).limit(1);
  const draft = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!draft) return;

  const steps: StepState[] = Array.isArray(draft.steps) && draft.steps.length
    ? draft.steps.map((s: any) => ({ key: s.key, label: s.label, status: s.status || "pending" }))
    : STEPS.map((s) => ({ ...s, status: "pending" }));

  const persist = async (patch: Record<string, any>) => {
    await db
      .update(brandScrapeDrafts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(brandScrapeDrafts.id, draftId));
  };

  const onStep = async (key: string, status: string) => {
    const step = steps.find((x) => x.key === key);
    if (step) step.status = status === "running" ? "running" : status === "done" ? "done" : status;
    const patch: Record<string, any> = { steps };
    if (status === "running" && PIPELINE_STATUS_FOR[key]) patch.status = PIPELINE_STATUS_FOR[key];
    await persist(patch);
  };

  try {
    await persist({ status: "fetching" });
    const ctx = await buildScrapeContext(draft.sourceUrl, onStep);
    const result = await extractBrand(env, db, ctx, onStep);
    const workspaceId = draft.claimedByWorkspace_Id || null;
    await storeScrapedAssets(db, ctx, { workspaceId });
    await persist({ status: "ready", steps, result, error: null });
    if (workspaceId) {
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      const ws = (wsRows[0] as unknown as Record<string, any> | undefined) ?? null;
      await applyBrandToWorkspace(db, {
        result,
        sourceUrl: draft.sourceUrl,
        workspaceId,
        accountId: ws?.account_id || "",
      });
    }
  } catch (e: any) {
    for (const s of steps) if (s.status !== "done") s.status = "failed";
    await persist({ status: "failed", steps, error: e?.message || "Scrape failed" });
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                               */
/* ------------------------------------------------------------------ */

const router = new Hono<{ Bindings: Env }>();

router.use("/onboarding/claim", authMiddleware);
router.use("/onboarding/claim", tenantStatusGuard);
router.use("/onboarding/rescan", authMiddleware);
router.use("/onboarding/rescan", tenantStatusGuard);

/** POST /onboarding/scrape — public: kick off a website→brand scrape. */
router.post("/onboarding/scrape", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  let url: string;
  try {
    url = normalizeUrl(String(body.url || ""));
  } catch (e: any) {
    throw new HttpError(400, e?.message || "Invalid URL", "VALIDATION");
  }
  const db = getDb(c.env.DB);
  const token = crypto.randomUUID().replace(/-/g, "");
  const inserted = await db
    .insert(brandScrapeDrafts)
    .values({
      token,
      sourceUrl: url,
      status: "pending",
      steps: STEPS.map((s) => ({ ...s, status: "pending" })),
      result: {},
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
    })
    .returning({ id: brandScrapeDrafts.id, token: brandScrapeDrafts.token, sourceUrl: brandScrapeDrafts.sourceUrl });
  const row = inserted[0]!;
  c.executionCtx.waitUntil(
    runScrape(db, c.env, row.id).catch((e) => console.error("[onboarding] runScrape failed", e)),
  );
  return c.json({ data: { token: row.token, sourceUrl: row.sourceUrl, status: "pending" } }, 202);
});

/** GET /onboarding/scrape/:token — public: poll scrape progress. */
router.get("/onboarding/scrape/:token", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(brandScrapeDrafts)
    .where(eq(brandScrapeDrafts.token, c.req.param("token")))
    .limit(1);
  const draft = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!draft) throw new HttpError(404, "Scrape draft not found", "NOT_FOUND");
  return c.json({ data: toPublicDraft(draft) });
});

interface ClaimBody {
  token?: string;
  accountName?: string;
  workspaceName?: string;
  mode?: "account" | "workspace" | "existing";
  workspaceId?: string;
  manual?: {
    name?: string;
    websiteUrl?: string;
    industry?: string;
    descriptor?: string;
    description?: string;
    currency?: string;
    country?: string;
    toneOfVoice?: string | string[];
    keywords?: string | string[];
  };
}

const toArray = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];

const hasManualKeys = (m: ClaimBody["manual"]): boolean =>
  !!m &&
  ["name", "websiteUrl", "industry", "descriptor", "description", "currency", "country", "toneOfVoice", "keywords"].some(
    (k) => (m as Record<string, any>)[k] !== undefined && (m as Record<string, any>)[k] !== "",
  );

/** POST /onboarding/claim — authed: claim a draft into a workspace. */
router.post("/onboarding/claim", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ClaimBody;
  const s = sessionOf(c);
  const db = getDb(c.env.DB);

  let draft: Record<string, any> | null = null;
  if (body.token) {
    const rows = await db
      .select()
      .from(brandScrapeDrafts)
      .where(eq(brandScrapeDrafts.token, body.token))
      .limit(1);
    draft = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
    if (!draft) throw new HttpError(404, "Scrape draft not found", "NOT_FOUND");
    if (draft.claimedAt) throw new HttpError(409, "This draft was already claimed", "ALREADY_CLAIMED");
  }

  const name = resolveClaimName({
    accountName: body.accountName,
    workspaceName: body.workspaceName,
    manual: body.manual,
    result: draft?.result,
    sourceUrl: draft?.sourceUrl,
  });
  if (!name) throw new HttpError(400, "A workspace name is required", "VALIDATION");

  let mode = body.mode;
  if (!mode) {
    const existing = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.account_id, s.tenantId))
      .limit(1);
    mode = existing.length ? "workspace" : "account";
  }
  if (mode !== "account" && mode !== "workspace" && mode !== "existing") {
    throw new HttpError(400, "Invalid mode", "VALIDATION");
  }

  let workspaceId: string;
  if (mode === "existing") {
    if (!body.workspaceId) throw new HttpError(400, "workspaceId is required for mode=existing", "VALIDATION");
    // null = platformAdmin → full access; otherwise membership required.
    const allowed = await allowedWorkspaceIds(db, s);
    if (allowed !== null && !allowed.includes(body.workspaceId)) {
      throw new HttpError(403, "No access to this workspace", "FORBIDDEN");
    }
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, body.workspaceId)).limit(1);
    const ws = (wsRows[0] as unknown as Record<string, any> | undefined) ?? null;
    if (!ws) throw new HttpError(404, "Workspace not found", "NOT_FOUND");
    workspaceId = ws.id;
  } else {
    if (mode === "workspace" && !s.isAccountOwner) {
      throw new HttpError(403, "Only the account owner can create additional workspaces", "FORBIDDEN");
    }
    const extra: Record<string, unknown> = {};
    if (body.manual?.websiteUrl) extra.websiteUrl = body.manual.websiteUrl;
    if (body.manual?.industry) extra.industry = body.manual.industry;
    if (body.manual?.descriptor) extra.descriptor = body.manual.descriptor;
    if (body.manual?.currency) extra.currency = body.manual.currency;
    const ws = await bootstrapWorkspace(db, {
      accountId: s.tenantId,
      userId: s.userId,
      name,
      extra,
    });
    workspaceId = (ws as unknown as Record<string, any>).id;
  }

  let brandProfileId: string | null = null;
  if (draft && draft.status === "ready" && draft.result) {
    brandProfileId = await applyBrandToWorkspace(db, {
      result: draft.result,
      sourceUrl: draft.sourceUrl,
      workspaceId,
      accountId: s.tenantId,
    });
  } else if (hasManualKeys(body.manual)) {
    const m = body.manual!;
    const inserted = await db
      .insert(brandProfiles)
      .values({
        workspace_id: workspaceId,
        account_id: s.tenantId,
        sourceUrl: m.websiteUrl || draft?.sourceUrl || null,
        business: {
          name,
          descriptor: m.descriptor || "",
          industry: m.industry || "",
          description: m.description || "",
          location: m.country || "",
        },
        branding: {},
        toneOfVoice: toArray(m.toneOfVoice),
        keywords: toArray(m.keywords),
      })
      .returning({ id: brandProfiles.id });
    brandProfileId = inserted[0]!.id;
  }

  if (draft) {
    await db
      .update(brandScrapeDrafts)
      .set({ claimedByWorkspace_Id: workspaceId, claimedAt: new Date(), updatedAt: new Date() })
      .where(eq(brandScrapeDrafts.id, draft.id));
  }

  // Best-effort: remember the active workspace on the user's profile.
  try {
    const profRows = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.owner_id, s.userId))
      .limit(1);
    const prof = profRows[0] as unknown as Record<string, any> | undefined;
    if (prof) {
      await db
        .update(userProfiles)
        .set({ lastActiveWorkspace_Id: workspaceId, updatedAt: new Date() })
        .where(eq(userProfiles.id, prof.id));
    }
  } catch {
    /* best-effort only */
  }

  return c.json({ data: { tenant_Id: s.tenantId, workspaceId, brandProfileId, mode } }, 201);
});

/** POST /onboarding/rescan — authed: re-scrape a workspace's website. */
router.post("/onboarding/rescan", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; url?: string };
  if (!body.workspaceId) throw new HttpError(400, "workspaceId is required", "VALIDATION");
  const s = sessionOf(c);
  const db = getDb(c.env.DB);

  const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, body.workspaceId)).limit(1);
  const ws = (wsRows[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!ws) throw new HttpError(404, "Workspace not found", "NOT_FOUND");

  if (!s.platformAdmin) {
    if (s.isAccountOwner) {
      if (ws.account_id !== s.tenantId) throw new HttpError(403, "No access to this workspace", "FORBIDDEN");
    } else {
      const allowed = await allowedWorkspaceIds(db, s);
      if (!allowed || !allowed.includes(ws.id)) throw new HttpError(403, "No access to this workspace", "FORBIDDEN");
    }
  }

  const raw = body.url || ws.websiteUrl;
  if (!raw) throw new HttpError(400, "No URL provided and the workspace has no website URL", "VALIDATION");
  let url: string;
  try {
    url = normalizeUrl(raw);
  } catch (e: any) {
    throw new HttpError(400, e?.message || "Invalid URL", "VALIDATION");
  }

  const token = crypto.randomUUID().replace(/-/g, "");
  const inserted = await db
    .insert(brandScrapeDrafts)
    .values({
      token,
      sourceUrl: url,
      status: "pending",
      steps: STEPS.map((step) => ({ ...step, status: "pending" })),
      result: {},
      claimedByWorkspace_Id: ws.id,
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
    })
    .returning({ id: brandScrapeDrafts.id, token: brandScrapeDrafts.token, sourceUrl: brandScrapeDrafts.sourceUrl });
  const row = inserted[0]!;
  c.executionCtx.waitUntil(
    runScrape(db, c.env, row.id).catch((e) => console.error("[onboarding] runScrape failed", e)),
  );

  // Flip any existing brand profile back to a fetching state (best-effort).
  try {
    const bpRows = await db
      .select({ id: brandProfiles.id })
      .from(brandProfiles)
      .where(eq(brandProfiles.workspace_id, ws.id))
      .limit(1);
    if (bpRows[0]) {
      await db
        .update(brandProfiles)
        .set({ scrapeStatus: "fetching", updatedAt: new Date() })
        .where(eq(brandProfiles.id, bpRows[0].id));
    }
  } catch {
    /* best-effort only */
  }

  return c.json({ data: { token: row.token, sourceUrl: row.sourceUrl } }, 202);
});

export { router as onboardingRouter };
export default router;
