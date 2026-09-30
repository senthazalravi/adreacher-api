// Meta Marketing API campaign provider. Port of reach_be MetaAdsCampaignProvider (v22.0 Graph).
// Pure fetch — Cloudflare Workers safe, no Node APIs.
// ctx = { accessToken, adAccountId: "act_…", pageId, pageName, currency }

export const GRAPH = "https://graph.facebook.com/v22.0";
const INSIGHT_FIELDS =
  "impressions,clicks,spend,reach,frequency,actions,action_values,ctr,cpc,cpm,cost_per_action_type,video_play_actions,post_engagement";

export type MetaCtx = Record<string, any>;
type Params = Record<string, any>;

export async function request(
  method: string,
  url: string,
  accessToken: string,
  params?: Params,
): Promise<any> {
  const u = new URL(url);
  u.searchParams.set("access_token", accessToken);
  let body: string | undefined;
  if (method === "GET") {
    for (const [k, v] of Object.entries(params || {}))
      u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  } else if (params) {
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) f.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    body = f.toString();
  }
  const r = await fetch(u.toString(), {
    method,
    headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(45000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = data.error || {};
    const msg = [
      e.error_user_msg || e.message || `HTTP ${r.status}`,
      e.error_user_title && e.error_user_title !== e.error_user_msg ? e.error_user_title : null,
      e.error_subcode ? `subcode ${e.error_subcode}` : null,
      Array.isArray(e.blame_field_specs) && e.blame_field_specs.length
        ? `fields: ${e.blame_field_specs.join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" — ");
    const err: any = new Error(`Meta Ads API error: ${msg}`);
    err.code = e.code;
    err.subcode = e.error_subcode;
    throw err;
  }
  return data;
}

const act = (id: unknown): string =>
  String(id).startsWith("act_") ? String(id) : `act_${id}`;
const metaTime = (d: unknown): string => new Date(d as any).toISOString().replace(/\.\d{3}Z$/, "+0000");

/* objective / goal mapping (Reach goals → Meta) */
const OBJECTIVE: Record<string, string> = {
  online_sales: "OUTCOME_SALES",
  leads: "OUTCOME_LEADS",
  website_visitors: "OUTCOME_TRAFFIC",
  local_visits: "OUTCOME_TRAFFIC",
  messages: "OUTCOME_ENGAGEMENT",
  awareness: "OUTCOME_AWARENESS",
};
const GOAL: Record<string, string> = {
  online_sales: "get_more_sales",
  leads: "get_more_leads",
  website_visitors: "get_more_website_visitors",
  local_visits: "get_more_website_visitors",
  messages: "get_more_messages",
  awareness: "get_more_brand_awareness",
};
export const mapObjective = (o: string): string => OBJECTIVE[o] || "OUTCOME_TRAFFIC";

function optimizationGoal(objective: string, metaGoal: string, hasPixel: boolean): string {
  if (metaGoal === "get_more_messages") return "CONVERSATIONS";
  if (hasPixel && (metaGoal === "get_more_leads" || metaGoal === "get_more_sales")) return "OFFSITE_CONVERSIONS";
  if (metaGoal === "get_more_brand_awareness") return "REACH";
  if (metaGoal) return "LINK_CLICKS";
  return (
    {
      online_sales: "LINK_CLICKS",
      leads: "LINK_CLICKS",
      website_visitors: "LINK_CLICKS",
      local_visits: "LINK_CLICKS",
      messages: "CONVERSATIONS",
      awareness: "REACH",
    }[objective] || "LINK_CLICKS"
  );
}
const customEvent = (metaGoal: string, objective: string): string =>
  metaGoal === "get_more_sales" || objective === "online_sales"
    ? "PURCHASE"
    : metaGoal === "get_more_leads" || objective === "leads"
      ? "LEAD"
      : "CONTENT_VIEW";
const destinationType = (metaGoal: string, objective: string): string | undefined =>
  metaGoal === "get_more_messages" || objective === "messages"
    ? "MESSENGER"
    : ["get_more_sales", "get_more_leads"].includes(metaGoal) || ["online_sales", "leads"].includes(objective)
      ? "WEBSITE"
      : undefined;

function normalizeBid(raw: unknown): string {
  const v = (raw || "LOWEST_COST_WITHOUT_CAP").toString().toUpperCase();
  if (v === "LOWEST_COST_WITHOUT_BID_CAP" || v === "LOWEST_COST") return "LOWEST_COST_WITHOUT_CAP";
  return ["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"].includes(v)
    ? v
    : "LOWEST_COST_WITHOUT_CAP";
}

const CTA: Record<string, string> = {
  learn_more: "LEARN_MORE",
  shop_now: "SHOP_NOW",
  sign_up: "SIGN_UP",
  download: "DOWNLOAD",
  book_now: "BOOK_TRAVEL",
  contact_us: "CONTACT_US",
  get_offer: "GET_OFFER",
  apply_now: "APPLY_NOW",
  subscribe: "SUBSCRIBE",
  watch_more: "WATCH_MORE",
};

/**
 * Meta targets languages by its own numeric locale id, not by ISO code. The builder's
 * audience stores ISO codes (Google's provider maps those itself), so without this table
 * `Number("en")` is NaN, every language is filtered out, and the ad set silently targets
 * ALL languages instead of the ones the user picked. Covers the codes the audience picker
 * offers; anything else falls through and is dropped as before.
 */
const META_LOCALES: Record<string, number> = {
  en: 6,
  sv: 22,
  es: 23,
  fr: 8,
  de: 5,
  pt: 19,
  it: 12,
  nl: 15,
  ja: 13,
  zh: 32,
  ko: 14,
};

function buildTargeting(t: Params = {}, fallbackCountry?: string): Params {
  const spec: Params = {};
  if (t.geoLocations) spec.geo_locations = t.geoLocations;
  else if (t.locations?.length)
    spec.geo_locations = { countries: t.locations.map((c: unknown) => String(c).toUpperCase().slice(0, 2)) };
  else if (fallbackCountry) spec.geo_locations = { countries: [String(fallbackCountry).toUpperCase().slice(0, 2)] };
  else throw new Error("At least one audience location is required for Meta ad sets");
  spec.age_min = t.ageMin || 18;
  spec.age_max = t.ageMax || 65;
  if (t.genders?.length) {
    const g = t.genders
      .map((x: unknown) =>
        String(x).toLowerCase() === "male" ? 1 : String(x).toLowerCase() === "female" ? 2 : undefined,
      )
      .filter(Boolean);
    if (g.length) spec.genders = g;
  }
  const interests = (t.interests || [])
    .map((i: unknown) => (typeof i === "object" && (i as any)?.id ? { id: String((i as any).id), name: (i as any).name || String((i as any).id) } : null))
    .filter(Boolean);
  if (interests.length) spec.flexible_spec = [{ interests }];
  if (t.languages?.length) {
    const l = t.languages
      .map((x: unknown) =>
        Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : META_LOCALES[String(x).toLowerCase().slice(0, 2)],
      )
      .filter((n: unknown) => Number.isFinite(n) && (n as number) > 0);
    if (l.length) spec.locales = [...new Set(l)];
  }
  if (t.devices?.length) spec.user_device = t.devices;
  spec.publisher_platforms = t.placements?.length ? t.placements : ["facebook", "instagram"];
  spec.facebook_positions = t.facebookPositions || ["feed", "story", "facebook_reels"];
  spec.instagram_positions = t.instagramPositions || ["stream", "story", "reels"];
  if (t.advantagePlus !== false) spec.targeting_automation = { advantage_audience: 1 };
  return spec;
}

async function dsaFields(ctx: MetaCtx): Promise<Params> {
  const fallback = (ctx.pageName || "Advertiser").trim().slice(0, 512) || "Advertiser";
  try {
    const a = await request("GET", `${GRAPH}/${ctx.adAccountId}`, ctx.accessToken, {
      fields: "name,business{name},default_dsa_beneficiary,default_dsa_payor",
    });
    const ben = a?.default_dsa_beneficiary || a?.business?.name || a?.name || fallback;
    const pay = a?.default_dsa_payor || ben;
    if (a?.default_dsa_beneficiary || a?.default_dsa_payor)
      return { dsa_beneficiary: String(ben).slice(0, 512), dsa_payor: String(pay).slice(0, 512) };
    try {
      const rec = await request("GET", `${GRAPH}/${ctx.adAccountId}/dsa_recommendations`, ctx.accessToken);
      const s = rec?.data?.[0]?.recommendations?.[0] || rec?.recommendations?.[0];
      if (s) return { dsa_beneficiary: String(s).slice(0, 512), dsa_payor: String(s).slice(0, 512) };
    } catch {}
    return { dsa_beneficiary: String(ben).slice(0, 512), dsa_payor: String(pay).slice(0, 512) };
  } catch {
    return { dsa_beneficiary: fallback, dsa_payor: fallback };
  }
}

const imageHashOf = (d: any): string | undefined => {
  const imgs = d?.images;
  return imgs ? imgs[Object.keys(imgs)[0] as string]?.hash : d?.hash;
};

/** Pure-Workers base64 encode of raw bytes (replaces Buffer.from(...).toString("base64")). */
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

async function uploadImage(ctx: MetaCtx, imageUrl: string): Promise<string | undefined> {
  // `url` only works when Meta's crawler can fetch it; our asset URLs may be local (dev) or
  // auth-gated, so send the bytes ourselves and keep `url` as the fallback for public images.
  try {
    const r = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
    if (r.ok) {
      const bytes = bytesToBase64(new Uint8Array(await r.arrayBuffer()));
      const h = imageHashOf(await request("POST", `${GRAPH}/${ctx.adAccountId}/adimages`, ctx.accessToken, { bytes }));
      if (h) return h;
    }
  } catch {}
  try {
    return imageHashOf(await request("POST", `${GRAPH}/${ctx.adAccountId}/adimages`, ctx.accessToken, { url: imageUrl }));
  } catch {
    return undefined;
  }
}

/**
 * A video creative must carry a thumbnail (`image_hash` or `image_url`) or Meta rejects it with
 * "Your ad needs a video thumbnail" (subcode 1443226) — v1 never set one, so every video ad failed.
 * Prefer an image the post already has; otherwise wait for the thumbnail Meta renders itself.
 */
async function videoThumbnail(ctx: MetaCtx, videoId: string, mediaUrls: string[] = []): Promise<Params> {
  const still = mediaUrls.find((u) => u && !/\.(mp4|mov|webm)(\?|$)/i.test(u));
  if (still) {
    const hash = await uploadImage(ctx, still);
    if (hash) return { image_hash: hash };
    return { image_url: still };
  }
  for (let i = 0; i < 10; i++) {
    try {
      const d = await request("GET", `${GRAPH}/${videoId}/thumbnails`, ctx.accessToken, { fields: "uri,is_preferred" });
      const t = (d?.data || []).find((x: any) => x.is_preferred) || d?.data?.[0];
      if (t?.uri) return { image_url: t.uri };
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  return {};
}

async function uploadVideo(ctx: MetaCtx, videoUrl: string): Promise<string | undefined> {
  try {
    const d = await request("POST", `${GRAPH}/${ctx.adAccountId}/advideos`, ctx.accessToken, { file_url: videoUrl });
    return d?.id;
  } catch {
    return undefined;
  }
}

async function createCreative(
  ctx: MetaCtx,
  {
    title,
    body,
    description,
    linkUrl,
    mediaUrls = [],
    callToAction,
    metaGoal,
    mediaType = "image",
  }: {
    title?: string;
    body?: string;
    description?: string;
    linkUrl?: string;
    mediaUrls?: string[];
    callToAction?: string;
    metaGoal?: string;
    mediaType?: string;
  },
): Promise<string> {
  if (!ctx.pageId) throw new Error("A Facebook Page is required to create Meta ad creatives — pick one in Connections");
  const isMessaging = metaGoal === "get_more_messages";
  const story: Params = { page_id: ctx.pageId };
  const first = mediaUrls.find(Boolean);
  if (mediaType === "video" && first) {
    const videoId = await uploadVideo(ctx, first);
    if (videoId) {
      const vd: Params = {
        message: body || title,
        title,
        video_id: videoId,
        ...(await videoThumbnail(ctx, videoId, mediaUrls)),
      };
      if (isMessaging) vd.call_to_action = { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } };
      else if (linkUrl) vd.call_to_action = { type: CTA[String(callToAction || "").toLowerCase()] || "LEARN_MORE", value: { link: linkUrl } };
      story.video_data = vd;
    }
  }
  if (!story.video_data) {
    const ld: Params = { message: body || title };
    if (title?.trim()) ld.name = title.trim();
    if (description?.trim()) ld.description = description.trim();
    if (isMessaging) {
      ld.link = `https://www.facebook.com/${ctx.pageId}`;
      ld.call_to_action = { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } };
    } else {
      const link = linkUrl || `https://www.facebook.com/${ctx.pageId}`;
      ld.link = link;
      ld.call_to_action = { type: CTA[String(callToAction || "").toLowerCase()] || "LEARN_MORE", value: { link } };
    }
    if (first?.startsWith("http")) {
      const hash = await uploadImage(ctx, first);
      if (hash) ld.image_hash = hash;
      else ld.picture = first;
    } else if (first && first.length === 32) ld.image_hash = first;
    else if (first) ld.picture = first;
    story.link_data = ld;
  }
  const d = await request("POST", `${GRAPH}/${ctx.adAccountId}/adcreatives`, ctx.accessToken, {
    name: `Creative: ${title}`.slice(0, 100),
    object_story_spec: story,
  });
  if (!d?.id) throw new Error("Meta Ads API did not return a creative ID");
  return d.id;
}

/* insights */
const isConv = (t: unknown): boolean => {
  const n = String(t || "").toLowerCase();
  return (
    n.includes("purchase") ||
    n.includes("lead") ||
    n === "complete_registration" ||
    n.includes("conversion") ||
    n === "subscribe" ||
    n === "contact"
  );
};

function parseRow(row: any): Params {
  const conversions = (row.actions || [])
    .filter((a: any) => isConv(a.action_type))
    .reduce((s: number, a: any) => s + parseInt(a.value || "0", 10), 0);
  const conversionValue = (row.action_values || [])
    .filter((a: any) => isConv(a.action_type))
    .reduce((s: number, a: any) => s + parseFloat(a.value || "0"), 0);
  return {
    date: String(row.date_start || row.date_stop || "").slice(0, 10),
    impressions: parseInt(row.impressions || "0", 10),
    clicks: parseInt(row.clicks || "0", 10),
    spend: parseFloat(row.spend || "0"),
    conversions,
    revenue: Number(conversionValue.toFixed(2)),
    reach: parseInt(row.reach || "0", 10),
    frequency: parseFloat(row.frequency || "0"),
    videoViews: (row.video_play_actions || []).reduce((s: number, a: any) => s + parseInt(a.value || "0", 10), 0),
    engagements: parseInt(row.post_engagement || "0", 10),
  };
}

async function insights(ctx: MetaCtx, objectId: string, params: Params): Promise<any[]> {
  let page = await request("GET", `${GRAPH}/${objectId}/insights`, ctx.accessToken, {
    ...params,
    time_range: JSON.stringify(params.time_range),
  });
  let rows = page?.data || [];
  let next = page?.paging?.next;
  while (next) {
    const r = await fetch(next);
    const p: any = await r.json();
    if (!r.ok || p.error) throw new Error(`Meta Ads API error: ${p.error?.message || r.status}`);
    rows = rows.concat(p.data || []);
    next = p.paging?.next;
  }
  return rows;
}

function liveStatus(status: unknown, effective: unknown, stopTime: unknown): Params {
  const eff = String(effective || status || "").toUpperCase();
  const ended = stopTime && new Date(stopTime as any).getTime() < Date.now();
  if (ended && ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].includes(eff))
    return { status: "completed", reason: "Schedule ended" };
  if (["DISAPPROVED", "WITH_ISSUES"].includes(eff))
    return {
      status: "failed",
      reason: eff === "DISAPPROVED" ? "Ad disapproved by Meta" : "Meta reports issues with this campaign",
    };
  if (["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].includes(eff)) return { status: "paused" };
  if (["DELETED", "ARCHIVED"].includes(eff)) return { status: "completed" };
  if (["PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED", "PENDING_BILLING_INFO"].includes(eff))
    return {
      status: "publishing",
      reason: eff === "PENDING_BILLING_INFO" ? "Add a payment method in Meta Ads Manager" : "In review at Meta",
    };
  return { status: "live" };
}

export const meta = {
  code: "meta",
  requires: { adAccount: true, page: true },

  validate(ctx: MetaCtx) {
    if (!ctx.accessToken || !ctx.adAccountId)
      throw new Error("Meta Ads is not fully connected — reconnect and pick an ad account in Connections");
  },

  goalFor: (objective: string) => GOAL[objective] || "get_more_website_visitors",

  async createCampaign(ctx: MetaCtx, campaign: Params) {
    meta.validate(ctx);
    const special = campaign.draftState?.targeting?.metaSpecialAdCategory;
    const params: Params = {
      name: campaign.name,
      objective: mapObjective(campaign.objective),
      status: "ACTIVE",
      special_ad_categories: special && special !== "none" ? [String(special).toUpperCase()] : [],
      is_adset_budget_sharing_enabled: false,
    };
    const d = await request("POST", `${GRAPH}/${ctx.adAccountId}/campaigns`, ctx.accessToken, params);
    if (!d?.id) throw new Error("Meta Ads API did not return a campaign ID");
    return { platformCampaignId: d.id };
  },

  async createAdSet(
    ctx: MetaCtx,
    campaign: Params,
    { budgetAmount, targeting = {}, name, bidStrategy, bidAmount }: Params,
    platformCampaignId: string,
  ) {
    meta.validate(ctx);
    const budget = Number(budgetAmount || campaign.budgetAmount || 0);
    if (!(budget > 0)) throw new Error("A daily budget is required to create a Meta ad set");
    const pixelId =
      [campaign.tracking?.facebookPixelId, targeting.metaPixelId].find(
        (p) => typeof p === "string" && /^\d{5,20}$/.test(p),
      ) || null;
    const metaGoal = targeting.metaGoal || meta.goalFor(campaign.objective);
    const opt = targeting.metaOptimizationGoal || optimizationGoal(campaign.objective, metaGoal, !!pixelId);
    const params: Params = {
      name: name || `${campaign.name} — ad set`,
      campaign_id: platformCampaignId,
      daily_budget: Math.round(budget * 100),
      billing_event: "IMPRESSIONS",
      optimization_goal: opt,
      bid_strategy: normalizeBid(bidStrategy),
      status: "ACTIVE",
      targeting: buildTargeting(targeting, ctx.country),
      start_time: metaTime(new Date()),
    };
    if (opt === "OFFSITE_CONVERSIONS" && pixelId)
      params.promoted_object = { pixel_id: pixelId, custom_event_type: customEvent(metaGoal, campaign.objective) };
    else if (ctx.pageId) params.promoted_object = { page_id: ctx.pageId };
    const dest = destinationType(metaGoal, campaign.objective);
    if (dest) params.destination_type = dest;
    if ((params.bid_strategy === "LOWEST_COST_WITH_BID_CAP" || params.bid_strategy === "COST_CAP") && bidAmount)
      params.bid_amount = Math.round(bidAmount * 100);
    if (campaign.endDate) params.end_time = metaTime(campaign.endDate);
    Object.assign(params, await dsaFields(ctx));
    const d = await request("POST", `${GRAPH}/${ctx.adAccountId}/adsets`, ctx.accessToken, params);
    if (!d?.id) throw new Error("Meta Ads API did not return an ad set ID");
    return { platformAdSetId: d.id, optimizationGoal: opt };
  },

  async createAdFromPost(
    ctx: MetaCtx,
    campaign: Params,
    post: Params,
    mediaUrls: string[],
    targeting: Params = {},
    platformAdSetId: string,
  ) {
    meta.validate(ctx);
    const metaGoal = targeting.metaGoal || meta.goalFor(campaign.objective);
    const isVideo =
      post.contentType === "video" || post.contentType === "reel" || mediaUrls.some((u) => /\.(mp4|mov|webm)(\?|$)/i.test(u));
    const cand = [post.destinationUrl, campaign.trackingFinalUrl, campaign.landingPageUrl, targeting.metaDestinationUrl]
      .map((c) => (typeof c === "string" ? c.trim() : ""))
      .find(Boolean);
    const linkUrl = cand ? (/^https?:\/\//i.test(cand) ? cand : `https://${cand}`) : undefined;
    if (["get_more_sales", "get_more_leads", "get_more_website_visitors"].includes(metaGoal) && !linkUrl)
      throw new Error("A website or booking URL is required for this Meta ad goal — add a landing page to the campaign");
    const creativeId = await createCreative(ctx, {
      title: post.headline || post.title || (post.body || "").slice(0, 50) || "Ad",
      body: post.body || "",
      description: post.description || "",
      linkUrl,
      mediaUrls,
      callToAction: post.callToAction,
      metaGoal,
      mediaType: isVideo ? "video" : "image",
    });
    const d = await request("POST", `${GRAPH}/${ctx.adAccountId}/ads`, ctx.accessToken, {
      name: post.title || "Meta Ad",
      adset_id: platformAdSetId,
      creative: { creative_id: creativeId },
      status: "ACTIVE",
    });
    if (!d?.id) throw new Error("Meta Ads API did not return an ad ID");
    return { platformAdId: d.id, platformPostId: creativeId };
  },

  async updateCampaign(ctx: MetaCtx, campaign: Params, platformCampaignId: string, platformAdSetId?: string) {
    meta.validate(ctx);
    await request("POST", `${GRAPH}/${platformCampaignId}`, ctx.accessToken, { name: campaign.name });
    if (platformAdSetId) {
      const p: Params = {};
      if (campaign.budgetAmount) p.daily_budget = Math.round(Number(campaign.budgetAmount) * 100);
      if (campaign.endDate) p.end_time = metaTime(campaign.endDate);
      if (Object.keys(p).length) await request("POST", `${GRAPH}/${platformAdSetId}`, ctx.accessToken, p);
    }
  },

  pauseCampaign: (ctx: MetaCtx, id: string) => request("POST", `${GRAPH}/${id}`, ctx.accessToken, { status: "PAUSED" }),
  resumeCampaign: (ctx: MetaCtx, id: string) => request("POST", `${GRAPH}/${id}`, ctx.accessToken, { status: "ACTIVE" }),
  removeCampaign: (ctx: MetaCtx, id: string) => request("DELETE", `${GRAPH}/${id}`, ctx.accessToken),
  pauseAdSet: (ctx: MetaCtx, id: string) => request("POST", `${GRAPH}/${id}`, ctx.accessToken, { status: "PAUSED" }),
  resumeAdSet: (ctx: MetaCtx, id: string) => request("POST", `${GRAPH}/${id}`, ctx.accessToken, { status: "ACTIVE" }),

  /** Daily rows + live status for one campaign. */
  async getCampaignStats(ctx: MetaCtx, platformCampaignId: string, { since, until }: { since?: string; until?: string }) {
    meta.validate(ctx);
    let rows: any[] = [];
    try {
      rows = await insights(ctx, platformCampaignId, {
        fields: INSIGHT_FIELDS,
        time_range: { since, until },
        time_increment: 1,
      });
    } catch (e) {
      rows = [];
    }
    let status: Params = {};
    try {
      const d = await request("GET", `${GRAPH}/${platformCampaignId}`, ctx.accessToken, {
        fields: "status,effective_status,start_time,stop_time",
      });
      status = {
        ...liveStatus(d.status, d.effective_status, d.stop_time),
        effectiveStatus: d.effective_status,
        stopTime: d.stop_time || null,
      };
    } catch {}
    return { daily: rows.map(parseRow).filter((r) => r.date), status };
  },
};
