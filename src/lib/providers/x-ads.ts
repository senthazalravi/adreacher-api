// X (Twitter) Ads campaign provider. Port of reach_be XAdsCampaignProvider (Ads API v12).
// Pure fetch — Cloudflare Workers safe, no Node APIs.
// ctx = { accessToken, tokenSecret, adAccountId, cfg, connection }
// Consumer key/secret come from ctx.cfg.clientId / ctx.cfg.clientSecret (no process.env fallbacks).
import { generateOAuth1Header, makeOAuth1Request, type OAuth1Config } from "../oauth1.js";

export type XCtx = Record<string, any>;
type Params = Record<string, any>;

interface XOAuth extends OAuth1Config {
  oauthVersion: number;
}

const X_ADS_BASE = "https://ads-api.x.com/12";
const X_API_BASE = "https://api.x.com/2";

function getOAuthConfig(ctx: XCtx): XOAuth {
  const consumerKey = ctx.cfg?.clientId || ctx.consumerKey || "";
  const consumerSecret = ctx.cfg?.clientSecret || ctx.consumerSecret || "";
  const accessToken = ctx.accessToken || ctx.connection?.accessToken || "";
  const accessTokenSecret = ctx.tokenSecret || ctx.connection?.refreshToken || ctx.connection?.meta?.accessTokenSecret || "";
  const oauthVersion = ctx.connection?.meta?.oauthVersion || (accessTokenSecret ? 1 : 2);

  return {
    consumerKey,
    consumerSecret,
    accessToken,
    accessTokenSecret,
    oauthVersion,
  };
}

const stringifyParams = (p: Params): Record<string, string> =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === undefined || v === null ? "" : String(v)]));

async function requestX(method: string, url: string, oauth: XOAuth, params: Params = {}): Promise<any> {
  const isOAuth2 = oauth.accessToken && (!oauth.accessTokenSecret || oauth.oauthVersion === 2);
  if (isOAuth2) {
    const isGet = method === "GET";
    const qs = isGet && Object.keys(params).length ? `?${new URLSearchParams(stringifyParams(params)).toString()}` : "";
    const fetchUrl = `${url}${qs}`;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        ...(isGet ? {} : { "Content-Type": "application/json" }),
      },
      ...(isGet ? {} : { body: JSON.stringify(params) }),
    };
    const res = await fetch(fetchUrl, opts);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.errors?.[0]?.message || data?.detail || data?.title || `HTTP ${res.status}`);
    }
    return data;
  }
  return makeOAuth1Request(method, url, oauth, stringifyParams(params));
}

function resolveAdAccountId(ctx: XCtx): string {
  const id = ctx.adAccountId || ctx.connection?.meta?.selectedAdAccountId || ctx.connection?.externalAccountId || "";
  if (!id) throw new Error("No X Ads account ID configured for this connection");
  return String(id).trim();
}

/**
 * Map internal objective / X type to X Ads API v12 line item objective:
 * WEBSITE_CLICKS, ENGAGEMENTS, APP_INSTALLS, REACH, VIDEO_VIEWS, FOLLOWERS, PREROLL_VIEWS
 */
export function mapObjective(objective: string, xCampaignType?: string): string {
  const candidate = (xCampaignType || objective || "").toLowerCase().trim();
  const mapping: Record<string, string> = {
    // Internal Reach goals
    sales: "WEBSITE_CLICKS",
    leads: "WEBSITE_CLICKS",
    traffic: "WEBSITE_CLICKS",
    engagement: "ENGAGEMENTS",
    app_promotion: "APP_INSTALLS",
    awareness: "REACH",
    local: "WEBSITE_CLICKS",
    // X Campaign Types
    website_traffic: "WEBSITE_CLICKS",
    website_clicks: "WEBSITE_CLICKS",
    engagements: "ENGAGEMENTS",
    reach: "REACH",
    video_views: "VIDEO_VIEWS",
    app_installs: "APP_INSTALLS",
    followers: "FOLLOWERS",
  };
  if (mapping[candidate]) return mapping[candidate];

  const upper = candidate.toUpperCase();
  const allowed = new Set([
    "WEBSITE_CLICKS",
    "ENGAGEMENTS",
    "APP_INSTALLS",
    "REACH",
    "VIDEO_VIEWS",
    "FOLLOWERS",
    "PREROLL_VIEWS",
  ]);
  if (allowed.has(upper)) return upper;
  return "WEBSITE_CLICKS";
}

/**
 * Fetch the first active funding instrument for the account.
 */
async function getFundingInstrument(oauth: XOAuth, accountId: string): Promise<string> {
  const url = `${X_ADS_BASE}/accounts/${accountId}/funding_instruments`;
  const data = await requestX("GET", url, oauth, {});
  const instruments = data?.data || [];
  const active = instruments.find((fi: any) => fi.entity_status === "ACTIVE" && !fi.deleted);
  if (!active) {
    throw new Error(
      "No active funding instrument (payment method) found on X Ads account. Please add a payment method in X Ads Manager.",
    );
  }
  return active.id;
}

/**
 * Apply targeting criteria to an X Ads line item.
 */
async function applyTargetingCriteria(oauth: XOAuth, accountId: string, lineItemId: string, targeting: Params = {}): Promise<void> {
  const url = `${X_ADS_BASE}/accounts/${accountId}/targeting_criteria`;
  const postCriterion = async (targetingType: string, targetingValue: unknown): Promise<void> => {
    try {
      await requestX("POST", url, oauth, {
        line_item_id: lineItemId,
        targeting_type: targetingType,
        targeting_value: String(targetingValue),
      });
    } catch (e: any) {
      console.warn(`X Ads targeting warning (${targetingType}: ${targetingValue}):`, e.message);
    }
  };

  // Locations
  const locations = targeting.locations || [];
  for (const loc of locations) {
    const val = typeof loc === "object" ? loc.id || loc.value || loc.name : loc;
    if (val) await postCriterion("LOCATION", val);
  }

  // Age range
  if (targeting.ageMin || targeting.ageMax) {
    const ageMin = targeting.ageMin || 18;
    const ageMax = targeting.ageMax || 54;
    await postCriterion("AGE", `AGE_${ageMin}_TO_${ageMax}`);
  }

  // Genders
  if (Array.isArray(targeting.genders)) {
    for (const g of targeting.genders) {
      const lower = String(g).toLowerCase();
      if (lower === "male" || lower === "1") await postCriterion("GENDER", "1");
      else if (lower === "female" || lower === "2") await postCriterion("GENDER", "2");
    }
  }

  // Keywords
  if (Array.isArray(targeting.keywords)) {
    for (const kw of targeting.keywords) {
      const val = typeof kw === "object" ? kw.name || kw.id : kw;
      if (val) await postCriterion("BROAD_KEYWORD", val);
    }
  }

  // Languages
  if (Array.isArray(targeting.languages)) {
    for (const lang of targeting.languages) {
      const val = typeof lang === "object" ? lang.code || lang.id : lang;
      if (val) await postCriterion("LANGUAGE", val);
    }
  }

  // Interests
  if (Array.isArray(targeting.interests)) {
    for (const int of targeting.interests) {
      const val = typeof int === "object" ? int.id || int.name : int;
      if (val) await postCriterion("INTEREST", val);
    }
  }

  // Devices / Platforms
  if (Array.isArray(targeting.devices)) {
    for (const dev of targeting.devices) {
      const val = typeof dev === "object" ? dev.id || dev.name : dev;
      if (val) await postCriterion("PLATFORM", val);
    }
  }
}

export const x = {
  code: "x",

  createCampaign: async (ctx: XCtx, campaign: Params) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);

    const fundingInstrumentId = await getFundingInstrument(oauth, accountId);

    const budgetMicros = campaign.budgetAmount ? Math.round(Number(campaign.budgetAmount) * 1_000_000) : 5_000_000;
    const isLifetime = campaign.budgetType === "lifetime";
    const dailyMicro = isLifetime ? Math.max(Math.round(budgetMicros / 30), 1_000_000) : budgetMicros;

    const params: Params = {
      name: campaign.name || "X Ads Campaign",
      funding_instrument_id: fundingInstrumentId,
      entity_status: "ACTIVE",
      daily_budget_amount_local_micro: dailyMicro.toString(),
    };

    if (isLifetime) {
      params.total_budget_amount_local_micro = budgetMicros.toString();
    }
    if (campaign.startDate) {
      params.start_time = new Date(campaign.startDate).toISOString();
    }
    if (campaign.endDate) {
      params.end_time = new Date(campaign.endDate).toISOString();
    }

    const url = `${X_ADS_BASE}/accounts/${accountId}/campaigns`;
    const data = await requestX("POST", url, oauth, params);
    const platformCampaignId = data?.data?.id;
    if (!platformCampaignId) throw new Error("X Ads API did not return a campaign ID");

    return { platformCampaignId, fundingInstrumentId };
  },

  createAdSet: async (ctx: XCtx, campaign: Params, adSet: Params, platformCampaignId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);

    const targeting = adSet.targeting || {};
    const xCampaignType = targeting.xCampaignType || targeting.campaignType;
    const objective = mapObjective(campaign.objective, xCampaignType);

    const bidAmount = adSet.bidAmount ? Math.round(Number(adSet.bidAmount) * 1_000_000) : null;
    const bidStrategy = String(adSet.bidStrategy || "").toUpperCase();
    const useAutoBid = !bidAmount || bidStrategy === "AUTO" || bidStrategy === "AUTOMATIC";

    const placementsRaw = targeting.placements;
    const placements = Array.isArray(placementsRaw) && placementsRaw.length > 0 ? placementsRaw.join(",") : "ALL_ON_TWITTER";

    const params: Params = {
      campaign_id: platformCampaignId,
      name: adSet.name || `${campaign.name} — Ad Set`,
      objective,
      product_type: "PROMOTED_TWEETS",
      placements,
      entity_status: "ACTIVE",
    };

    if (useAutoBid) {
      params.bid_type = "AUTO";
    } else if (bidAmount) {
      params.bid_type = "MAX";
      params.bid_amount_local_micro = bidAmount.toString();
    }

    if (!placements.includes(",")) {
      params.placement_type = placements;
    }

    const url = `${X_ADS_BASE}/accounts/${accountId}/line_items`;
    const data = await requestX("POST", url, oauth, params);
    const platformAdSetId = data?.data?.id;
    if (!platformAdSetId) throw new Error("X Ads API did not return a line item ID");

    // Apply targeting criteria
    await applyTargetingCriteria(oauth, accountId, platformAdSetId, targeting);

    return { platformAdSetId };
  },

  createAdFromPost: async (ctx: XCtx, campaign: Params, post: Params, mediaUrls: string[] = [], targeting: Params = {}, platformAdSetId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);

    // 1. Create a tweet on organic API v2 (nullcast = promoted-only, not on public profile feed)
    const tweetText = post.content || post.headline || post.title || campaign.name || "Ad";
    const tweetPayload: Params = {
      text: tweetText,
      nullcast: true,
    };

    // If media asset IDs or URLs are numeric IDs
    const fv = post.fieldValues || {};
    const candidateMedia = fv.mediaIds || post.mediaAssetIds || [];
    if (Array.isArray(candidateMedia) && candidateMedia.length && candidateMedia.every((id: unknown) => /^\d+$/.test(String(id)))) {
      tweetPayload.media = { media_ids: candidateMedia.map(String) };
    }

    const tweetUrl = `${X_API_BASE}/tweets`;
    const isOAuth2 = oauth.accessToken && (!oauth.accessTokenSecret || oauth.oauthVersion === 2);
    let tweetRes: Response;
    if (isOAuth2) {
      tweetRes = await fetch(tweetUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tweetPayload),
        signal: AbortSignal.timeout(30000),
      });
    } else {
      const tweetHeader = await generateOAuth1Header("POST", tweetUrl, oauth);
      tweetRes = await fetch(tweetUrl, {
        method: "POST",
        headers: {
          Authorization: tweetHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tweetPayload),
        signal: AbortSignal.timeout(30000),
      });
    }

    const tweetData: any = await tweetRes.json().catch(() => ({}));
    if (!tweetRes.ok) {
      const msg = tweetData?.detail || tweetData?.title || tweetData?.errors?.[0]?.message || `HTTP ${tweetRes.status}`;
      throw new Error(`Failed to create tweet for X Ad: ${msg}`);
    }

    const tweetId = tweetData?.data?.id;
    if (!tweetId) throw new Error("X API did not return a tweet ID");

    // 2. Promote tweet on X Ads API
    const promoUrl = `${X_ADS_BASE}/accounts/${accountId}/promoted_tweets`;
    const promoParams = {
      line_item_id: platformAdSetId,
      tweet_ids: tweetId,
    };
    const promoData = await requestX("POST", promoUrl, oauth, promoParams);
    const platformAdId = promoData?.data?.[0]?.id || promoData?.data?.id;
    if (!platformAdId) throw new Error("X Ads API did not return a promoted tweet ID");

    return { platformAdId, platformPostId: tweetId };
  },

  pauseCampaign: async (ctx: XCtx, platformCampaignId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);
    const url = `${X_ADS_BASE}/accounts/${accountId}/campaigns/${platformCampaignId}`;
    await requestX("PUT", url, oauth, { entity_status: "PAUSED" });
  },

  resumeCampaign: async (ctx: XCtx, platformCampaignId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);
    const url = `${X_ADS_BASE}/accounts/${accountId}/campaigns/${platformCampaignId}`;
    await requestX("PUT", url, oauth, { entity_status: "ACTIVE" });
  },

  removeCampaign: async (ctx: XCtx, platformCampaignId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);
    const url = `${X_ADS_BASE}/accounts/${accountId}/campaigns/${platformCampaignId}`;
    await requestX("DELETE", url, oauth, {});
  },

  pauseAdSet: async (ctx: XCtx, platformAdSetId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);
    const url = `${X_ADS_BASE}/accounts/${accountId}/line_items/${platformAdSetId}`;
    await requestX("PUT", url, oauth, { entity_status: "PAUSED" });
  },

  resumeAdSet: async (ctx: XCtx, platformAdSetId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);
    const url = `${X_ADS_BASE}/accounts/${accountId}/line_items/${platformAdSetId}`;
    await requestX("PUT", url, oauth, { entity_status: "ACTIVE" });
  },

  getCampaignStats: async (ctx: XCtx, platformCampaignId: string) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);
    try {
      const url = `${X_ADS_BASE}/stats/accounts/${accountId}`;
      const params = {
        entity: "CAMPAIGN",
        entity_ids: platformCampaignId,
        metric_groups: "ENGAGEMENT,BILLING",
        granularity: "TOTAL",
        start_time: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date().toISOString(),
      };
      const data = await requestX("GET", url, oauth, params);
      const metrics = data?.data?.[0]?.id_data?.[0]?.metrics || {};
      return {
        impressions: metrics.impressions?.[0] || 0,
        clicks: metrics.clicks?.[0] || 0,
        spend: metrics.billed_charge_local_micro?.[0] ? metrics.billed_charge_local_micro[0] / 1_000_000 : 0,
      };
    } catch (e: any) {
      console.warn("Failed to get X Ads stats:", e.message);
      return {};
    }
  },

  fetchExistingCampaigns: async (ctx: XCtx) => {
    const accountId = resolveAdAccountId(ctx);
    const oauth = getOAuthConfig(ctx);
    const url = `${X_ADS_BASE}/accounts/${accountId}/campaigns`;
    const data = await requestX("GET", url, oauth, {});
    const campaigns = data?.data || [];
    const statusMap: Record<string, string> = {
      ACTIVE: "ENABLED",
      PAUSED: "PAUSED",
      DRAFT: "PAUSED",
      DELETED: "REMOVED",
    };
    return campaigns
      .map((c: any) => {
        const budgetAmountMicros = c.daily_budget_amount_local_micro
          ? parseInt(c.daily_budget_amount_local_micro, 10)
          : c.total_budget_amount_local_micro
            ? parseInt(c.total_budget_amount_local_micro, 10)
            : undefined;
        return {
          platformCampaignId: c.id,
          name: c.name || "Untitled",
          status: statusMap[c.entity_status] || c.entity_status,
          budgetAmountMicros,
          startDate: c.start_time,
          endDate: c.end_time,
        };
      })
      .filter((c: any) => c.platformCampaignId && c.status !== "REMOVED");
  },
};

export default x;
