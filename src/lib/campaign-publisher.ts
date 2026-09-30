// Campaign publishing orchestration: validate → build payloads → publish → persist
// platform rows → status transitions. Port of the old lib/campaign-publisher.js,
// backed by Drizzle/D1.
//
// The provider registry maps platform codes to the ported provider modules.
// TikTok/Reddit/Pinterest remain declared stubs (they were stubs in the old backend).
import { and, eq, isNull } from "drizzle-orm";
import {
  adPlatforms,
  brandProfiles,
  campaignActivities,
  campaignAnalytics,
  campaignPlatforms,
  campaignPosts,
  campaigns,
  mediaAssets,
  platformConnections,
  postMedia,
  posts,
} from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";
import { getConnectionConfig, getValidAccessToken } from "./connections.js";
import { googleAdsVersion } from "./platform-providers.js";
import { google } from "./providers/google-ads.js";
import { bing } from "./providers/bing-ads.js";
import { meta } from "./providers/meta-ads.js";
import { x } from "./providers/x-ads.js";

const now = () => new Date();

interface ProviderCtx {
  accessToken: string;
  adAccountId: string | null;
  customerId: string | null;
  loginCustomerId: string | null;
  developerToken: string | null;
  apiVersion: string | null;
  currency: string | null;
  country: string | null;
  pageId: string | null;
  pageName: string | null;
  connection: Record<string, any>;
  cfg: Record<string, any>;
  tokenSecret: string | null;
}

interface Provider {
  code: string;
  atomic?: boolean;
  unavailable?: boolean;
  message?: string;
  createCampaign: (ctx: ProviderCtx, campaign: any, payload?: any) => Promise<any>;
  createAdSet: (ctx: ProviderCtx, campaign: any, opts: any, platformCampaignId: string) => Promise<any>;
  createAdFromPost: (ctx: ProviderCtx, campaign: any, post: any, mediaUrls: string[], targeting: any, adSetId: string) => Promise<any>;
  updateCampaign?: (ctx: ProviderCtx, campaign: any, platformCampaignId: string, adSetId: string, targeting: any) => Promise<any>;
  updateCreative?: (ctx: ProviderCtx, campaign: any, posts: any[], opts: any) => Promise<any>;
  publishAtomic?: (ctx: ProviderCtx, campaign: any, posts: any[], opts: any) => Promise<any>;
  pauseCampaign: (ctx: ProviderCtx, platformCampaignId: string) => Promise<any>;
  resumeCampaign: (ctx: ProviderCtx, platformCampaignId: string) => Promise<any>;
  removeCampaign?: (ctx: ProviderCtx, platformCampaignId: string) => Promise<any>;
  pauseAdSet?: (ctx: ProviderCtx, adSetId: string) => Promise<any>;
  resumeAdSet?: (ctx: ProviderCtx, adSetId: string) => Promise<any>;
  getCampaignStats?: (ctx: ProviderCtx, platformCampaignId: string, opts?: { since?: string; until?: string }) => Promise<any>;
  fetchExistingCampaigns?: (ctx: ProviderCtx) => Promise<any>;
  validate?: (campaign: any, posts: any[]) => string[] | null;
  goalFor?: (objective: string) => string;
  requires?: string[];
}

const PROVIDERS: Record<string, Provider> = {
  google_ads: google as unknown as Provider,
  google: google as unknown as Provider,
  bing_ads: bing as unknown as Provider,
  bing: bing as unknown as Provider,
  meta: meta as unknown as Provider,
  facebook: meta as unknown as Provider,
  instagram: meta as unknown as Provider,
  x: x as unknown as Provider,
  twitter: x as unknown as Provider,
};

const STUBS: Record<string, { unavailable: boolean; message: string }> = {
  tiktok: { unavailable: true, message: "TikTok publishing is not implemented yet" },
  tiktok_ads: { unavailable: true, message: "TikTok publishing is not implemented yet" },
  reddit: { unavailable: true, message: "Reddit publishing is not implemented yet" },
  reddit_ads: { unavailable: true, message: "Reddit publishing is not implemented yet" },
  pinterest: { unavailable: true, message: "Pinterest publishing is not implemented yet" },
  pinterest_ads: { unavailable: true, message: "Pinterest publishing is not implemented yet" },
};

export function campaignProviderFor(code: string): Provider | null {
  const p = PROVIDERS[code];
  if (p) return p;
  const stub = STUBS[code];
  if (stub) return { code, ...stub } as Provider;
  return null;
}

/** Load a campaign with its platforms, posts links, and derived metrics. */
export async function loadCampaign(db: Db, id: string): Promise<Record<string, any>> {
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  const c = rows[0] as unknown as Record<string, any> | undefined;
  if (!c) throw new HttpError(404, "Campaign not found", "NOT_FOUND");

  // Platforms with their ad_platforms row joined
  const cpRows = await db.select().from(campaignPlatforms).where(eq(campaignPlatforms.campaign_id, id));
  const platforms: Record<string, any>[] = [];
  for (const cp of cpRows as any[]) {
    let platform: Record<string, any> | null = null;
    if (cp.platform_id) {
      const pr = await db.select().from(adPlatforms).where(eq(adPlatforms.id, cp.platform_id)).limit(1);
      platform = (pr[0] as unknown as Record<string, any>) || null;
    }
    platforms.push({ ...cp, platform });
  }
  c.platforms = platforms;

  try {
    const aRows = await db
      .select()
      .from(campaignAnalytics)
      .where(and(eq(campaignAnalytics.campaign_id, id), isNull(campaignAnalytics.hour)))
      .limit(1000);
    const sum = (k: string) => aRows.reduce((n, r: any) => n + Number(r[k] || 0), 0);
    const impressions = sum("impressions");
    const clicks = sum("clicks");
    let spend = sum("spend");
    const conversions = sum("conversions");
    const revenue = sum("revenue");

    const cpSpend = platforms.reduce((n, p) => n + Number(p.spend || 0), 0);
    if (cpSpend > spend) spend = cpSpend;

    let reach = 0, frequency = 0, videoViews = 0, engagements = 0;
    for (const cp of platforms) {
      if (cp.payload?.reach) reach += Number(cp.payload.reach || 0);
      if (cp.payload?.frequency && !frequency) frequency = Number(cp.payload.frequency || 0);
      if (cp.payload?.engagements) engagements += Number(cp.payload.engagements || 0);
      if (cp.payload?.videoViews) videoViews += Number(cp.payload.videoViews || 0);
    }
    for (const r of aRows as any[]) {
      if (r.metrics?.videoViews) videoViews += Number(r.metrics.videoViews || 0);
      if (r.metrics?.engagements) engagements += Number(r.metrics.engagements || 0);
    }

    const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
    const cpc = clicks > 0 ? Number((spend / clicks).toFixed(2)) : 0;
    const cpa = conversions > 0 ? Number((spend / conversions).toFixed(2)) : 0;
    const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : 0;

    c.metrics = { impressions, clicks, spend, conversions, revenue, ctr, cpc, cpa, roas, reach, frequency, videoViews, engagements };
  } catch {
    // Keep raw campaign if analytics hydration fails
  }
  return c;
}

async function activity(db: Db, campaign: Record<string, any>, type: string, message: string, meta: Record<string, any> = {}, actorId: string | null = null) {
  await db
    .insert(campaignActivities)
    .values({
      campaign_id: campaign.id,
      account_id: campaign.account_id,
      actor_id: actorId,
      type: type as any,
      message,
      meta,
      occurredAt: now(),
    })
    .catch(() => {});
}

export function isPastEndDate(endDate: unknown): boolean {
  if (!endDate) return false;
  const d = new Date(endDate as string);
  if (isNaN(d.getTime())) return false;
  const endOfDay = new Date(d);
  if (typeof endDate === "string" && !endDate.includes("T")) {
    const [y, m, day] = endDate.split("-").map(Number);
    if (y && m && day) endOfDay.setFullYear(y, m - 1, day);
  }
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay.getTime() < Date.now();
}

/** Derived campaign status from its platform rows (reach_be computeDerivedStatus, Baasix vocabulary). */
export function deriveStatus(platforms: Record<string, any>[], campaign: Record<string, any> | null = null): string {
  if (campaign?.endDate && isPastEndDate(campaign.endDate) && campaign?.status !== "draft" && campaign?.status !== "archived") {
    return "completed";
  }
  const s = platforms.map((p) => {
    if (p.status === "completed" && campaign?.endDate && !isPastEndDate(campaign.endDate) && p.externalCampaignId) {
      return "live";
    }
    return p.status;
  });
  if (!s.length) return "draft";
  const live = s.includes("live"), paused = s.includes("paused"), failed = s.includes("failed") || s.includes("rejected"), pending = s.includes("pending") || s.includes("publishing");
  if (s.every((x) => x === "completed")) return "completed";
  if (s.every((x) => x === "pending")) return "draft";
  if (s.every((x) => x === "paused" || x === "completed")) return "paused";
  if (live && (paused || failed || pending)) return "partial";
  if (live) return "active";
  if (failed) return "failed";
  return "draft";
}

export async function refreshCampaignStatus(db: Db, campaignId: string): Promise<string> {
  const c = await loadCampaign(db, campaignId);
  if (c.endDate && !isPastEndDate(c.endDate)) {
    for (const cp of c.platforms || []) {
      if (cp.status === "completed" && cp.externalCampaignId) {
        await db.update(campaignPlatforms).set({ status: "live", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id)).catch(() => {});
        cp.status = "live";
      }
    }
  }
  const status = c.status === "archived" ? "archived" : deriveStatus(c.platforms || [], c);
  if (status !== c.status) {
    await db.update(campaigns).set({ status: status as any, updatedAt: now() }).where(eq(campaigns.id, campaignId));
  }
  return status;
}

/** Connection + provider context for a campaign platform row. */
export async function contextFor(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaign: Record<string, any>,
  cp: Record<string, any>,
): Promise<{ provider: Provider; ctx: ProviderCtx }> {
  const code = cp.platform?.code;
  const provider = campaignProviderFor(code);
  if (!provider) throw new Error(`No publishing support for ${cp.platform?.name || code}`);
  if (provider.unavailable) throw new Error(provider.message);

  let connectionId = cp.connection_id;
  if (!connectionId) {
    const connRows = await db
      .select()
      .from(platformConnections)
      .where(and(eq(platformConnections.workspace_id, campaign.workspace_id), eq(platformConnections.platform_id, cp.platform_id)))
      .limit(1);
    const conn = connRows[0] as unknown as Record<string, any> | undefined;
    if (conn) {
      connectionId = conn.id;
      await db.update(campaignPlatforms).set({ connection_id: conn.id, updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    }
  }
  if (!connectionId) throw new Error(`Not connected to ${cp.platform?.name}. Connect it in Connections first.`);

  const { accessToken, connection } = await getValidAccessToken(db, secretKey, campaign.workspace_id, code, env);
  if (["disconnected", "expired", "not_connected"].includes(connection.status)) {
    throw new Error(`${cp.platform?.name} connection is ${connection.status.replace("_", " ")} — reconnect in Connections`);
  }
  const { config: cfg } = await getConnectionConfig(db, env, secretKey, campaign.workspace_id, code);
  const m = connection.meta || {};

  const targetAccountId = String(cp.payload?.importedAccountId || m.selectedAdAccountId || connection.externalAccountId || "").replace(/-/g, "") || null;
  const targetCust = (m.customers || []).find((c: any) => String(c.id).replace(/-/g, "") === targetAccountId);
  const directManager = targetCust?.managedBy ? String(targetCust.managedBy).replace(/-/g, "") : null;
  // `meta.managerCustomerId` comes from platform config and can name a manager this login has
  // no access to — Google answers 403 for it — so it only counts when discovery actually listed it.
  const cfgManager = m.managerCustomerId ? String(m.managerCustomerId).replace(/-/g, "") : null;
  const fallbackManager = cfgManager && (m.customers || []).some((c: any) => String(c.id).replace(/-/g, "") === cfgManager) ? cfgManager : null;

  const ctx: ProviderCtx = {
    accessToken,
    adAccountId: m.selectedAdAccountId
      ? code === "meta"
        ? String(m.selectedAdAccountId).startsWith("act_") ? m.selectedAdAccountId : `act_${m.selectedAdAccountId}`
        : m.selectedAdAccountId
      : code !== "meta" ? connection.externalAccountId : null,
    pageId: m.selectedPageId || m.pages?.[0]?.id || null,
    pageName: (m.pages || []).find((p: any) => p.id === (m.selectedPageId || m.pages?.[0]?.id))?.name || connection.externalAccountName,
    currency: connection.currency || campaign.currency,
    country: null,
    connection,
    cfg: cfg || {},
    tokenSecret: connection.refreshToken || m.accessTokenSecret || null,
    customerId: targetAccountId,
    loginCustomerId: directManager || fallbackManager || (targetCust?.isManager ? targetAccountId : String(connection.externalAccountId || "").replace(/-/g, "")) || null,
    developerToken: (cfg as any)?.developerToken || (code === "bing_ads" || code === "bing" ? env.ADS_BING_ADS_DEVELOPER_TOKEN : env.ADS_GOOGLE_ADS_DEVELOPER_TOKEN) || null,
    apiVersion: code === "google" || code === "google_ads" ? googleAdsVersion(cfg || {}) : ((cfg as any)?.extra?.adsApiVersion || null),
  };

  return { provider, ctx };
}

async function postsFor(db: Db, campaign: Record<string, any>, platformId: string) {
  const q = async (filter: Record<string, any>) => {
    const all = await db.select().from(campaignPosts).where(eq(campaignPosts.campaign_id, campaign.id)).limit(100);
    // Filter in JS for the platform_id variant (Drizzle eq on nullable text is fine, but keep it simple)
    return (all as any[]).filter((r) => {
      if (filter.platform_id && r.platform_id !== filter.platform_id?.eq) return false;
      return true;
    });
  };
  let rows = await q({ campaign_id: { eq: campaign.id }, platform_id: { eq: platformId } });
  if (!rows.length) rows = await q({ campaign_id: { eq: campaign.id } });

  // Hydrate the post for each link
  const hydrated: Record<string, any>[] = [];
  for (const r of rows) {
    if (!r.post_id) continue;
    const pr = await db.select().from(posts).where(eq(posts.id, r.post_id)).limit(1);
    if (pr[0]) hydrated.push({ ...r, post: pr[0] });
  }
  let filtered = hydrated.filter((r) => r.post);

  // `post_media` is a join table; resolve media asset URLs in one extra lookup.
  const ids = [...new Set(filtered.flatMap((r) => []))]; // media hydrated below via fieldValues
  void ids;

  // If a campaign-specific creative bundle was saved on this campaign_post or in draftState,
  // overlay it onto the post object for this campaign publish run without altering the master post row in DB
  for (const r of filtered) {
    const gc =
      (r.platformCreative?.bing && typeof r.platformCreative.bing === "object" ? r.platformCreative.bing : null) ||
      (r.platformCreative?.google && typeof r.platformCreative.google === "object" ? r.platformCreative.google : null) ||
      (campaign.draftState?.googleCreativeBundle && typeof campaign.draftState.googleCreativeBundle === "object" ? campaign.draftState.googleCreativeBundle : null) ||
      (campaign.draftState?.creative && typeof campaign.draftState.creative === "object" ? campaign.draftState.creative : null);

    if (gc) {
      const existingExtras = r.post.fieldValues?.imageSet?.extras;
      const gcImageSet = gc.imageSet && typeof gc.imageSet === "object" ? { ...gc.imageSet } : null;
      if (gcImageSet && existingExtras && (!gcImageSet.extras || (!gcImageSet.extras.landscape?.length && !gcImageSet.extras.square?.length && !gcImageSet.extras.portrait?.length))) {
        gcImageSet.extras = existingExtras;
      }
      r.post = {
        ...r.post,
        fieldValues: { ...(r.post.fieldValues || {}), ...gc, ...(gcImageSet ? { imageSet: gcImageSet } : {}) },
      };
      if (gc.headlines?.[0]) r.post.headline = gc.headlines[0];
      if (gc.descriptions?.[0]) r.post.description = gc.descriptions[0];
      if (gc.finalUrl) r.post.destinationUrl = gc.finalUrl;
      if (gc.landingPageUrl && !r.post.destinationUrl) r.post.destinationUrl = gc.landingPageUrl;
    }
    if (!r.post.destinationUrl) {
      r.post.destinationUrl =
        r.post.fieldValues?.finalUrl ||
        r.post.fieldValues?.destinationUrl ||
        campaign.landingPageUrl ||
        campaign.draftState?.landingPageUrl ||
        campaign.trackingFinalUrl ||
        null;
    }
  }
  return filtered;
}

const mediaUrlsOf = (post: Record<string, any>): string[] => {
  if (Array.isArray(post?.mediaUrls) && post.mediaUrls.length) return post.mediaUrls.filter(Boolean);
  if (typeof post?.imageUrl === "string" && post.imageUrl) return [post.imageUrl];
  if (typeof post?.mediaUrl === "string" && post.mediaUrl) return [post.mediaUrl];
  const fv = post?.fieldValues || {};
  if (fv.imageSet && typeof fv.imageSet === "object") {
    const slotUrls = ["landscape", "square", "portrait", "logo"]
      .map((k) => (typeof fv.imageSet[k] === "string" ? fv.imageSet[k] : fv.imageSet[k]?.url))
      .filter(Boolean);
    const extraUrls = [
      ...(fv.imageSet.extras?.landscape || []).map((x: any) => (typeof x === "string" ? x : x?.url)),
      ...(fv.imageSet.extras?.square || []).map((x: any) => (typeof x === "string" ? x : x?.url)),
      ...(fv.imageSet.extras?.portrait || []).map((x: any) => (typeof x === "string" ? x : x?.url)),
    ].filter(Boolean);
    const allSetUrls = [...slotUrls, ...extraUrls];
    if (allSetUrls.length > 0) return [...new Set(allSetUrls)];
  }
  const urls: string[] = [];
  const add = (u: unknown) => {
    if (!u) return;
    if (typeof u === "string" && u.trim()) urls.push(u.trim());
    else if (typeof u === "object" && (u as any).url) urls.push(String((u as any).url).trim());
  };
  if (Array.isArray(fv.mediaUrls)) fv.mediaUrls.forEach(add);
  if (Array.isArray(post?.mediaUrls)) post.mediaUrls.forEach(add);
  if (Array.isArray(fv.mediaAssets)) fv.mediaAssets.forEach((a: any) => add(a?.url));
  if (Array.isArray(post?.mediaAssets)) post.mediaAssets.forEach((a: any) => add(a?.url));
  if (post?.mediaAsset?.url) add(post.mediaAsset.url);
  if (post?.imageUrl) add(post.imageUrl);
  if (fv.imageUrl) add(fv.imageUrl);
  (post?.media || []).forEach((m: any) => add(m?.url));
  return [...new Set(urls.filter(Boolean))];
};

export function campaignTypeOf(campaign: Record<string, any>): string | null {
  const google = (campaign.platforms || []).find((p: any) => (p.platform?.code || "").startsWith("google"));
  const t = String(google?.campaignType || google?.payload?.targeting?.campaignType || campaign.draftState?.googleCampaignType || "").toUpperCase();
  if (!t) return (campaign.platforms || []).length ? "social" : null;
  if (t === "PERFORMANCE_MAX") return "performance_max";
  if (t === "DEMAND_GEN") return "demand_gen";
  if (t === "SEARCH" || t === "SHOPPING") return "search";
  return "social";
}

/** Publish one campaign_platforms row. Never throws — records the outcome on the row. */
async function publishPlatform(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaign: Record<string, any>,
  cp: Record<string, any>,
  uid: string | null,
) {
  const name = cp.platform?.name || cp.platform?.code;
  try {
    await db.update(campaignPlatforms).set({ status: "publishing", platformMessage: null, failureCode: null, updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    const { provider, ctx } = await contextFor(db, env, secretKey, campaign, cp);
    const payload = { ...(cp.payload || {}) };
    const aud = campaign.draftState?.audience || campaign.audience || {};
    const targeting = {
      ...(campaign.targeting || {}),
      ...(campaign.draftState?.targeting || {}),
      ...(aud.locations?.length ? { locations: aud.locations } : {}),
      ...(aud.languages?.length ? { languages: aud.languages } : {}),
      ...(aud.keywords?.length ? { keywords: aud.keywords } : {}),
      ...(aud.ageMin !== undefined ? { ageMin: aud.ageMin } : {}),
      ...(aud.ageMax !== undefined ? { ageMax: aud.ageMax } : {}),
      ...(aud.genders?.length ? { genders: aud.genders } : {}),
      ...(payload.targeting || {}),
      ...(aud.keywords?.length ? { keywords: aud.keywords } : {}),
    };
    let platformCampaignId = cp.externalCampaignId;
    let adSetId = payload.adSetId;

    // If a previous publish attempt failed because the campaign type on the ad network
    // was incompatible with asset groups, clear the invalid ids so the provider can
    // create a fresh campaign with the proper type.
    if (
      cp.status === "failed" &&
      platformCampaignId &&
      (
        (cp.platformMessage || "").includes("UnsupportedCampaignTypeForAssetGroup") ||
        (cp.platformMessage || "").includes("The AdGroup name is invalid") ||
        (cp.platformMessage || "").includes("The AdGroup ID is invalid") ||
        (cp.platformMessage || "").includes("The campaign ID is invalid") ||
        (cp.platformMessage || "").includes("The number of descriptions is more than maximum allowed") ||
        (cp.platformMessage || "").includes("created 0 of") ||
        ((provider.code === "bing_ads" || provider.code === "bing") && !adSetId)
      )
    ) {
      platformCampaignId = null;
      adSetId = null;
      delete payload.adSetId;
    }

    if (provider.atomic) {
      if (platformCampaignId) {
        if (cp.status === "paused") {
          await provider.resumeCampaign(ctx, platformCampaignId);
        }
        await db.update(campaignPlatforms).set({ status: "live", platformMessage: null, failureCode: null, lastSyncedAt: now(), updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
        await activity(db, campaign, "resumed", `Ensured live on ${name}`, { platformCampaignId }, uid);
        return { platform: cp.platform?.code, success: true, platformCampaignId, adIds: payload.adIds || [] };
      }
      const links = await postsFor(db, campaign, cp.platform_id);
      const isShopping = provider.code === "google_ads" && String(targeting.campaignType || campaign.draftState?.googleCampaignType || "").toUpperCase() === "SHOPPING";
      if (!links.length && !isShopping) throw new Error("Add at least one post (creative) to this campaign before launching");
      const brandRows = await db.select().from(brandProfiles).where(eq(brandProfiles.workspace_id, campaign.workspace_id)).limit(1);
      const brand = (brandRows[0] as unknown as Record<string, any>) || null;
      const postsList = links.length
        ? links.map((l) => ({ post: l.post, mediaUrls: mediaUrlsOf(l.post), targeting: { ...targeting, ...(l.targeting || {}) }, budgetAmount: cp.budgetAmount }))
        : [{ post: { title: campaign.name, fieldValues: {} }, mediaUrls: [], targeting, budgetAmount: cp.budgetAmount }];
      const r = await provider.publishAtomic!(ctx, campaign, postsList, { brand: brand ? { name: brand.business?.name, logoUrl: brand.branding?.logoUrl } : null, uid: uid || campaign.user_id });
      await Promise.all(links.map((l) => db.update(campaignPosts).set({ platformAdId: r.adIds?.[0] || null, platformPostId: r.platformAdSetId, startedAt: now(), reviewStatus: "not_required", updatedAt: now() }).where(eq(campaignPosts.id, l.id))));
      await db.update(campaignPlatforms).set({ status: "live", externalCampaignId: r.platformCampaignId, campaignType: r.campaignType || null, nativeObjective: r.nativeObjective || null, payload: { ...payload, adSetId: r.platformAdSetId, adIds: r.adIds || [], texts: r.texts || undefined }, publishedAt: now(), lastSyncedAt: now(), platformMessage: null, failureCode: null, updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
      await activity(db, campaign, "launched", `Launched on ${name}`, { platformCampaignId: r.platformCampaignId, campaignType: r.campaignType }, uid);
      return { platform: cp.platform?.code, success: true, platformCampaignId: r.platformCampaignId, adIds: r.adIds || [] };
    }

    const brandRows = campaign.workspace_id
      ? await db.select().from(brandProfiles).where(eq(brandProfiles.workspace_id, campaign.workspace_id)).limit(1)
      : [];
    const brand = (brandRows[0] as unknown as Record<string, any>) || null;
    const campaignWithTargeting = {
      ...campaign,
      brandLogoUrl: brand?.branding?.logoUrl || null,
      brandName: brand?.business?.name || null,
      targeting: {
        ...(campaign.targeting || {}),
        ...(campaign.draftState?.targeting || {}),
        ...(campaign.draftState?.audience?.keywords?.length ? { keywords: campaign.draftState.audience.keywords } : {}),
        ...(campaign.audience?.keywords?.length ? { keywords: campaign.audience.keywords } : {}),
        ...targeting,
      },
    };

    const targetCampaignType = String(
      targeting.campaignType ||
      campaign.draftState?.bingCampaignType ||
      campaignWithTargeting.targeting?.campaignType ||
      ""
    ).toLowerCase();

    if ((provider.code === "bing_ads" || provider.code === "bing") && cp.status !== "live") {
      if (targetCampaignType === "performance_max" && cp.campaignType !== "performance_max") {
        platformCampaignId = null;
        adSetId = null;
      }
    }

    if (!platformCampaignId) {
      const r = await provider.createCampaign(ctx, campaignWithTargeting);
      platformCampaignId = r.platformCampaignId;
      await db.update(campaignPlatforms).set({
        externalCampaignId: platformCampaignId,
        campaignType: r.campaignType || targetCampaignType || null,
        nativeObjective: provider.code === "meta" ? undefined : null,
        updatedAt: now(),
      }).where(eq(campaignPlatforms.id, cp.id));
    }
    if (!adSetId) {
      const isBing = provider.code === "bing_ads" || provider.code === "bing";
      const r = await provider.createAdSet(
        ctx,
        campaignWithTargeting,
        {
          budgetAmount: cp.budgetAmount,
          targeting,
          name: isBing ? `${campaign.name || "Reach"} - Ad Group` : `${campaign.name || "Reach"} - ad set`,
        },
        platformCampaignId
      );
      adSetId = r.platformAdSetId;
      payload.adSetId = adSetId;
      payload.optimizationGoal = r.optimizationGoal;
      await db.update(campaignPlatforms).set({ payload, updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    }

    const rawPosts = await postsFor(db, campaign, cp.platform_id);
    const seenPostIds = new Set<string>();
    const postsList: Record<string, any>[] = [];
    for (const p of rawPosts) {
      const pid = p.post_id || p.post?.id;
      if (pid && !seenPostIds.has(pid)) {
        seenPostIds.add(pid);
        postsList.push(p);
      } else if (!pid) {
        postsList.push(p);
      }
    }

    const adIds: string[] = [];
    const errors: string[] = [];
    for (const link of postsList) {
      if (link.platformAdId) {
        adIds.push(link.platformAdId);
        continue;
      }
      try {
        const r = await provider.createAdFromPost(
          ctx,
          campaignWithTargeting,
          link.post,
          mediaUrlsOf(link.post),
          { ...targeting, ...(link.targeting || {}) },
          adSetId
        );
        if (r.platformCampaignId && r.platformCampaignId !== platformCampaignId) {
          platformCampaignId = r.platformCampaignId;
          await db.update(campaignPlatforms).set({ externalCampaignId: platformCampaignId, campaignType: "performance_max", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
        }
        await db.update(campaignPosts).set({ platformAdId: r.platformAdId, platformPostId: r.platformPostId, startedAt: now(), reviewStatus: "not_required", updatedAt: now() }).where(eq(campaignPosts.id, link.id));
        adIds.push(r.platformAdId);
      } catch (e: any) {
        errors.push(`${link.post.title || link.post_id}: ${e.message}`);
      }
    }
    if (!postsList.length) throw new Error("Add at least one post (creative) to this campaign before launching");
    if (errors.length) throw new Error(`${name} created ${adIds.length} of ${postsList.length} ads. ${errors.join(" | ")}`);
    if (cp.externalCampaignId && cp.status === "paused") {
      await provider.resumeCampaign(ctx, platformCampaignId);
      if (adSetId && provider.resumeAdSet) await provider.resumeAdSet(ctx, adSetId);
    }
    await db.update(campaignPlatforms).set({ status: "live", externalCampaignId: platformCampaignId, payload: { ...payload, adIds }, publishedAt: cp.publishedAt || now(), lastSyncedAt: now(), platformMessage: null, failureCode: null, updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    await activity(db, campaign, "launched", `Launched on ${name}`, { platformCampaignId, adIds }, uid);
    return { platform: cp.platform?.code, success: true, platformCampaignId, adIds };
  } catch (e: any) {
    const msg = e.message || String(e);
    await db.update(campaignPlatforms).set({ status: "failed", platformMessage: msg, failureCode: e.code ? String(e.code) : "PUBLISH_FAILED", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    await activity(db, campaign, "rejected", `${name} publish failed — ${msg}`, {}, uid);
    return { platform: cp.platform?.code, success: false, error: msg };
  }
}

export async function publishCampaign(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaignId: string,
  opts: { platformCodes?: string[]; uid?: string | null } = {},
) {
  const { platformCodes, uid } = opts;
  const campaign = await loadCampaign(db, campaignId);
  if (campaign.requireLandingApproval && !campaign.landingPageApprovedAt) {
    throw new HttpError(400, "Approve the landing page before launching", "BAD_REQUEST");
  }
  // Plan limits are enforced by the route layer via checkAndIncrement; the publisher
  // records the launch itself.
  let targets = campaign.platforms || [];
  if (platformCodes?.length) targets = targets.filter((p: any) => platformCodes.includes(p.platform?.code));
  if (!targets.length) throw new HttpError(400, "Pick at least one platform for this campaign", "BAD_REQUEST");
  const results = await Promise.all(targets.map((cp: any) => publishPlatform(db, env, secretKey, campaign, cp, uid || null)));
  if (results.some((r) => r.success)) await markPublished(db, campaignId);
  const status = await refreshCampaignStatus(db, campaignId);
  const ok = results.filter((r) => r.success);
  const bad = results.filter((r) => !r.success);
  return { campaignId, status, success: ok.length > 0, publishedPlatforms: ok.map((r) => r.platform), failedPlatforms: bad.map((r) => r.platform), results };
}

async function forEachLive(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaign: Record<string, any>,
  fn: (provider: Provider, ctx: ProviderCtx, cp: Record<string, any>) => Promise<Record<string, any>>,
) {
  const out: Record<string, any>[] = [];
  for (const cp of campaign.platforms || []) {
    if (!cp.externalCampaignId) continue;
    try {
      const { provider, ctx } = await contextFor(db, env, secretKey, campaign, cp);
      out.push({ platform: cp.platform?.code, ...(await fn(provider, ctx, cp)) });
    } catch (e: any) {
      out.push({ platform: cp.platform?.code, error: e.message, success: false });
    }
  }
  return out;
}

export async function pauseCampaign(db: Db, env: Record<string, string | undefined>, secretKey: string, campaignId: string, uid: string | null) {
  const campaign = await loadCampaign(db, campaignId);
  const results = await forEachLive(db, env, secretKey, campaign, async (provider, ctx, cp) => {
    await provider.pauseCampaign(ctx, cp.externalCampaignId);
    await db.update(campaignPlatforms).set({ status: "paused", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    return { paused: true };
  });
  for (const cp of campaign.platforms || []) {
    if (!cp.externalCampaignId && cp.status === "live") {
      await db.update(campaignPlatforms).set({ status: "paused", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    }
  }
  await db.update(campaigns).set({ status: "paused", updatedAt: now() }).where(eq(campaigns.id, campaignId));
  await activity(db, campaign, "paused", "Paused all platforms", { results }, uid);
  return { status: "paused", results };
}

export async function resumeCampaign(db: Db, env: Record<string, string | undefined>, secretKey: string, campaignId: string, uid: string | null) {
  const campaign = await loadCampaign(db, campaignId);
  const results = await forEachLive(db, env, secretKey, campaign, async (provider, ctx, cp) => {
    await provider.resumeCampaign(ctx, cp.externalCampaignId);
    if (cp.payload?.adSetId && provider.resumeAdSet) await provider.resumeAdSet(ctx, cp.payload.adSetId);
    await db.update(campaignPlatforms).set({ status: "live", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    return { resumed: true };
  });
  const status = await refreshCampaignStatus(db, campaignId);
  await activity(db, campaign, "resumed", "Resumed", { results }, uid);
  return { status, results };
}

/**
 * Pause or resume ONE platform rather than the whole campaign. The campaign's own status is
 * then re-derived, so pausing the last live platform still marks the campaign paused.
 * `platformId` is an ad_platforms id (what the frontend has in hand), not a campaign_platforms id.
 */
async function setPlatformRunning(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaignId: string,
  platformId: string,
  uid: string | null,
  running: boolean,
) {
  const campaign = await loadCampaign(db, campaignId);
  const cp = (campaign.platforms || []).find((x: any) => x.platform_id === platformId || x.id === platformId);
  if (!cp) throw new HttpError(404, "Campaign is not on that platform", "NOT_FOUND");

  let result: Record<string, any> = { skipped: true };
  if (cp.externalCampaignId) {
    const { provider, ctx } = await contextFor(db, env, secretKey, campaign, cp);
    if (running) {
      await provider.resumeCampaign(ctx, cp.externalCampaignId);
      if (cp.payload?.adSetId && provider.resumeAdSet) await provider.resumeAdSet(ctx, cp.payload.adSetId);
    } else {
      await provider.pauseCampaign(ctx, cp.externalCampaignId);
    }
    result = running ? { resumed: true } : { paused: true };
  }
  await db.update(campaignPlatforms).set({ status: running ? "live" : "paused", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
  const status = await refreshCampaignStatus(db, campaignId);
  await activity(db, campaign, running ? "resumed" : "paused", `${running ? "Resumed" : "Paused"} ${cp.platform?.name || "platform"}`, result, uid);
  return { status, platform: cp.platform?.code, ...result };
}

export const pausePlatform = (db: Db, env: Record<string, string | undefined>, secretKey: string, campaignId: string, platformId: string, uid: string | null) =>
  setPlatformRunning(db, env, secretKey, campaignId, platformId, uid, false);
export const resumePlatform = (db: Db, env: Record<string, string | undefined>, secretKey: string, campaignId: string, platformId: string, uid: string | null) =>
  setPlatformRunning(db, env, secretKey, campaignId, platformId, uid, true);

/**
 * The campaign fields worth diffing — the ones a user edits and that reach the platform.
 * Kept in one place so the snapshot and the change detection can never drift apart.
 */
export const PUBLISHED_FIELDS = ["name", "objective", "budgetType", "budgetAmount", "currency", "startDate", "endDate", "landingPageUrl", "trackingFinalUrl", "notes"];

const publishedSnapshot = (campaign: Record<string, any>) =>
  Object.fromEntries(PUBLISHED_FIELDS.map((f) => [f, campaign[f] ?? null]));

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // Numbers arrive as strings from JSON bodies and as numbers from the DB — "777" and 777 are
  // the same budget, and reporting that as a change would make every edit look bigger than it is.
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na === nb;
  // Dates arrive as full timestamps from the DB but as YYYY-MM-DD from the builder.
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v);
  return String(norm(a)) === String(norm(b));
};

/** Exposed so hooks can ask "did this value actually change?" with the same rules. */
export const sameStoredValue = sameValue;

/** Which published fields differ from the last published snapshot. */
export function diffAgainstPublished(campaign: Record<string, any>): string[] {
  const snap = campaign.publishedSnapshot || {};
  const current = publishedSnapshot(campaign);
  return PUBLISHED_FIELDS.filter((f) => !sameValue(snap[f], current[f]));
}

async function markPublished(db: Db, campaignId: string) {
  const c = await loadCampaign(db, campaignId);
  await db
    .update(campaigns)
    .set({ publishedSnapshot: publishedSnapshot(c), hasUnpublishedChanges: false, pendingChanges: {}, updatedAt: now() } as any)
    .where(eq(campaigns.id, campaignId));
}

export async function updateCampaignSettings(db: Db, campaignId: string, body: Record<string, any> = {}, uid: string | null) {
  const campaign = await loadCampaign(db, campaignId);
  const patch: Record<string, any> = {};
  for (const f of PUBLISHED_FIELDS) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (body.draftState !== undefined) patch.draftState = body.draftState;
  if (!Object.keys(patch).length) return campaign;
  await db.update(campaigns).set({ ...patch, hasUnpublishedChanges: true, updatedAt: now() }).where(eq(campaigns.id, campaignId));
  await activity(db, campaign, "edited", "Updated campaign settings", { fields: Object.keys(patch) }, uid);
  return loadCampaign(db, campaignId);
}

/** Google creative readiness checklist for a campaign (non-AI). */
export async function googleCreativeReadiness(db: Db, campaignId: string) {
  const campaign = await loadCampaign(db, campaignId);
  const googleCp = (campaign.platforms || []).find((p: any) => (p.platform?.code || "").startsWith("google"));
  const links = await postsFor(db, campaign, googleCp?.platform_id || "");
  const checks: { key: string; label: string; ok: boolean; detail?: string }[] = [];
  checks.push({ key: "post", label: "At least one creative post", ok: links.length > 0, detail: `${links.length} post(s)` });
  const withImages = links.filter((l) => mediaUrlsOf(l.post).length > 0);
  checks.push({ key: "images", label: "Posts have images", ok: withImages.length > 0, detail: `${withImages.length}/${links.length} with images` });
  const withHeadlines = links.filter((l) => (l.post.headline || l.post.fieldValues?.headlines?.length));
  checks.push({ key: "headlines", label: "Posts have headlines", ok: withHeadlines.length > 0 });
  const withDestination = links.filter((l) => l.post.destinationUrl);
  checks.push({ key: "destination", label: "Posts have a destination URL", ok: withDestination.length > 0 });
  return { ready: checks.every((c) => c.ok), checks };
}

export async function archiveCampaign(db: Db, env: Record<string, string | undefined>, secretKey: string, campaignId: string, uid: string | null) {
  const campaign = await loadCampaign(db, campaignId);
  const results = await forEachLive(db, env, secretKey, campaign, async (provider, ctx, cp) => {
    await provider.pauseCampaign(ctx, cp.externalCampaignId);
    await db.update(campaignPlatforms).set({ status: "completed", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
    return { archived: true };
  });
  await db.update(campaigns).set({ status: "archived", updatedAt: now() }).where(eq(campaigns.id, campaignId));
  await activity(db, campaign, "info", "Archived", { results }, uid);
  return { status: "archived", results };
}

export async function pushUpdates(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaignId: string,
  uid: string | null,
) {
  const campaign = await loadCampaign(db, campaignId);

  // Upfront mark all platforms as publishing in DB
  await Promise.all(
    (campaign.platforms || []).map((cp: any) =>
      db.update(campaignPlatforms).set({ status: "publishing", platformMessage: null, failureCode: null, updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id)).catch(() => {})
    )
  );

  const brandRows = await db.select().from(brandProfiles).where(eq(brandProfiles.workspace_id, campaign.workspace_id)).limit(1);
  const brandRow = (brandRows[0] as unknown as Record<string, any>) || null;
  const brand = brandRow ? { name: brandRow.business?.name, logoUrl: brandRow.branding?.logoUrl } : null;

  // If any platform failed or was never published to the ad network, publish it now:
  const unlaunched = (campaign.platforms || []).filter((cp: any) => (!cp.externalCampaignId || cp.status === "failed") && cp.status !== "archived");
  const launchResults: Record<string, any>[] = [];
  const processedPlatformIds = new Set<string>();
  for (const cp of unlaunched) {
    processedPlatformIds.add(cp.id);
    const lr = await publishPlatform(db, env, secretKey, campaign, cp, uid);
    launchResults.push(lr);
  }

  const isPastEnd = campaign.endDate && isPastEndDate(campaign.endDate);
  const campaignForLive = {
    ...campaign,
    platforms: (campaign.platforms || []).filter((cp: any) => {
      if (processedPlatformIds.has(cp.id)) return false;
      if (cp.status === "live" || cp.status === "paused") return true;
      if (cp.status === "completed" && !isPastEnd && cp.externalCampaignId) return true;
      return false;
    }),
  };

  const results = await forEachLive(db, env, secretKey, campaignForLive, async (provider, ctx, cp) => {
    if (!provider.updateCampaign) {
      return { skipped: true };
    }
    const postsList = await postsFor(db, campaign, cp.platform_id);
    const aud = campaign.draftState?.audience || campaign.audience || {};
    const targeting = {
      ...(cp.payload?.targeting || {}),
      ...(campaign.draftState?.targeting || {}),
      ...(aud.locations?.length ? { locations: aud.locations } : {}),
      ...(aud.languages?.length ? { languages: aud.languages } : {}),
      ...(aud.keywords?.length ? { keywords: aud.keywords } : {}),
      ...(aud.ageMin ? { ageMin: aud.ageMin } : {}),
      ...(aud.ageMax ? { ageMax: aud.ageMax } : {}),
      ...(aud.genders?.length ? { genders: aud.genders } : {}),
    };
    await provider.updateCampaign(ctx, campaign, cp.externalCampaignId, cp.payload?.adSetId, targeting);

    // Creative changes (copy, images, video, landing page) go through a separate hook because
    // most platforms cannot edit a live ad in place — the provider decides how to swap it.
    let creative: Record<string, any> | null = null;
    if (provider.updateCreative) {
      creative = await provider.updateCreative(
        ctx,
        { ...campaign, externalCampaignId: cp.externalCampaignId },
        postsList.map((l) => ({ post: l.post, mediaUrls: mediaUrlsOf(l.post), targeting: { ...(cp.payload?.targeting || {}), ...(l.targeting || {}) } })),
        { brand, type: cp.campaignType, adSetId: cp.payload?.adSetId }
      );
      if (creative?.adIds?.length) {
        await db.update(campaignPlatforms).set({ payload: { ...(cp.payload || {}), adIds: creative.adIds, texts: creative.texts || cp.payload?.texts }, updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
        for (const l of postsList) {
          await db.update(campaignPosts).set({ platformAdId: creative.adIds[0], updatedAt: now() }).where(eq(campaignPosts.id, l.id)).catch(() => {});
        }
      }
    }
    if (cp.status === "completed" && !isPastEnd) {
      await db.update(campaignPlatforms).set({ status: "live", updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
      cp.status = "live";
    }
    return { updated: true, creative };
  });

  const allResults = [...launchResults, ...results];

  // Stop update process and throw if any platform failed!
  const failed = allResults.filter((r) => r.error || r.success === false);
  if (failed.length > 0) {
    const errorMsg = failed.map((f) => `${f.platform || "Platform"}: ${f.error || "Update failed"}`).join(" | ");
    await activity(db, campaign, "rejected", `Update failed — ${errorMsg}`, { results: allResults }, uid);
    throw new HttpError(400, `Campaign update failed: ${errorMsg}`, "BAD_REQUEST");
  }

  if (allResults.some((r) => r.success || r.updated)) await markPublished(db, campaignId);
  await refreshCampaignStatus(db, campaignId);
  await activity(db, campaign, "edited", "Pushed updates to platforms", { results: allResults }, uid);
  return { results: allResults };
}

/** Pull daily insights into campaign_analytics and refresh platform status. */
export async function syncCampaignAnalytics(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaignId: string,
  opts: { days?: number } = {},
) {
  const { days = 30 } = opts;
  const campaign = await loadCampaign(db, campaignId);
  const effectiveDays = campaign.startDate
    ? Math.max(days, Math.ceil((Date.now() - new Date(campaign.startDate).getTime()) / 864e5) + 5)
    : days;
  void effectiveDays;
  const until = new Date().toISOString().slice(0, 10);
  let synced = 0;
  const errors: string[] = [];
  for (const cp of campaign.platforms || []) {
    if (!cp.externalCampaignId) continue;
    try {
      const { provider, ctx } = await contextFor(db, env, secretKey, campaign, cp);
      if (!provider.getCampaignStats) continue;

      // If full lifetime hasn't been backfilled yet, fetch up to 365 days once.
      // Once backfilled, all subsequent syncs are lightning-fast 7-day incremental syncs!
      const hasBackfill = cp.payload?.hasLifetimeBackfill;
      const since = !hasBackfill
        ? new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)
        : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

      const { daily, status, reach, frequency } = await provider.getCampaignStats(ctx, cp.externalCampaignId, { since, until });
      const existing = await db
        .select({ id: campaignAnalytics.id, date: campaignAnalytics.date })
        .from(campaignAnalytics)
        .where(and(eq(campaignAnalytics.campaign_id, campaign.id), eq(campaignAnalytics.platform_id, cp.platform_id), isNull(campaignAnalytics.hour)))
        .limit(2000);
      const exMap = new Map((existing as any[]).map((x) => [String(x.date).slice(0, 10), x.id]));
      let spend = 0;
      const toCreate: Record<string, any>[] = [];
      const toUpdate: { id: string; row: Record<string, any> }[] = [];
      for (const d of daily || []) {
        spend += d.spend;
        const row = {
          campaign_id: campaign.id,
          platform_id: cp.platform_id,
          workspace_id: campaign.workspace_id,
          account_id: campaign.account_id,
          date: new Date(d.date),
          hour: null,
          impressions: d.impressions,
          clicks: d.clicks,
          conversions: d.conversions,
          spend: d.spend,
          revenue: d.revenue,
          ctr: d.impressions ? (d.clicks / d.impressions) * 100 : null,
          cpc: d.clicks ? d.spend / d.clicks : null,
          cpa: d.conversions ? d.spend / d.conversions : null,
          roas: d.spend ? d.revenue / d.spend : null,
          frequency: d.frequency || null,
          metrics: { reach: d.reach, videoViews: d.videoViews, engagements: d.engagements },
        };
        const exId = exMap.get(d.date);
        if (exId) toUpdate.push({ id: exId, row });
        else toCreate.push(row);
      }

      if (toCreate.length > 0) {
        await db.insert(campaignAnalytics).values(toCreate as any);
        synced += toCreate.length;
      }

      const CHUNK = 25;
      for (let i = 0; i < toUpdate.length; i += CHUNK) {
        await Promise.all(
          toUpdate.slice(i, i + CHUNK).map(({ id, row }) =>
            db.update(campaignAnalytics).set({ ...row, updatedAt: now() } as any).where(eq(campaignAnalytics.id, id))
          )
        );
        synced += Math.min(CHUNK, toUpdate.length - i);
      }

      // Compute true lifetime spend from all stored rows so a short sync window never drops earlier spend
      const spendRows = await db
        .select({ spend: campaignAnalytics.spend })
        .from(campaignAnalytics)
        .where(and(eq(campaignAnalytics.campaign_id, campaign.id), eq(campaignAnalytics.platform_id, cp.platform_id), isNull(campaignAnalytics.hour)))
        .limit(5000);
      const lifetimeSpend = (spendRows as any[]).reduce((acc, r) => acc + Number(r.spend || 0), 0);

      // Spend must never go backwards: take the max of (DB row sum, current window spend, previously stored platform spend)
      const existingPlatformSpend = Number(cp.spend || 0);
      const bestSpend = Math.max(lifetimeSpend, spend, existingPlatformSpend);
      const patch: Record<string, any> = { lastSyncedAt: now(), spend: Number(bestSpend.toFixed(2)), updatedAt: now() };

      // Reach/frequency describe the whole range rather than any one day, so they belong on the
      // platform row. Google omits them for campaign types that have no unique-user data.
      if (reach !== undefined || frequency !== undefined || !hasBackfill) {
        patch.payload = {
          ...(cp.payload || {}),
          hasLifetimeBackfill: true,
          ...(reach !== undefined && reach > 0 ? { reach } : {}),
          ...(frequency !== undefined && frequency > 0 ? { frequency } : {}),
        };
      }
      if (status?.status && !["publishing"].includes(status.status) && cp.status !== "paused") {
        const isPastEnd = campaign.endDate && isPastEndDate(campaign.endDate);
        patch.status = isPastEnd && status.status === "live" ? "completed" : status.status;
        if (status.reason) patch.platformMessage = status.reason;
      }
      await db.update(campaignPlatforms).set(patch).where(eq(campaignPlatforms.id, cp.id));
    } catch (e: any) {
      errors.push(`${cp.platform?.code}: ${e.message}`);
    }
  }
  await refreshCampaignStatus(db, campaignId);
  await activity(db, campaign, "synced", `Analytics synced (${synced} rows)`, { errors }, null);
  return { synced, errors: errors.length, errorDetails: errors };
}

/** Sync analytics for every campaign in a workspace. Exposed for the Phase 7 cron. */
export async function syncAllCampaignAnalytics(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  workspaceId: string,
) {
  const rows = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.workspace_id, workspaceId)).limit(1000);
  const results: Record<string, any>[] = [];
  for (const r of rows as any[]) {
    try {
      const res = await syncCampaignAnalytics(db, env, secretKey, r.id);
      results.push({ campaignId: r.id, ...res });
    } catch (e: any) {
      results.push({ campaignId: r.id, error: e.message });
    }
  }
  return results;
}

/** Sync analytics for one platform of a campaign. Exposed for the Phase 7 cron. */
export async function syncPlatformAnalytics(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  campaignId: string,
  platformCode: string,
) {
  const campaign = await loadCampaign(db, campaignId);
  const cp = (campaign.platforms || []).find((p: any) => p.platform?.code === platformCode);
  if (!cp) throw new HttpError(404, `Campaign is not on ${platformCode}`, "NOT_FOUND");
  if (!cp.externalCampaignId) throw new HttpError(400, "Campaign has not been published to this platform yet", "BAD_REQUEST");
  const { provider, ctx } = await contextFor(db, env, secretKey, campaign, cp);
  if (!provider.getCampaignStats) throw new HttpError(400, `${platformCode} does not support analytics sync`, "BAD_REQUEST");
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const stats = await provider.getCampaignStats(ctx, cp.externalCampaignId, { since, until });
  await db.update(campaignPlatforms).set({ lastSyncedAt: now(), updatedAt: now() }).where(eq(campaignPlatforms.id, cp.id));
  return stats;
}
