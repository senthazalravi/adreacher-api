// Campaign routes: lifecycle, platforms, posts, sync, audience/geo lookups,
// landing pages, auto-loop, Google creative, import. Port of the old
// baasix-endpoint-campaigns extension (same method+path for every route).
//
//   GET    /campaigns/:id                          campaign + metrics
//   DELETE /campaigns/:id                          delete campaign
//   POST   /campaigns/:id/launch                   { platformCodes? }
//   POST   /campaigns/:id/activate
//   POST   /campaigns/:id/pause
//   POST   /campaigns/:id/resume
//   POST   /campaigns/:id/archive
//   POST   /campaigns/:id/push-updates
//   PUT    /campaigns/:id/settings
//   PUT    /campaigns/:id/platforms/:platformId
//   POST   /campaigns/:id/platforms/:platformId/pause
//   POST   /campaigns/:id/platforms/:platformId/resume
//   PUT    /campaigns/:id/posts/:postId
//   POST   /campaigns/:id/sync-analytics
//   POST   /campaigns/sync/all                     { workspaceId }
//   POST   /campaigns/sync/:platform               { workspaceId }
//   POST   /campaigns/sync/:platform/analytics     { workspaceId }
//   POST   /campaigns/import/google                { workspaceId }
//   GET    /campaigns/audience/interests/search?workspaceId=&q=&platforms=
//   GET    /campaigns/audience/locations/search?workspaceId=&q=&platforms=
//   GET    /campaigns/locations/google/search?workspaceId=&q=
//   GET    /campaigns/languages/google/search?workspaceId=&q=
//   GET    /campaigns/google/campaign-types?workspaceId=
//   GET    /campaigns/merchant-products/google/search?workspaceId=&q=
//   GET    /campaigns/youtube/metadata?url=
//   POST   /campaigns/:id/landing-page/generate
//   POST   /campaigns/:id/landing-page/preview
//   POST   /campaigns/:id/landing-page/approve
//   GET    /campaigns/:id/landing-page/generated
//   GET    /campaigns/:id/auto-loop
//   POST   /campaigns/:id/auto-loop/enable
//   POST   /campaigns/:id/auto-loop/disable
//   POST   /campaigns/:id/auto-loop/run-once
//   POST   /campaigns/:id/google-creative                    (AI — 501)
//   POST   /campaigns/:id/google-creative/generate-images    (AI — 501)
//   POST   /campaigns/:id/google-creative/generate-portrait   (AI — 501)
//   POST   /campaigns/:id/google-creative/expand-from-portrait (AI — 501)
//   POST   /campaigns/:id/google-creative/assemble           (AI — 501)
//   GET    /campaigns/:id/google-creative/readiness
//   GET    /campaigns/:id/publishing-status
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import { campaignPlatforms, campaignPosts, campaigns, posts, workspaceSettings } from "../db/schema/index.js";
import { authMiddleware, tenantStatusGuard, allowedWorkspaceIds, sessionOf } from "../lib/auth.js";
import { HttpError } from "../lib/filter.js";
import type { Env } from "../index.js";
import {
  archiveCampaign,
  googleCreativeReadiness,
  loadCampaign,
  pauseCampaign,
  pausePlatform,
  publishCampaign,
  pushUpdates,
  refreshCampaignStatus,
  resumeCampaign,
  resumePlatform,
  syncAllCampaignAnalytics,
  syncCampaignAnalytics,
  syncPlatformAnalytics,
  updateCampaignSettings,
} from "../lib/campaign-publisher.js";
import { importGoogleCampaigns } from "../lib/campaign-import.js";
import { resolveInterests, resolveLocations } from "../lib/audience-resolvers.js";
import {
  googleCampaignTypes,
  merchantProducts,
  searchGeoTargets,
  searchLanguages,
  type LookupDeps,
} from "../lib/google-lookups.js";
import { YouTubeMetadataService } from "../lib/youtube-metadata.js";
import {
  approveLandingPage,
  generateLandingPage,
  getLandingPage,
} from "../lib/landing-pages.js";
import { campaignMetrics, computeScore, loopSettings, runIteration } from "../lib/auto-optimize.js";

type AppContext = Context<{ Bindings: Env }>;

function secretKey(c: AppContext): string {
  const k = c.env.SECRET_KEY;
  if (!k) throw new HttpError(500, "SECRET_KEY is not configured", "SECRETS_UNCONFIGURED");
  return k;
}

function depsOf(c: AppContext, db: Db): LookupDeps {
  return { db, env: c.env as unknown as Record<string, string | undefined>, secretKey: secretKey(c) };
}

async function workspaceIdOf(c: AppContext, campaignId: string): Promise<string> {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  const wsId = (rows[0] as any)?.workspace_id;
  if (!wsId) throw new HttpError(404, "Campaign not found", "NOT_FOUND");
  return wsId;
}

async function requireWorkspace(c: AppContext, workspaceId: string): Promise<void> {
  const session = sessionOf(c);
  const db = getDb(c.env.DB);
  const allowed = (await allowedWorkspaceIds(db, session)) ?? [];
  if (!allowed.includes(workspaceId)) throw new HttpError(403, "No access to this workspace", "FORBIDDEN");
}

export const campaignsRouter = new Hono<{ Bindings: Env }>();
campaignsRouter.use(authMiddleware);
campaignsRouter.use(tenantStatusGuard);

// ---------------------------------------------------------------------------
// Campaign CRUD (custom GET/DELETE; list/create/update go through /items)
// ---------------------------------------------------------------------------

campaignsRouter.get("/campaigns/:id", async (c) => {
  const db = getDb(c.env.DB);
  const campaign = await loadCampaign(db, c.req.param("id"));
  await requireWorkspace(c, campaign.workspace_id);
  return c.json({ data: campaign });
});

campaignsRouter.delete("/campaigns/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const campaign = await loadCampaign(db, id);
  await requireWorkspace(c, campaign.workspace_id);
  // Delete children first (D1 has no cascading deletes configured)
  await db.delete(campaignPosts).where(eq(campaignPosts.campaign_id, id));
  await db.delete(campaignPlatforms).where(eq(campaignPlatforms.campaign_id, id));
  await db.delete(campaigns).where(eq(campaigns.id, id));
  return c.json({ data: { id, deleted: true } });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

campaignsRouter.post("/campaigns/:id/launch", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const body = await c.req.json().catch(() => ({}));
  const session = sessionOf(c);
  const result = await publishCampaign(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, {
    platformCodes: body.platformCodes,
    uid: session.userId,
  });
  return c.json({ data: result });
});

campaignsRouter.post("/campaigns/:id/activate", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await resumeCampaign(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, session.userId);
  return c.json({ data: result });
});

campaignsRouter.post("/campaigns/:id/pause", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await pauseCampaign(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, session.userId);
  return c.json({ data: result });
});

campaignsRouter.post("/campaigns/:id/resume", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await resumeCampaign(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, session.userId);
  return c.json({ data: result });
});

campaignsRouter.post("/campaigns/:id/archive", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await archiveCampaign(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, session.userId);
  return c.json({ data: result });
});

campaignsRouter.post("/campaigns/:id/push-updates", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await pushUpdates(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, session.userId);
  return c.json({ data: result });
});

campaignsRouter.put("/campaigns/:id/settings", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const body = await c.req.json().catch(() => ({}));
  const session = sessionOf(c);
  const campaign = await updateCampaignSettings(db, id, body, session.userId);
  return c.json({ data: campaign });
});

campaignsRouter.get("/campaigns/:id/publishing-status", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const campaign = await loadCampaign(db, id);
  await requireWorkspace(c, campaign.workspace_id);
  const status = await refreshCampaignStatus(db, id);
  return c.json({
    data: {
      status,
      platforms: (campaign.platforms || []).map((p: any) => ({
        id: p.id,
        platformId: p.platform_id,
        code: p.platform?.code,
        name: p.platform?.name,
        status: p.status,
        externalCampaignId: p.externalCampaignId,
        platformMessage: p.platformMessage,
        failureCode: p.failureCode,
        lastSyncedAt: p.lastSyncedAt,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// Platform sub-resources
// ---------------------------------------------------------------------------

campaignsRouter.put("/campaigns/:id/platforms/:platformId", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const platformId = c.req.param("platformId");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const body = await c.req.json().catch(() => ({}));
  const rows = await db
    .select()
    .from(campaignPlatforms)
    .where(and(eq(campaignPlatforms.campaign_id, id), eq(campaignPlatforms.id, platformId)))
    .limit(1);
  const cp = rows[0] as unknown as Record<string, any> | undefined;
  if (!cp) throw new HttpError(404, "Campaign platform not found", "NOT_FOUND");
  const patch: Record<string, any> = { updatedAt: new Date() };
  if (body.budgetAmount !== undefined) patch.budgetAmount = body.budgetAmount;
  if (body.payload !== undefined) patch.payload = { ...(cp.payload || {}), ...body.payload };
  if (body.status !== undefined) patch.status = body.status;
  await db.update(campaignPlatforms).set(patch).where(eq(campaignPlatforms.id, cp.id));
  return c.json({ data: { ...cp, ...patch } });
});

campaignsRouter.post("/campaigns/:id/platforms/:platformId/pause", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await pausePlatform(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, c.req.param("platformId"), session.userId);
  return c.json({ data: result });
});

campaignsRouter.post("/campaigns/:id/platforms/:platformId/resume", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await resumePlatform(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id, c.req.param("platformId"), session.userId);
  return c.json({ data: result });
});

// ---------------------------------------------------------------------------
// Campaign posts
// ---------------------------------------------------------------------------

campaignsRouter.put("/campaigns/:id/posts/:postId", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const postId = c.req.param("postId");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const body = await c.req.json().catch(() => ({}));
  // The link row (campaign_posts) carries platformCreative/targeting; the post row carries the content.
  const linkRows = await db
    .select()
    .from(campaignPosts)
    .where(and(eq(campaignPosts.campaign_id, id), eq(campaignPosts.post_id, postId)))
    .limit(1);
  const link = linkRows[0] as unknown as Record<string, any> | undefined;
  if (body.platformCreative !== undefined || body.targeting !== undefined) {
    if (!link) throw new HttpError(404, "Campaign post link not found", "NOT_FOUND");
    const patch: Record<string, any> = { updatedAt: new Date() };
    if (body.platformCreative !== undefined) patch.platformCreative = body.platformCreative;
    if (body.targeting !== undefined) patch.targeting = body.targeting;
    await db.update(campaignPosts).set(patch).where(eq(campaignPosts.id, link.id));
  }
  const postPatch: Record<string, any> = { updatedAt: new Date() };
  for (const f of ["title", "headline", "body", "description", "callToAction", "destinationUrl", "fieldValues", "imagePrompt", "status"]) {
    if (body[f] !== undefined) postPatch[f] = body[f];
  }
  if (Object.keys(postPatch).length > 1) {
    await db.update(posts).set(postPatch).where(eq(posts.id, postId));
  }
  const updated = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  // Mark the campaign as having unpublished changes
  await db.update(campaigns).set({ hasUnpublishedChanges: true, updatedAt: new Date() }).where(eq(campaigns.id, id));
  return c.json({ data: updated[0] || null });
});

// ---------------------------------------------------------------------------
// Analytics sync
// ---------------------------------------------------------------------------

campaignsRouter.post("/campaigns/:id/sync-analytics", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const result = await syncCampaignAnalytics(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), id);
  return c.json({ data: result });
});

campaignsRouter.post("/campaigns/sync/all", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const workspaceId = body.workspaceId || c.req.query("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const results = await syncAllCampaignAnalytics(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), workspaceId);
  return c.json({ data: { results } });
});

campaignsRouter.post("/campaigns/sync/:platform", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const workspaceId = body.workspaceId || c.req.query("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  // Sync every campaign in the workspace, filtered to this platform's rows
  const campRows = await db.select().from(campaigns).where(eq(campaigns.workspace_id, workspaceId)).limit(1000);
  const results: Record<string, any>[] = [];
  for (const camp of campRows as any[]) {
    try {
      const full = await loadCampaign(db, camp.id);
      const hasPlatform = (full.platforms || []).some((p: any) => p.platform?.code === c.req.param("platform"));
      if (!hasPlatform) continue;
      const res = await syncCampaignAnalytics(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), camp.id);
      results.push({ campaignId: camp.id, ...res });
    } catch (e: any) {
      results.push({ campaignId: camp.id, error: e.message });
    }
  }
  return c.json({ data: { results } });
});

campaignsRouter.post("/campaigns/sync/:platform/analytics", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const workspaceId = body.workspaceId || c.req.query("workspaceId") || body.campaignId;
  const platform = c.req.param("platform");
  if (body.campaignId) {
    const wsId = await workspaceIdOf(c, body.campaignId);
    await requireWorkspace(c, wsId);
    const stats = await syncPlatformAnalytics(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), body.campaignId, platform);
    return c.json({ data: stats });
  }
  if (!workspaceId) throw new HttpError(400, "workspaceId or campaignId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const campRows = await db.select().from(campaigns).where(eq(campaigns.workspace_id, workspaceId)).limit(1000);
  const results: Record<string, any>[] = [];
  for (const camp of campRows as any[]) {
    try {
      const stats = await syncPlatformAnalytics(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), camp.id, platform);
      results.push({ campaignId: camp.id, stats });
    } catch (e: any) {
      results.push({ campaignId: camp.id, error: e.message });
    }
  }
  return c.json({ data: { results } });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

campaignsRouter.post("/campaigns/import/google", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const workspaceId = body.workspaceId || c.req.query("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const session = sessionOf(c);
  // Find the Google connection for this workspace
  const { platformConnections: conns } = await import("../db/schema/index.js");
  const connRows = await db
    .select()
    .from(conns)
    .where(eq(conns.workspace_id, workspaceId))
    .limit(50);
  // Resolve the google_ads platform id via the connection's platform_id
  const { adPlatforms: plats } = await import("../db/schema/index.js");
  const platRows = await db.select().from(plats).where(eq(plats.code, "google_ads")).limit(1);
  const platformId = (platRows[0] as any)?.id;
  const connection = (connRows as any[]).find((r) => r.platform_id === platformId);
  if (!connection) throw new HttpError(404, "Google Ads is not connected for this workspace", "NOT_FOUND");
  // account_id from the workspace
  const { workspaces: wsTable } = await import("../db/schema/index.js");
  const wsRows = await db.select().from(wsTable).where(eq(wsTable.id, workspaceId)).limit(1);
  const accountId = (wsRows[0] as any)?.account_id;
  const result = await importGoogleCampaigns(db, c.env as unknown as Record<string, string | undefined>, secretKey(c), {
    workspaceId,
    accountId,
    connection,
    uid: session.userId,
  });
  return c.json({ data: result });
});

// ---------------------------------------------------------------------------
// Audience targeting search
// ---------------------------------------------------------------------------

campaignsRouter.get("/campaigns/audience/interests/search", async (c) => {
  const db = getDb(c.env.DB);
  const workspaceId = c.req.query("workspaceId") || "";
  const q = c.req.query("q") || "";
  const platforms = (c.req.query("platforms") || "meta").split(",").map((s) => s.trim()).filter(Boolean);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const results = await resolveInterests(depsOf(c, db), workspaceId, q, platforms);
  return c.json({ data: results });
});

campaignsRouter.get("/campaigns/audience/locations/search", async (c) => {
  const db = getDb(c.env.DB);
  const workspaceId = c.req.query("workspaceId") || "";
  const q = c.req.query("q") || "";
  const platforms = (c.req.query("platforms") || "google,meta").split(",").map((s) => s.trim()).filter(Boolean);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const results = await resolveLocations(depsOf(c, db), workspaceId, q, platforms);
  return c.json({ data: results });
});

// ---------------------------------------------------------------------------
// Google lookups
// ---------------------------------------------------------------------------

campaignsRouter.get("/campaigns/locations/google/search", async (c) => {
  const db = getDb(c.env.DB);
  const workspaceId = c.req.query("workspaceId") || "";
  const q = c.req.query("q") || "";
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const results = await searchGeoTargets(
    depsOf(c, db),
    workspaceId,
    q,
    c.req.query("countryCode") || undefined,
    c.req.query("locale") || undefined,
  );
  return c.json({ data: results });
});

campaignsRouter.get("/campaigns/languages/google/search", async (c) => {
  const db = getDb(c.env.DB);
  const workspaceId = c.req.query("workspaceId") || "";
  const q = c.req.query("q") || "";
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const results = await searchLanguages(depsOf(c, db), workspaceId, q);
  return c.json({ data: results });
});

campaignsRouter.get("/campaigns/google/campaign-types", async (c) => {
  const db = getDb(c.env.DB);
  const workspaceId = c.req.query("workspaceId") || "";
  const objective = c.req.query("objective") || "website_visitors";
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const results = await googleCampaignTypes(depsOf(c, db), workspaceId, objective);
  return c.json({ data: results });
});

campaignsRouter.get("/campaigns/merchant-products/google/search", async (c) => {
  const db = getDb(c.env.DB);
  const workspaceId = c.req.query("workspaceId") || "";
  const q = c.req.query("q") || "";
  if (!workspaceId) throw new HttpError(400, "workspaceId is required", "BAD_REQUEST");
  await requireWorkspace(c, workspaceId);
  const results = await merchantProducts(depsOf(c, db), workspaceId);
  return c.json({ data: results });
});

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

campaignsRouter.get("/campaigns/youtube/metadata", async (c) => {
  const url = c.req.query("url") || "";
  if (!url) throw new HttpError(400, "url is required", "BAD_REQUEST");
  const meta = await YouTubeMetadataService.fetchMetadata(url);
  if (!meta) throw new HttpError(404, "Could not resolve a YouTube video from that URL", "NOT_FOUND");
  return c.json({ data: meta });
});

// ---------------------------------------------------------------------------
// Landing pages
// ---------------------------------------------------------------------------

campaignsRouter.post("/campaigns/:id/landing-page/generate", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const page = await generateLandingPage(db, id, { uid: session.userId });
  return c.json({ data: page });
});

campaignsRouter.post("/campaigns/:id/landing-page/preview", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const appUrl = c.env.APP_URL || "https://app.adreacher.com";
  const page = await getLandingPage(db, id, appUrl);
  if (!page) throw new HttpError(404, "Generate a landing page first", "NOT_FOUND");
  return c.json({ data: page });
});

campaignsRouter.post("/campaigns/:id/landing-page/approve", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const appUrl = c.env.APP_URL || "https://app.adreacher.com";
  const page = await approveLandingPage(db, id, appUrl);
  // Record the approval on the campaign for the launch gate
  await db.update(campaigns).set({ landingPageApprovedAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, id));
  return c.json({ data: page });
});

campaignsRouter.get("/campaigns/:id/landing-page/generated", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const appUrl = c.env.APP_URL || "https://app.adreacher.com";
  const page = await getLandingPage(db, id, appUrl);
  return c.json({ data: page });
});

// ---------------------------------------------------------------------------
// Auto-loop
// ---------------------------------------------------------------------------

campaignsRouter.get("/campaigns/:id/auto-loop", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const campaign = await loadCampaign(db, id);
  await requireWorkspace(c, campaign.workspace_id);
  const settings = await loopSettings(db, campaign.workspace_id);
  const metrics = await campaignMetrics(db, id);
  const score = computeScore(metrics, settings.comparisonWeights);
  return c.json({ data: { settings, metrics, score, autoOptimize: campaign.autoOptimize, autoOptimizeConfig: campaign.autoOptimizeConfig } });
});

campaignsRouter.post("/campaigns/:id/auto-loop/enable", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const body = await c.req.json().catch(() => ({}));
  await db.update(campaigns).set({ autoOptimize: true, autoOptimizeConfig: body.config || {}, updatedAt: new Date() }).where(eq(campaigns.id, id));
  // Also flip the workspace-level switch
  const wsRows = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspace_id, wsId)).limit(1);
  if (wsRows[0]) {
    await db.update(workspaceSettings).set({ autoLoopEnabled: true, updatedAt: new Date() }).where(eq(workspaceSettings.id, (wsRows[0] as any).id));
  }
  return c.json({ data: { enabled: true } });
});

campaignsRouter.post("/campaigns/:id/auto-loop/disable", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  await db.update(campaigns).set({ autoOptimize: false, updatedAt: new Date() }).where(eq(campaigns.id, id));
  return c.json({ data: { enabled: false } });
});

campaignsRouter.post("/campaigns/:id/auto-loop/run-once", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const session = sessionOf(c);
  const result = await runIteration(db, c.env as unknown as Record<string, string | undefined>, id, { trigger: "manual", uid: session.userId });
  return c.json({ data: result });
});

// ---------------------------------------------------------------------------
// Google creative (AI — Phase 5; readiness is non-AI and works now)
// ---------------------------------------------------------------------------

const notImplemented = () => {
  throw new HttpError(501, "AI creative generation arrives in Phase 5", "NOT_IMPLEMENTED");
};

campaignsRouter.post("/campaigns/:id/google-creative", async (c) => {
  const db = getDb(c.env.DB);
  await requireWorkspace(c, await workspaceIdOf(c, c.req.param("id")));
  return notImplemented();
});

campaignsRouter.post("/campaigns/:id/google-creative/generate-images", async (c) => {
  const db = getDb(c.env.DB);
  await requireWorkspace(c, await workspaceIdOf(c, c.req.param("id")));
  return notImplemented();
});

campaignsRouter.post("/campaigns/:id/google-creative/generate-portrait", async (c) => {
  const db = getDb(c.env.DB);
  await requireWorkspace(c, await workspaceIdOf(c, c.req.param("id")));
  return notImplemented();
});

campaignsRouter.post("/campaigns/:id/google-creative/expand-from-portrait", async (c) => {
  const db = getDb(c.env.DB);
  await requireWorkspace(c, await workspaceIdOf(c, c.req.param("id")));
  return notImplemented();
});

campaignsRouter.post("/campaigns/:id/google-creative/assemble", async (c) => {
  const db = getDb(c.env.DB);
  await requireWorkspace(c, await workspaceIdOf(c, c.req.param("id")));
  return notImplemented();
});

campaignsRouter.get("/campaigns/:id/google-creative/readiness", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const wsId = await workspaceIdOf(c, id);
  await requireWorkspace(c, wsId);
  const readiness = await googleCreativeReadiness(db, id);
  return c.json({ data: readiness });
});
