// Google Ads campaign provider — Performance Max (atomic budget + campaign + asset group), pause/resume,
// budget/name updates and GAQL stats. Port of lib_campaign-providers_google.js (Phase 4 source),
// rebuilt for Cloudflare Workers: no Node APIs, no sharp, no process.env, no DB access.
// ctx = { accessToken, customerId (digits), loginCustomerId?, developerToken, apiVersion, country? }

import { googleAdsVersion } from "../platform-providers.js";

export interface GoogleAdsCtx extends Record<string, any> {
  accessToken: string;
  customerId: string;
  loginCustomerId?: string;
  developerToken: string;
  adAccountId?: string;
  apiVersion?: string;
  currency?: string;
  country?: string;
  pageId?: string;
  connection?: any;
  cfg?: any;
  tokenSecret?: string;
}

export interface PublishAtomicOptions {
  brand?: any;
  uid?: string;
  onPostPatch?: (postId: string, patch: { fieldValues: any }) => Promise<void>;
}

/* ---------- Workers-safe helpers (no Node APIs) ---------- */

const te = new TextEncoder();

function u8ToBase64(u8: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x: any) => x.toString(16).padStart(2, "0")).join("");
}

/** Best-effort image dimension sniffing (PNG IHDR, JPEG SOF) — replaces sharp's metadata(). */
function imageDimensions(buf: Uint8Array): { width: number; height: number } | null {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const w = (buf[16]! << 24) | (buf[17]! << 16) | (buf[18]! << 8) | buf[19]!;
      const h = (buf[20]! << 24) | (buf[21]! << 16) | (buf[22]! << 8) | buf[23]!;
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = (buf[i + 5]! << 8) | buf[i + 6]!;
          const w = (buf[i + 7]! << 8) | buf[i + 8]!;
          if (w > 0 && h > 0) return { width: w, height: h };
          return null;
        }
        const len = (buf[i + 2]! << 8) | buf[i + 3]!;
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch { /* fall through to null */ }
  return null;
}

// TODO(phase5): AI image generation lives in Phase 5 (../ai-images.js). Null-safe stub —
// call sites already tolerate null via .catch(() => null) + .filter(Boolean).
async function generateDistinctMaximizedImageSet(_args?: any): Promise<any> {
  return null;
}

// Local stand-ins for ../google-pmax-creative-util.js (not ported yet): derive the same text
// sets from this module's own buildTexts so updateCreative keeps working.
function pmaxInput(input: any): any {
  return { ...input, body: input?.content ?? input?.body, title: input?.postName ?? input?.title };
}
function buildPMaxHeadlines(input: any): string[] { return buildTexts(pmaxInput(input)).headlines; }
function buildPMaxLongHeadlines(input: any): string[] { return buildTexts(pmaxInput(input)).longHeadlines; }
function buildPMaxDescriptions(input: any): string[] { return buildTexts(pmaxInput(input)).descriptions; }
function buildPMaxBusinessName(input: any): string { return buildTexts(pmaxInput(input)).businessName; }


const base = (ctx: GoogleAdsCtx) => `https://googleads.googleapis.com/${ctx.apiVersion || googleAdsVersion(ctx.cfg)}`;
async function request(ctx: GoogleAdsCtx, method: any, url: any, body: any): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json", "developer-token": ctx.developerToken };
  if (ctx.loginCustomerId) headers["login-customer-id"] = ctx.loginCustomerId;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300000) });
  const text = await r.text(); let data: any = {}; try { data = JSON.parse(text); } catch { data = { error: { message: text } }; }
  if (!r.ok) {
    const details = (Array.isArray(data) ? data[0]?.error?.details : data?.error?.details) || []; const first = details[0]?.errors?.[0];
    const policy = (first?.details?.policyFindingDetails?.policyTopicEntries || []).map((p: any) => `${p.topic} (${p.type})`).join(", ");
    // Google often puts the actionable number in `details` rather than the message — e.g. the
    // per-day minimum a Demand Gen budget must clear. Say it plainly instead of "see details".
    const minMicros = first?.details?.budgetPerDayMinimumErrorDetails?.budgetPerDayMinimumMicros;
    const minimum = minMicros ? ` Google requires at least ${Number(minMicros) / 1e6} per day for this campaign type.` : "";
    const e = new Error(`Google Ads API error: ${first?.message || data?.error?.message || `HTTP ${r.status}`}${first?.location?.fieldPathElements ? ` [${first.location.fieldPathElements.map((f: any) => f.fieldName).join(".")}]` : ""}${policy ? ` — policy: ${policy}` : ""}${minimum}`);
    (e as any).details = first?.details || null;
    (e as any).code = first?.errorCode ? Object.values(first.errorCode)[0] : data?.error?.status; throw e;
  }
  return data;
}
const search = async (ctx: GoogleAdsCtx, query: any) => { const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/googleAds:searchStream`, { query }); return Array.isArray(d) ? d.flatMap((c: any) => c.results || []) : d?.results || []; };

/* ---------- text assets (Google limits: headline 30, long headline 90, description 90, business name 25) ---------- */
const LIM = { headline: 30, longHeadline: 90, description: 90, businessName: 25 };
const norm = (s: any) => String(s || "").replace(/\s+/g, " ").replace(/[!]{2,}/g, "!").trim();
const truncate = (s: any, n: any) => { s = norm(s); if (s.length <= n) return s; const cut = s.slice(0, n); const sp = cut.lastIndexOf(" "); return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:\-–—]+$/, ""); };
const usable = (s: any) => s && s.length >= 2 && !/^[\W_]+$/.test(s) && !/[<>{}]/.test(s);
function pushUnique(arr: any, text: any, limit: any, max: any) { const t = truncate(text, limit); if (!usable(t) || arr.length >= max || arr.some((x: any) => x.toLowerCase() === t.toLowerCase())) return false; arr.push(t); return true; }
const sentences = (s: any) => norm(s).split(/[.!?\n]+/).map((x: any) => x.trim()).filter((x: any) => x.length > 8);
export function buildTexts({ headline, title, body, description, headlines, descriptions, longHeadlines, businessName, campaignName, brand }: any) {
  const seed = brand || businessName || campaignName || title || "Reach";
  const userHeadlines = Array.isArray(headlines) && headlines.length > 0 ? headlines : [headline, title].filter(Boolean);
  const H: any[] = []; for (const h of userHeadlines) pushUnique(H, h, LIM.headline, 15);
  for (const s of sentences(body)) { if (H.length >= 15) break; if (norm(s).length <= LIM.headline * 2) pushUnique(H, s, LIM.headline, 15); }
  for (const v of [`Discover ${seed}`, `${seed} — official site`, `Visit ${seed} today`, `Learn more about ${seed}`, `${seed}: get started`]) { if (H.length >= 5) break; pushUnique(H, v, LIM.headline, 15); }
  let i = 0; while (H.length < 3) { i++; pushUnique(H, `${truncate(seed, 18)} ${i}`, LIM.headline, 15) || H.push(`Visit Us Today ${i}`); }
  const userDescriptions = Array.isArray(descriptions) && descriptions.length > 0 ? descriptions : [description].filter(Boolean);
  const D: any[] = []; for (const d of userDescriptions) pushUnique(D, d, LIM.description, 5);
  for (const s of sentences(body)) { if (D.length >= 5) break; if (s.length > 10) pushUnique(D, s, LIM.description, 5); }
  for (const v of [
    `Experience seamless quality and fast results with ${seed}. Discover more today.`,
    `Find out why customers choose ${seed}. Simple, fast, and completely hassle-free.`,
    `${seed} is ready when you are. Explore our solutions and get started now.`,
    `Explore what ${seed} has to offer. Professional, dependable, and efficient.`,
    `Discover ${seed} today and get the support and results you deserve.`
  ]) { if (D.length >= 5) break; pushUnique(D, v, LIM.description, 5); }
  if (!D.some((d: any) => d.length <= 60)) D.unshift(truncate(`Discover ${seed} today.`, 60));
  while (D.length < 5) D.push(D.length ? `${seed} — fast and dependable.` : `Explore ${seed}.`);

  const userLong = Array.isArray(longHeadlines) && longHeadlines.length > 0 ? longHeadlines : [];
  const L: any[] = []; const ensureMin = (s: any) => { s = norm(s); return s.length >= 20 ? s : `${s} — discover more today`.trim(); };
  for (const s of [...userLong, body ? sentences(body)[0] : null, [headline || title, campaignName].filter(Boolean).join(" — "), headline, title, `${seed}: ${description || "discover more today"}`]) { if (L.length >= 5) break; if (s) pushUnique(L, ensureMin(s), LIM.longHeadline, 5); }
  const dset = new Set(D.map((d: any) => d.toLowerCase())); const Lf = L.filter((l: any) => !dset.has(l.toLowerCase()));
  const long = Lf.length ? Lf : L;
  for (const lf of [
    `${seed}: Fast, Reliable, and Hassle-Free Solutions Today`,
    `Experience Proven Excellence and Seamless Results with ${seed}`,
    `Transform Your Results — Choose ${seed} for Dependable Quality`,
    `Get Started in Minutes with ${seed} and Enjoy Hassle-Free Support`,
    `${seed}: The Trusted Choice for Speed, Simplicity, and Quality`
  ]) {
    if (long.length >= 5) break;
    pushUnique(long, ensureMin(lf), LIM.longHeadline, 5);
  }
  return { headlines: H.slice(0, 15), longHeadlines: long.slice(0, 5), descriptions: D.slice(0, 5), businessName: truncate(seed, LIM.businessName) };
}

/* ---------- image assets ---------- */
const SLOTS = { landscape: { w: 1200, h: 628, min: [0.75, 1.91 * 1.25] }, square: { w: 1200, h: 1200 }, portrait: { w: 960, h: 1200 }, logo: { w: 1200, h: 1200 } };
function classify(ratio: number | null, name: any = "") {
  const n = name.toLowerCase(); if (n.includes("logo")) return "logo"; if (n.includes("landscape")) return "landscape"; if (n.includes("portrait")) return "portrait"; if (n.includes("square")) return "square";
  const r = typeof ratio === "number" ? ratio : -1;
  if (r >= 0.95 && r <= 1.05) return "square"; if (r >= 1.7 && r <= 2.1) return "landscape"; if (r >= 0.7 && r <= 0.9) return "portrait"; return null;
}
function resolveImageUrl(url: string, cfg?: any): string {
  if (!url || typeof url !== "string") return "";
  const clean = url.trim();
  if (clean.startsWith("http://") || clean.startsWith("https://") || clean.startsWith("data:")) return clean;
  // No process.env on Workers — an absolute base URL can come from ctx.cfg instead.
  const baseUrl = String(cfg?.appUrl || cfg?.publicUrl || "").replace(/\/$/, "");
  return baseUrl ? `${baseUrl}/${clean.replace(/^\//, "")}` : clean;
}

async function fetchBuffer(url: string, cfg?: any): Promise<Uint8Array | null> {
  try {
    if (!url) return null;
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      if (comma < 0) return null;
      const meta = url.slice(5, comma);
      const body = url.slice(comma + 1);
      return meta.includes(";base64") ? base64ToU8(body) : te.encode(decodeURIComponent(body));
    }
    const fullUrl = resolveImageUrl(url, cfg);
    const r = await fetch(fullUrl, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      console.warn(`[Google Ads] Image fetch HTTP ${r.status} for ${fullUrl}`);
      return null;
    }
    const b = new Uint8Array(await r.arrayBuffer());
    return b.length ? b : null;
  } catch (err: any) {
    console.warn(`[Google Ads] Image fetch failed for "${url}": ${err?.message || err}`);
    return null;
  }
}
// Cloudflare Workers have no sharp: resize/rotate is skipped and the original fetched bytes are
// uploaded as-is for every slot. Aspect-ratio classification still works best-effort via
// imageDimensions() (PNG/JPEG sniffing) plus filename guessing; anything unclassifiable is
// uploaded into all three marketing-image slots and Google crops on serve.
const formatFor = (buf: Uint8Array, _slot: string): Uint8Array => buf;
async function uploadImageAsset(ctx: GoogleAdsCtx, buf: any, name: any) {
  const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/assets:mutate`, { operations: [{ create: { name: `${name} ${Date.now()}`.slice(0, 120), type: "IMAGE", imageAsset: { data: u8ToBase64(buf) } } }] });
  const rn = d?.results?.[0]?.resourceName; if (!rn) throw new Error("Google Ads API did not return an asset resource name"); return rn;
}
async function createTextAsset(ctx: GoogleAdsCtx, text: any) {
  const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/assets:mutate`, {
    operations: [{ create: { textAsset: { text } } }],
  });
  const rn = d?.results?.[0]?.resourceName;
  if (!rn) throw new Error(`Failed to create text asset for "${text}"`);
  return rn;
}
export interface ImageAssetsOut {
  landscape: string[];
  square: string[];
  portrait: string[];
  logo: string[];
  [slot: string]: string[];
}

/** Every PMax asset group needs ≥1 landscape, ≥1 square (and portrait recommended) + a logo. Fill missing slots from what we have. */
export async function buildImageAssets(ctx: GoogleAdsCtx, mediaUrls: any, { logoUrl, name = "Post", imageSet }: any = {}) {
  // An explicit slot assignment from the creative editor always wins over aspect-ratio
  // guessing — the user picked that crop for that slot on purpose.
  const pinned = imageSet && typeof imageSet === "object" ? imageSet : null;
  const pinnedFor = (url: any) => {
    if (!pinned) return null;
    for (const slot of ["logo", "landscape", "square", "portrait"]) {
      const v = pinned[slot];
      const u = typeof v === "string" ? v : v?.url;
      if (u && u === url) return slot;
    }
    if (pinned.extras && typeof pinned.extras === "object") {
      for (const slot of ["landscape", "square", "portrait"]) {
        const list = pinned.extras[slot] || [];
        for (const item of list) {
          const u = typeof item === "string" ? item : item?.url;
          if (u && u === url) return slot;
        }
      }
    }
    return null;
  };

  const extraUrls = pinned?.extras
    ? [
        ...(pinned.extras.landscape || []).map((x: any) => (typeof x === "string" ? x : x?.url)),
        ...(pinned.extras.square || []).map((x: any) => (typeof x === "string" ? x : x?.url)),
        ...(pinned.extras.portrait || []).map((x: any) => (typeof x === "string" ? x : x?.url)),
      ].filter(Boolean)
    : [];

  const pinnedPrimaryUrls = pinned
    ? ["logo", "landscape", "square", "portrait"]
        .map((k: any) => (typeof pinned[k] === "string" ? pinned[k] : pinned[k]?.url))
        .filter(Boolean)
    : [];

  const items = [...new Set([...pinnedPrimaryUrls, ...extraUrls, ...(mediaUrls || []), logoUrl].filter(Boolean))].map(
    (url: any) => ({ url, isLogo: url === logoUrl || pinnedFor(url) === "logo" })
  );

  const out: ImageAssetsOut = { landscape: [], square: [], portrait: [], logo: [] };

  // 1. Parallel fetch and metadata inspection for super-fast launch time
  const fetched: any[] = await Promise.all(
    items.map(async (it: any) => {
      const buf = await fetchBuffer(it.url, ctx?.cfg);
      if (!buf) return null;
      const dims = imageDimensions(buf);
      const role = pinnedFor(it.url) || (it.isLogo ? "logo" : classify(dims && dims.height ? dims.width / dims.height : null, it.url));
      return { buf, role, isLogo: it.isLogo, url: it.url };
    })
  );

  const buffers = fetched.filter(Boolean);
  const src = buffers.find((b: any) => !b.isLogo) || buffers[0];
  if (!src) throw new Error("Performance Max needs at least one image on the post");

  // 2. Format & upload discovered assets in parallel
  const uploadJobs: any[] = [];
  for (const item of buffers) {
    if (item.role) {
      uploadJobs.push(async () => {
        const formatted = await formatFor(item.buf, item.role);
        const rn = await uploadImageAsset(ctx, formatted, `${name} ${item.role}`);
        out[item.role]!.push(rn);
      });
    } else {
      uploadJobs.push(async () => {
        const [lBuf, sBuf, pBuf] = await Promise.all([
          formatFor(item.buf, "landscape"),
          formatFor(item.buf, "square"),
          formatFor(item.buf, "portrait"),
        ]);
        const [lRn, sRn, pRn] = await Promise.all([
          uploadImageAsset(ctx, lBuf, `${name} landscape`),
          uploadImageAsset(ctx, sBuf, `${name} square`),
          uploadImageAsset(ctx, pBuf, `${name} portrait`),
        ]);
        out.landscape.push(lRn);
        out.square.push(sRn);
        out.portrait.push(pRn);
      });
    }
  }

  await Promise.all(uploadJobs.map((fn: any) => fn()));

  // 3. Parallel gap-filling for any required slots not yet populated
  const fillJobs: any[] = [];
  for (const slot of ["landscape", "square", "portrait"]) {
    if (!out[slot]!.length) {
      fillJobs.push(async () => {
        const formatted = await formatFor(src.buf, slot);
        const rn = await uploadImageAsset(ctx, formatted, `${name} ${slot} fill`);
        out[slot]!.push(rn);
      });
    }
  }
  if (!out.logo.length) {
    fillJobs.push(async () => {
      const logoSrc = buffers.find((b: any) => b.role === "square") || src;
      const formatted = await formatFor(logoSrc.buf, "logo");
      const rn = await uploadImageAsset(ctx, formatted, `${name} logo`);
      out.logo.push(rn);
    });
  }
  if (fillJobs.length) {
    await Promise.all(fillJobs.map((fn: any) => fn()));
  }

  console.info(`[Google Ads] Image assets uploaded: ${out.landscape.length} landscape, ${out.square.length} square, ${out.portrait.length} portrait, ${out.logo.length} logo.`);

  return out;
}

/* ---------- mutate builder (port of google-pmax-mutate.util) ---------- */
/**
 * Campaign settings per Google channel type, ported from reach_be's `getChannelConfig`.
 *
 * PMax is built in one atomic mutate (`buildAtomicOps`); every other channel goes through
 * `publishStandard`: budget + campaign, then an ad group, targeting criteria, and one ad whose
 * shape depends on the channel. `assertSupportedType` refuses anything not listed here — the
 * behaviour it replaced was to ignore the user's choice and publish PMax regardless.
 */
const CHANNEL_CONFIG: Record<string, any> = {
  PERFORMANCE_MAX: { advertisingChannelType: "PERFORMANCE_MAX", biddingStrategy: { maximizeConversions: {} }, adGroupType: null, supported: true },
  SEARCH: { advertisingChannelType: "SEARCH", biddingStrategy: { manualCpc: {} }, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetPartnerSearchNetwork: false, targetContentNetwork: false }, adGroupType: "SEARCH_STANDARD", supported: true },
  DEMAND_GEN: { advertisingChannelType: "DEMAND_GEN", biddingStrategy: { maximizeConversions: {} }, adGroupType: null, supported: true },
  // VIDEO is Demand Gen with a YouTube creative — Google retired the separate video channel for
  // new campaigns, and this is what reach_be did too.
  VIDEO: { advertisingChannelType: "DEMAND_GEN", biddingStrategy: { maximizeConversions: {} }, adGroupType: null, supported: true },
  DISPLAY: { advertisingChannelType: "DISPLAY", biddingStrategy: { manualCpc: {} }, networkSettings: { targetGoogleSearch: false, targetSearchNetwork: false, targetPartnerSearchNetwork: false, targetContentNetwork: true }, adGroupType: "DISPLAY_STANDARD", supported: true },
  SHOPPING: { advertisingChannelType: "SHOPPING", biddingStrategy: { manualCpc: {} }, adGroupType: "SHOPPING_PRODUCT_ADS", supported: true },
};

/**
 * Bidding strategy override from the builder. Falls back to the channel default. Amounts arrive
 * in currency units and become micros; a tCPA/tROAS with no figure is ignored rather than sent
 * empty, which Google rejects.
 */
function resolveBidding(channel: any, targeting: any = {}) {
  const isPmax = channel?.advertisingChannelType === "PERFORMANCE_MAX";
  const raw = String(targeting.bidStrategy || "").toUpperCase().replace(/[\s-]+/g, "_");
  const cpa = Number(targeting.targetCpa), roas = Number(targeting.targetRoas);
  if (isPmax) {
    switch (raw) {
      case "MAXIMIZE_CONVERSION_VALUE":
      case "TARGET_ROAS":
        return Number.isFinite(roas) && roas > 0
          ? { maximizeConversionValue: { targetRoas: roas } }
          : { maximizeConversionValue: {} };
      case "MAXIMIZE_CONVERSIONS":
      case "TARGET_CPA":
        return Number.isFinite(cpa) && cpa > 0
          ? { maximizeConversions: { targetCpaMicros: String(Math.round(cpa * 1e6)) } }
          : { maximizeConversions: {} };
      default:
        return channel?.biddingStrategy || { maximizeConversions: {} };
    }
  }
  switch (raw) {
    case "MAXIMIZE_CONVERSIONS": return Number.isFinite(cpa) && cpa > 0 ? { maximizeConversions: { targetCpaMicros: String(Math.round(cpa * 1e6)) } } : { maximizeConversions: {} };
    case "MAXIMIZE_CONVERSION_VALUE": return Number.isFinite(roas) && roas > 0 ? { maximizeConversionValue: { targetRoas: roas } } : { maximizeConversionValue: {} };
    case "TARGET_CPA": return Number.isFinite(cpa) && cpa > 0 ? { targetCpa: { targetCpaMicros: String(Math.round(cpa * 1e6)) } } : channel.biddingStrategy;
    case "TARGET_ROAS": return Number.isFinite(roas) && roas > 0 ? { targetRoas: { targetRoas: roas } } : channel.biddingStrategy;
    case "MAXIMIZE_CLICKS": return { targetSpend: {} };
    case "MANUAL_CPC": return { manualCpc: {} };
    default: return channel.biddingStrategy;
  }
}

/** The campaign type the user picked, or PMax when they picked nothing. */
export function resolveCampaignType(campaign: any, targeting: any = {}) {
  return String(targeting.campaignType || campaign?.draftState?.googleCampaignType || "PERFORMANCE_MAX").toUpperCase().trim();
}

/**
 * Refuse a type we cannot actually build. Publishing the wrong channel type is far worse than
 * failing: Google accepts it, the campaign serves on the wrong network, and money is spent.
 */
function assertSupportedType(type: any) {
  const cfg = CHANNEL_CONFIG[type];
  if (!cfg) throw new Error(`Unsupported Google Ads campaign type "${type}". Valid types: ${Object.keys(CHANNEL_CONFIG).join(", ")}.`);
  if (!cfg.supported) throw new Error(`${type.replace(/_/g, " ")} campaigns cannot be published from Reach yet — only Performance Max is supported. Change the Google campaign type to Performance Max, or create this campaign directly in Google Ads.`);
  return cfg;
}

function buildAtomicOps({ customerId, campaignName, assetGroupName, finalUrl, budgetMicros, isLifetime, channel, bidding, startDateTime, endDateTime, texts, images, youtubeAsset }: any) {
  const ops = []; let tmp = -1;
  const budgetRn = `customers/${customerId}/campaignBudgets/${tmp--}`; const campaignRn = `customers/${customerId}/campaigns/${tmp--}`;
  // `period: CUSTOM_PERIOD` + totalAmountMicros is how Google expresses a lifetime budget. Sending
  // a lifetime figure as a DAILY amount — which is what this used to do — turns "spend 5000 in
  // total" into "spend 5000 every day".
  ops.push({ campaignBudgetOperation: { create: { resourceName: budgetRn, name: `${isLifetime ? "Lifetime" : "Daily"} budget #${Date.now()}`, deliveryMethod: "STANDARD", explicitlyShared: false,
    ...(isLifetime ? { period: "CUSTOM_PERIOD", totalAmountMicros: String(budgetMicros) } : { amountMicros: String(budgetMicros) }) } } });
  ops.push({ campaignOperation: { create: { resourceName: campaignRn, name: campaignName, status: "ENABLED", advertisingChannelType: channel.advertisingChannelType, campaignBudget: budgetRn,
    ...(channel.advertisingChannelType === "PERFORMANCE_MAX" ? { brandGuidelinesEnabled: false } : {}),
    ...(channel.networkSettings ? { networkSettings: channel.networkSettings } : {}),
    ...(bidding || channel.biddingStrategy),
    containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING", ...(startDateTime ? { startDateTime } : {}), ...(endDateTime ? { endDateTime } : {}) } } });
  const links: any[] = []; const textOp = (text: any, fieldType: any) => { const rn = `customers/${customerId}/assets/${tmp--}`; ops.push({ assetOperation: { create: { resourceName: rn, textAsset: { text } } } }); links.push([rn, fieldType]); };
  texts.headlines.slice(0, 15).forEach((t: any) => textOp(t, "HEADLINE")); texts.longHeadlines.slice(0, 5).forEach((t: any) => textOp(t, "LONG_HEADLINE")); texts.descriptions.slice(0, 5).forEach((t: any) => textOp(t, "DESCRIPTION")); if (texts.businessName) textOp(texts.businessName, "BUSINESS_NAME");
  const agRn = `customers/${customerId}/assetGroups/${tmp--}`;
  ops.push({ assetGroupOperation: { create: { resourceName: agRn, name: assetGroupName, campaign: campaignRn, status: "ENABLED", finalUrls: [finalUrl] } } });
  const link = (asset: any, fieldType: any) => ops.push({ assetGroupAssetOperation: { create: { assetGroup: agRn, asset, fieldType } } });
  for (const [rn, ft] of links) link(rn, ft);
  [...new Set(images.landscape)].slice(0, 20).forEach((a: any) => link(a, "MARKETING_IMAGE")); [...new Set(images.square)].slice(0, 20).forEach((a: any) => link(a, "SQUARE_MARKETING_IMAGE")); [...new Set(images.portrait)].slice(0, 20).forEach((a: any) => link(a, "PORTRAIT_MARKETING_IMAGE")); [...new Set(images.logo)].slice(0, 5).forEach((a: any) => link(a, "LOGO"));
  if (youtubeAsset) link(youtubeAsset, "YOUTUBE_VIDEO");
  return { ops, agRn };
}
function parseMutate(d: any) { let campaignRn, agRn; for (const r of d?.mutateOperationResponses || d?.results || []) { const c = r?.campaignResult?.resourceName || (typeof r?.resourceName === "string" && r.resourceName.includes("/campaigns/") ? r.resourceName : undefined); const a = r?.assetGroupResult?.resourceName || (typeof r?.resourceName === "string" && r.resourceName.includes("/assetGroups/") ? r.resourceName : undefined); if (c && !campaignRn) campaignRn = c; if (a && !agRn) agRn = a; } return { campaignRn, agRn }; }

const GEO: Record<string, string> = {
  US: "2840", USA: "2840", "UNITED STATES": "2840",
  GB: "2826", UK: "2826", "UNITED KINGDOM": "2826",
  IN: "2356", INDIA: "2356",
  CA: "2124", CANADA: "2124",
  AU: "2036", AUSTRALIA: "2036",
  DE: "2276", GERMANY: "2276",
  FR: "2250", FRANCE: "2250",
  BR: "2076", BRAZIL: "2076",
  JP: "2392", JAPAN: "2392",
  MX: "2484", MEXICO: "2484",
  ES: "2724", SPAIN: "2724",
  IT: "2380", ITALY: "2380",
  NL: "2528", NETHERLANDS: "2528",
  SE: "2752", SWEDEN: "2752", SWEDISH: "2752", SWEDESH: "2752",
  NO: "2578", NORWAY: "2578",
  DK: "2208", DENMARK: "2208",
  FI: "2246", FINLAND: "2246",
  IE: "2372", IRELAND: "2372",
  PL: "2616", POLAND: "2616",
  PT: "2620", PORTUGAL: "2620",
  BE: "2056", BELGIUM: "2056",
  AT: "2040", AUSTRIA: "2040",
  CH: "2756", SWITZERLAND: "2756"
};
const LANG: Record<string, number> = {
  en: 1000, english: 1000,
  es: 1003, spanish: 1003,
  fr: 1002, french: 1002,
  de: 1001, german: 1001,
  pt: 1014, portuguese: 1014,
  ja: 1005, japanese: 1005,
  zh: 1017, chinese: 1017,
  ko: 1012, korean: 1012,
  it: 1004, italian: 1004,
  nl: 1010, dutch: 1010,
  sv: 1015, swedish: 1015,
  no: 1013, norwegian: 1013,
  da: 1009, danish: 1009,
  fi: 1011, finnish: 1011
};
async function applyTargeting(ctx: GoogleAdsCtx, campaignId: any, targeting: any = {}) {
  const ops = []; const rn = `customers/${ctx.customerId}/campaigns/${campaignId}`;
  const locs = (targeting.locations?.length ? targeting.locations : ctx.country ? [ctx.country] : []).map((l: any) => (/^\d+$/.test(String(l)) ? String(l) : GEO[String(l).toUpperCase()])).filter(Boolean);
  for (const geo of [...new Set(locs)]) ops.push({ create: { campaign: rn, location: { geoTargetConstant: `geoTargetConstants/${geo}` } } });
  for (const l of targeting.languages || []) { const id = LANG[String(l).toLowerCase().slice(0, 2)]; if (id) ops.push({ create: { campaign: rn, language: { languageConstant: `languageConstants/${id}` } } }); }
  if (ops.length) await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaignCriteria:mutate`, { operations: ops });
}
/* ---------- demographics (shared by every channel) ---------- */
const ALL_AGE_RANGES = ["AGE_RANGE_18_24", "AGE_RANGE_25_34", "AGE_RANGE_35_44", "AGE_RANGE_45_54", "AGE_RANGE_55_64", "AGE_RANGE_65_UP", "AGE_RANGE_UNDETERMINED"];
const AGE_SEGMENTS = [["18-24", 18, 24], ["25-34", 25, 34], ["35-44", 35, 44], ["45-54", 45, 54], ["55-64", 55, 64], ["65+", 65, null]];
const ageKey = (v: any) => String(v || "").replace(/\s+/g, "").replace("_", "-").toLowerCase();
/** The builder writes `ageRange: ["18-24", …]`; older data may carry ages/ageRanges or ageMin/ageMax. */
function selectedAgeSegments(t: any = {}) {
  const raw = t.ageRange || t.ageRanges || t.ages || t.selectedAges || t.demographics?.ageRanges;
  if (Array.isArray(raw) && raw.length) {
    const picked = new Set(raw.map(ageKey));
    const out = AGE_SEGMENTS.filter(([pill]: any) => picked.has(ageKey(pill)) || picked.has(ageKey(pill.replace("+", ""))));
    if (out.length) return out;
  }
  const min = Number(t.ageMin) || 0, max = Number(t.ageMax) || 0;
  if (!min && !max) return [];
  const lo = min || 18, hi = max || 65;
  return AGE_SEGMENTS.filter(([, a, b]: any) => (b === null ? hi >= 65 : lo <= b && hi >= a));
}
/** Google includes every age by default, so a selection is expressed as negatives for the rest. */
function excludedAgeRanges(t: any = {}) {
  const chosen = selectedAgeSegments(t);
  if (!chosen.length) return [];
  const keep = new Set(chosen.map(([, a, b]: any) => (b === null ? "AGE_RANGE_65_UP" : `AGE_RANGE_${a}_${b}`)));
  return ALL_AGE_RANGES.filter((r: any) => !keep.has(r));
}
const ageAudienceDimensions = (t: any) => { const seg = selectedAgeSegments(t); return seg.length ? [{ age: { ageRanges: seg.map(([, a, b]: any) => (b === null ? { minAge: a } : { minAge: a, maxAge: b })) } }] : null; };
/** PMax and Demand Gen take age as an Audience resource attached as a signal, not as criteria. */
async function createAgeAudience(ctx: GoogleAdsCtx, targeting: any, label: any) {
  const dimensions = ageAudienceDimensions(targeting);
  if (!dimensions) return null;
  const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/audiences:mutate`, { operations: [{ create: { name: `${label} Age Audience ${Date.now()}`, description: "Age range signal from Reach", dimensions } }] });
  return d?.results?.[0]?.resourceName || null;
}

/* ---------- YouTube ---------- */
export function extractYouTubeId(v: any) {
  const str = String(v || "").trim(); if (!str) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(str)) return str;
  const m = str.match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}
function youtubeIdOf(post: any, mediaUrls: any = []) {
  const fv = post.fieldValues || {};
  return extractYouTubeId(post.youtubeVideoUrl || post.youtubeVideoId || fv.youtubeVideoUrl || fv.youtubeVideoId || fv.videoUrl || [...(fv.mediaUrls || []), ...mediaUrls].find((u: any) => /youtu\.?be/.test(String(u))));
}
async function createYouTubeAsset(ctx: GoogleAdsCtx, youtubeVideoId: any, name: any) {
  const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/assets:mutate`, { operations: [{ create: { name: `${name} yt ${youtubeVideoId} ${Date.now()}`.slice(0, 120), type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId } } }] });
  const rn = d?.results?.[0]?.resourceName; if (!rn) throw new Error(`Google Ads did not return an asset for YouTube video ${youtubeVideoId}`); return rn;
}

/* ---------- Merchant Center ---------- */
/** The Merchant Center linked to this customer, or "" when there is none (or only a pending invite). */
async function linkedMerchantId(ctx: GoogleAdsCtx) {
  try {
    const rows = await search(ctx, "SELECT product_link.product_link_id, product_link.merchant_center.merchant_center_id FROM product_link WHERE product_link.type = 'MERCHANT_CENTER' LIMIT 1");
    const id = rows[0]?.productLink?.merchantCenter?.merchantCenterId; if (id) return String(id);
  } catch { /* fall through */ }
  try {
    const rows = await search(ctx, "SELECT product_link_invitation.product_link_invitation_id, product_link_invitation.merchant_center.merchant_center_id FROM product_link_invitation WHERE product_link_invitation.type = 'MERCHANT_CENTER' LIMIT 1");
    const id = rows[0]?.productLinkInvitation?.merchantCenter?.merchantCenterId; if (id) return String(id);
  } catch { /* none */ }
  return "";
}

/**
 * Check and auto-create ProductLink between Google Ads and Google Merchant Center (ported from ReachGit).
 */
export async function linkMerchantCenterAccount(ctx: GoogleAdsCtx, merchantId: any) {
  try {
    const cleanCustomerId = String(ctx.customerId || "").replace(/-/g, "").trim();
    const cleanMerchantId = String(merchantId || "").replace(/-/g, "").trim();
    if (!cleanCustomerId || !cleanMerchantId) return { success: false };

    // 1. Check if product_link is already established
    const searchUrl = `${base(ctx)}/customers/${cleanCustomerId}/googleAds:search`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.accessToken}`,
      "Content-Type": "application/json",
      "developer-token": ctx.developerToken,
    };
    if (ctx.loginCustomerId) {
      headers["login-customer-id"] = String(ctx.loginCustomerId).replace(/-/g, "").trim();
    }

    const checkRes = await fetch(searchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "SELECT product_link.product_link_id, product_link.merchant_center.merchant_center_id FROM product_link WHERE product_link.type = 'MERCHANT_CENTER' LIMIT 1",
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (checkRes.ok) {
      const data: any = await checkRes.json();
      const existingId =
        data?.results?.[0]?.productLink?.merchantCenter?.merchantCenterId ||
        data?.results?.[0]?.productLink?.merchantCenterId;
      if (existingId && String(existingId) === cleanMerchantId) {
        console.info(`[GoogleAds ProductLink] Merchant Center ${cleanMerchantId} is ALREADY linked to Google Ads customer ${cleanCustomerId}`);
        return { success: true, alreadyLinked: true };
      }
    }

    // 2. Create the ProductLink directly
    console.info(`[GoogleAds ProductLink] Auto-linking Google Ads ${cleanCustomerId} and Merchant Center ${cleanMerchantId}...`);
    const createUrl = `${base(ctx)}/customers/${cleanCustomerId}/productLinks:create`;
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        productLink: {
          type: "MERCHANT_CENTER",
          merchantCenter: {
            merchantCenterId: cleanMerchantId,
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (createRes.ok) {
      const createData: any = await createRes.json();
      console.info(`[GoogleAds ProductLink] SUCCESS! Created ProductLink in Google Ads: ${createData.resourceName}`);
      return { success: true, resourceName: createData.resourceName };
    } else {
      const errText = await createRes.text();
      console.warn(`[GoogleAds ProductLink] Could not create ProductLink HTTP ${createRes.status}: ${errText.slice(0, 300)}`);
      return { success: false, error: errText };
    }
  } catch (err: any) {
    console.warn(`[GoogleAds ProductLink] Failed to auto-link Merchant Center: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}

/* ---------- ad-group campaigns: SEARCH · DISPLAY · DEMAND_GEN · VIDEO · SHOPPING ---------- */
/**
 * Location/language/keyword/demographic criteria for a standard campaign. Rules ported from
 * reach_be: Demand Gen takes location+language at the ad group and age as an Audience; Shopping
 * takes no language, no keywords, and gets its product partition here; everyone else takes
 * negative age ranges + gender at the ad group and keywords as BROAD match.
 */
async function applyStandardTargeting(ctx: GoogleAdsCtx, campaignId: any, adGroupRn: any, type: any, targeting: any = {}) {
  const campaignRn = `customers/${ctx.customerId}/campaigns/${campaignId}`;
  const isDemandGen = type === "DEMAND_GEN" || type === "VIDEO", isShopping = type === "SHOPPING";
  const camp: any[] = [], group: any[] = [];
  const geoTarget = (l: any) => (/^\d+$/.test(String(l)) ? String(l) : GEO[String(l).toUpperCase()]);
  const locs = (targeting.locations?.length ? targeting.locations : ctx.country ? [ctx.country] : []).map(geoTarget).filter(Boolean);
  for (const geo of [...new Set(locs)]) (isDemandGen ? group : camp).push({ create: { ...(isDemandGen ? { adGroup: adGroupRn } : { campaign: campaignRn }), location: { geoTargetConstant: `geoTargetConstants/${geo}` } } });
  if (!isShopping) for (const l of targeting.languages || []) { const id = LANG[String(l).toLowerCase().slice(0, 2)]; if (id) (isDemandGen ? group : camp).push({ create: { ...(isDemandGen ? { adGroup: adGroupRn } : { campaign: campaignRn }), language: { languageConstant: `languageConstants/${id}` } } }); }
  if (!isShopping) for (const k of [...new Set([...(targeting.keywords || []), ...(targeting.searchThemes || [])].map((x: any) => String(x || "").trim()).filter(Boolean))]) group.push({ create: { adGroup: adGroupRn, keyword: { text: k, matchType: "BROAD" } } });
  if (isDemandGen) {
    const aud = await createAgeAudience(ctx, targeting, "DemandGen").catch(() => null);
    if (aud) group.push({ create: { adGroup: adGroupRn, audience: { audience: aud } } });
    for (const i of targeting.interests || []) { const id = targeting.interestIdMap?.[i] || i; if (/^\d+$/.test(String(id))) group.push({ create: { adGroup: adGroupRn, userInterest: { userInterestCategory: `userInterestCategories/${id}` } } }); }
  } else if (!isShopping) {
    for (const r of excludedAgeRanges(targeting)) group.push({ create: { adGroup: adGroupRn, negative: true, ageRange: { type: r } } });
    for (const g of targeting.genders || []) group.push({ create: { adGroup: adGroupRn, gender: { type: String(g).toLowerCase() === "male" ? "MALE" : "FEMALE" } } });
  }
  if (isShopping) {
    const ids = [...new Set([targeting.merchantProductId, ...(targeting.merchantProductIds || [])].filter(Boolean).map(String))];
    const cpcBidMicros = String(Math.round((Number(targeting.bidAmount) || 1) * 1e6));
    if (ids.length === 1) {
      camp.push({
        create: {
          campaign: campaignRn,
          listingScope: {
            dimensions: [
              {
                productItemId: {
                  value: ids[0],
                },
              },
            ],
          },
        },
      });
    }
    if (ids.length > 0) {
      const rootTempRn = `${adGroupRn.replace("/adGroups/", "/adGroupCriteria/")}~-1`;
      // 1. Root SUBDIVISION node
      group.push({
        create: {
          resourceName: rootTempRn,
          adGroup: adGroupRn,
          status: "ENABLED",
          listingGroup: {
            type: "SUBDIVISION",
          },
        },
      });
      // 2. Unit node for each selected product
      for (const id of ids) {
        group.push({
          create: {
            adGroup: adGroupRn,
            status: "ENABLED",
            cpcBidMicros,
            listingGroup: {
              type: "UNIT",
              parentAdGroupCriterion: rootTempRn,
              caseValue: {
                productItemId: {
                  value: id,
                },
              },
            },
          },
        });
      }
      // 3. Excluded "Other" (Everything else) unit node to completely partition the subdivision
      group.push({
        create: {
          adGroup: adGroupRn,
          status: "ENABLED",
          negative: true,
          listingGroup: {
            type: "UNIT",
            parentAdGroupCriterion: rootTempRn,
            caseValue: {
              productItemId: {},
            },
          },
        },
      });
    } else {
      // All products (single root unit node)
      group.push({
        create: {
          adGroup: adGroupRn,
          status: "ENABLED",
          cpcBidMicros,
          listingGroup: {
            type: "UNIT",
          },
        },
      });
    }
  }
  if (camp.length) await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaignCriteria:mutate`, { operations: camp });
  if (group.length) await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroupCriteria:mutate`, { operations: group });
}

/** One or more ads, shaped for the channel. Demand Gen can return both video and multi-asset ads. */
function buildStandardAds({ type, adGroupRn, finalUrl, texts, images, post, youtubeAsset, logoOnly }: any) {
  const H = (n: any) => texts.headlines.slice(0, n).map((text: any) => ({ text }));
  const D = (n: any) => texts.descriptions.slice(0, n).map((text: any) => ({ text }));
  const pick = (arr: any) => [...new Set(arr)].map((asset: any) => ({ asset }));
  const name = (post.title || post.headline || "Reach ad").slice(0, 80);
  switch (type) {
    case "SEARCH":
      return [{ adGroup: adGroupRn, status: "ENABLED", ad: { name: `${name} · search`.slice(0, 120), finalUrls: [finalUrl], responsiveSearchAd: { headlines: H(15), descriptions: D(4) } } }];
    case "DISPLAY": {
      if (!images.landscape.length || !images.square.length) throw new Error("Display campaigns need at least one landscape (1.91:1) and one square (1:1) image");
      const displayLongHeadline = texts.longHeadlines?.[0] || texts.headlines?.[0] || name || "Discover more today";
      return [{ adGroup: adGroupRn, status: "ENABLED", ad: { name: `${name} · display`.slice(0, 120), finalUrls: [finalUrl], responsiveDisplayAd: { headlines: H(5), longHeadline: { text: displayLongHeadline }, descriptions: D(5), businessName: texts.businessName, marketingImages: pick(images.landscape), squareMarketingImages: pick(images.square), ...(images.logo.length ? { squareLogoImages: pick(images.logo) } : {}) } } }];
    }
    case "SHOPPING":
      return [{ adGroup: adGroupRn, status: "ENABLED", ad: { shoppingProductAd: {} } }];
    case "VIDEO": {
      if (!youtubeAsset) throw new Error("Video campaigns need a YouTube video URL on the post");
      const logoAssets = images.logo.length ? images.logo : images.square;
      return [{ adGroup: adGroupRn, status: "ENABLED", ad: { name: `${name} · video`.slice(0, 120), finalUrls: [finalUrl], demandGenVideoResponsiveAd: { headlines: H(5), longHeadlines: texts.longHeadlines.slice(0, 5).map((text: any) => ({ text })), descriptions: D(5), videos: [{ asset: youtubeAsset }], businessName: { text: texts.businessName }, ...(logoAssets.length ? { logoImages: pick(logoAssets).slice(0, 1) } : {}) } } }];
    }
    case "DEMAND_GEN": {
      const logoAssets = images.logo.length ? images.logo : images.square;
      const ads = [];
      const hasImages = Boolean(images.landscape.length && images.square.length);
      const hasVideo = Boolean(youtubeAsset);

      if (!hasImages && !hasVideo) {
        throw new Error("Demand Gen campaigns need at least one landscape and one square image (or a YouTube video)");
      }

      // 1. If YouTube video is provided, create the Demand Gen Video Responsive ad (YouTube Shorts / In-stream)
      if (hasVideo) {
        ads.push({
          adGroup: adGroupRn,
          status: "ENABLED",
          ad: {
            name: `${name} · video`.slice(0, 120),
            finalUrls: [finalUrl],
            demandGenVideoResponsiveAd: {
              headlines: H(5),
              longHeadlines: texts.longHeadlines.slice(0, 5).map((text: any) => ({ text })),
              descriptions: D(5),
              videos: [{ asset: youtubeAsset }],
              businessName: { text: texts.businessName },
              ...(logoAssets.length ? { logoImages: pick(logoAssets).slice(0, 1) } : {}),
            },
          },
        });
      }

      // 2. If marketing images are provided, create the Demand Gen Multi-Asset ad (Discover, Gmail, Feed)
      if (hasImages) {
        ads.push({
          adGroup: adGroupRn,
          status: "ENABLED",
          ad: {
            name: `${name} · multi-asset`.slice(0, 120),
            finalUrls: [finalUrl],
            demandGenMultiAssetAd: {
              headlines: H(5),
              descriptions: D(5),
              businessName: texts.businessName,
              marketingImages: pick(images.landscape),
              squareMarketingImages: pick(images.square),
              ...(images.portrait.length ? { portraitMarketingImages: pick(images.portrait) } : {}),
              logoImages: pick(logoAssets),
            },
          },
        });
      }

      return ads;
    }
    default:
      throw new Error(`No ad shape for ${type}`);
  }
}

function buildStandardAd(args: any) {
  const ads = buildStandardAds(args);
  return ads[0];
}

/**
 * Non-PMax publish: budget + campaign, ad group, criteria, one ad. Sequential rather than one
 * atomic mutate because ad groups and ads reference the campaign by its real resource name.
 * Returns the same shape as the PMax path so the publisher does not care which ran.
 */
async function publishStandard(ctx: GoogleAdsCtx, campaign: any, posts: any, { brand }: any = {}, { type, channel, targeting, bidding, isLifetime, budgetMicros }: any) {
  const first = posts[0]; const p = first.post; const fv = p.fieldValues || {};
  const finalUrl = [p.destinationUrl, campaign.trackingFinalUrl, campaign.landingPageUrl].map((u: any) => (typeof u === "string" ? u.trim() : "")).find((u: any) => /^https?:\/\/\S+$/i.test(u));
  if (!finalUrl && type !== "SHOPPING") throw new Error(`Cannot publish to Google Ads without a landing page URL. Set one on "${campaign.name}" and try again.`);
  const texts = buildTexts({ headline: p.headline, title: p.title, body: p.body, description: p.description, headlines: fv.headlines, descriptions: fv.descriptions, longHeadlines: fv.longHeadlines, businessName: fv.businessName, campaignName: campaign.name, brand: brand?.name });
  const startD = campaign.startDate ? (dateStr(campaign.startDate) < today() ? today() : dateStr(campaign.startDate)) : null;
  const campaignName = `${campaign.name.slice(0, 90)} · ${today()} · ${randomHex(3)}`;

  // Shopping needs a Merchant Center before anything else is created; fail before spending calls.
  let shoppingSetting = null;
  if (type === "SHOPPING") {
    const merchantId = String(targeting.merchantId || targeting.merchantCenterId || ctx.connection?.meta?.merchantCenterId || (await linkedMerchantId(ctx)) || "").trim();
    if (!merchantId) throw new Error("Shopping campaigns need a Google Merchant Center linked to this Google Ads account. Link one under Tools & Settings → Linked accounts in Google Ads, then try again.");
    await linkMerchantCenterAccount(ctx, merchantId);
    shoppingSetting = { merchantId, campaignPriority: Number(targeting.campaignPriority) || 0, enableLocal: Boolean(targeting.enableLocal), ...(targeting.feedLabel || targeting.salesCountry ? { feedLabel: String(targeting.feedLabel || targeting.salesCountry).trim() } : {}) };
  }

  const bud = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaignBudgets:mutate`, { operations: [{ create: { name: `${isLifetime ? "Lifetime" : "Daily"} budget ${campaignName}`.slice(0, 120), deliveryMethod: "STANDARD", explicitlyShared: false, ...(isLifetime ? { period: "CUSTOM_PERIOD", totalAmountMicros: String(budgetMicros) } : { amountMicros: String(budgetMicros) }) } }] });
  const budgetRn = bud?.results?.[0]?.resourceName; if (!budgetRn) throw new Error("Google Ads did not return a budget");
  const cmp = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaigns:mutate`, { operations: [{ create: {
    name: campaignName, status: "ENABLED", advertisingChannelType: channel.advertisingChannelType, campaignBudget: budgetRn,
    ...(channel.networkSettings ? { networkSettings: channel.networkSettings } : {}), ...bidding,
    ...(shoppingSetting ? { shoppingSetting } : {}),
    containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    ...(startD ? { startDateTime: `${startD} 00:00:00` } : {}), ...(campaign.endDate ? { endDateTime: `${dateStr(campaign.endDate)} 23:59:59` } : {}) } }] });
  const campaignRn = cmp?.results?.[0]?.resourceName; const platformCampaignId = campaignRn?.split("/").pop();
  if (!platformCampaignId) throw new Error("Google Ads did not return the campaign it created");

  // Everything after the campaign is created runs under a rollback. A failure in the ad group,
  // assets or ad (a rejected image, an unavailable video) used to leave the campaign ENABLED
  // and empty on Google — visible in the account, never serving — while our row recorded no
  // externalCampaignId, so nothing would ever clean it up.
  try {
    // Demand Gen ad groups carry no CPC bid; the others default to 1 unit unless the builder set one.
    const cpcMicros = String(Math.round((Number(targeting.bidAmount) || 1) * 1e6));
    const ag = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroups:mutate`, { operations: [{ create: { name: `${p.title || campaign.name} — ad group`.slice(0, 120), campaign: campaignRn, status: "ENABLED", ...(channel.adGroupType ? { type: channel.adGroupType } : {}), ...(channel.advertisingChannelType === "DEMAND_GEN" ? {} : { cpcBidMicros: cpcMicros }) } }] });
    const adGroupRn = ag?.results?.[0]?.resourceName; const adGroupId = adGroupRn?.split("/").pop();
    if (!adGroupRn) throw new Error("Google Ads did not return the ad group it created");

    // The builder labels the same input "Search themes" for PMax and "Keywords" for Search, and
    // stores it on the post. PMax already reads it from there (applySearchThemes); Search read only
    // `targeting`, so themes typed in the creative editor never reached the ad group.
    const fvThemes = { keywords: [...(targeting.keywords || []), ...(fv.keywords || [])], searchThemes: [...(targeting.searchThemes || []), ...(fv.searchThemes || [])] };
    try {
      await applyStandardTargeting(ctx, platformCampaignId, adGroupRn, type, { ...targeting, ...fvThemes });
    } catch (e: any) {
      console.warn(`[GoogleAds Shopping/StandardTargeting] Failed to apply criteria: ${e.message}`, e?.details || "");
      if (type === "SHOPPING") throw e;
    }

    const needsImages = type === "DISPLAY" || type === "DEMAND_GEN";
    const ytId = (type === "VIDEO" || type === "DEMAND_GEN") ? youtubeIdOf(p, first.mediaUrls) : "";
    const youtubeAsset = ytId ? await createYouTubeAsset(ctx, ytId, p.title || campaign.name) : null;
    let images: ImageAssetsOut = { landscape: [], square: [], portrait: [], logo: [] };
    const logoUrl = fv.logoUrl || brand?.logoUrl;
    if (needsImages || (type === "VIDEO" && logoUrl)) {
      try { images = await buildImageAssets(ctx, needsImages ? first.mediaUrls : [], { logoUrl, name: p.title || campaign.name, imageSet: fv.imageSet }); }
      catch (e: any) { if (needsImages && !youtubeAsset) throw e; }
    }
    const adOps = buildStandardAds({ type, adGroupRn, finalUrl, texts, images, post: p, youtubeAsset });
    const ad = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroupAds:mutate`, { operations: adOps.map((create: any) => ({ create })) });
    const adRns = (ad?.results || []).map((r: any) => r?.resourceName).filter(Boolean);
    console.info(`[Google Ads] Published standard campaign "${campaign.name}" (${type}): campaign ${platformCampaignId}, ad group ${adGroupId}`);
    return { platformCampaignId, platformAdSetId: adGroupId, adIds: adRns, campaignType: type, nativeObjective: channel.advertisingChannelType, texts };
  } catch (e: any) {
    await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaigns:mutate`, { operations: [{ remove: campaignRn }] }).catch(() => {});
    await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaignBudgets:mutate`, { operations: [{ remove: budgetRn }] }).catch(() => {});
    throw e;
  }
}

/**
 * Extract and sanitize search themes for Google Performance Max.
 * Google Ads enforces strict constraints:
 * - Up to 25 search themes per asset group
 * - Max 80 characters per theme
 * - Max 10 words per theme
 * - Disallowed special characters removed
 * - Deduplicated case-insensitively
 */
export function extractPmaxSearchThemes({ targeting = {}, post = {}, campaign = {} }: any = {}) {
  const fv = post.fieldValues || {};
  const aud = campaign.draftState?.audience || campaign.audience || {};

  const sources = [
    targeting.searchThemes,
    targeting.keywords,
    fv.searchThemes,
    fv.keywords,
    post.keywords,
    aud.keywords,
    campaign.draftState?.targeting?.searchThemes,
    campaign.draftState?.targeting?.keywords,
    campaign.targeting?.searchThemes,
    campaign.targeting?.keywords,
  ];

  const rawList = [];
  for (const s of sources) {
    if (Array.isArray(s)) rawList.push(...s);
    else if (typeof s === "string" && s.trim()) rawList.push(s.trim());
  }

  const seen = new Set();
  const cleaned = [];

  for (const item of rawList) {
    if (!item) continue;
    // Strip forbidden characters in search themes: brackets, quotes, asterisks, plus, @, etc.
    let text = String(item)
      .replace(/[\[\]\(\)\{\}"'“”‘’*!+@~#$%^&=|\\<>?;:_]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    // Enforce Google Ads max 80 characters
    if (text.length > 80) {
      text = text.slice(0, 80).trim();
      const lastSpace = text.lastIndexOf(" ");
      if (lastSpace > 20) text = text.slice(0, lastSpace).trim();
    }

    // Enforce Google Ads max 10 words
    const words = text.split(/\s+/);
    if (words.length > 10) {
      text = words.slice(0, 10).join(" ");
    }

    const lower = text.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      cleaned.push(text);
    }

    // Google Ads limits search themes to 25 per asset group
    if (cleaned.length >= 25) break;
  }

  return cleaned;
}

/**
 * Attach audience signal and search themes to a Performance Max asset group in ONE mutate call.
 * Uses partialFailure: true so invalid or duplicate themes do not block valid ones.
 */
async function applyPmaxAssetGroupSignals(ctx: GoogleAdsCtx, assetGroupRn: any, { targeting = {}, post = {}, campaign = {}, audienceRn = null }: any = {}) {
  const themes = extractPmaxSearchThemes({ targeting, post, campaign });
  const ops = [];

  if (audienceRn) {
    ops.push({
      create: {
        assetGroup: assetGroupRn,
        audience: { audience: audienceRn },
      },
    });
  }

  for (const text of themes) {
    ops.push({
      create: {
        assetGroup: assetGroupRn,
        searchTheme: { text },
      },
    });
  }

  if (!ops.length) return;

  console.info(`[Google Ads] Applying ${ops.length} asset-group signal(s) to ${assetGroupRn}`);

  try {
    const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/assetGroupSignals:mutate`, {
      operations: ops,
      partialFailure: true,
    });

    if (d?.partialFailureError) {
      console.warn(`[Google Ads PMax Signals Warning] Partial failure attaching signals: ${d.partialFailureError.message}`);
    }
    return d;
  } catch (err: any) {
    console.error(`[Google Ads PMax Signals ERROR] Failed applying asset group signals to ${assetGroupRn}: ${err.message}`);
    throw err;
  }
}

/** Legacy wrapper kept for backward compatibility */
async function applySearchThemes(ctx: GoogleAdsCtx, assetGroupRn: any, targeting: any = {}, post: any = {}) {
  return applyPmaxAssetGroupSignals(ctx, assetGroupRn, { targeting, post });
}

/**
 * Synchronize search themes on a live Performance Max asset group.
 * Queries existing search themes, removes deleted ones, and creates new ones.
 */
async function syncPmaxSearchThemes(ctx: GoogleAdsCtx, assetGroupRn: any, { targeting = {}, campaign = {}, post = {} }: any = {}) {
  const hasKeywords = Array.isArray(targeting.keywords) || Array.isArray(targeting.searchThemes) || Array.isArray(post.fieldValues?.keywords) || Array.isArray(post.fieldValues?.searchThemes) || Array.isArray(campaign.audience?.keywords) || Array.isArray(campaign.draftState?.audience?.keywords);
  if (!hasKeywords) return;

  const desiredThemes = extractPmaxSearchThemes({ targeting, campaign, post });
  const agId = assetGroupRn.split("/").pop();

  const existingRows = await search(
    ctx,
    `SELECT asset_group_signal.resource_name, asset_group_signal.search_theme.text FROM asset_group_signal WHERE asset_group.id = ${agId}`
  ).catch((err: any) => {
    console.warn(`[Google Ads PMax Update] Could not query existing asset group signals: ${err.message}`);
    return [];
  });

  const existingThemes = [];
  for (const r of existingRows) {
    const text = r.assetGroupSignal?.searchTheme?.text;
    const rn = r.assetGroupSignal?.resourceName;
    if (text && rn) {
      existingThemes.push({ text: text.trim(), rn, lower: text.trim().toLowerCase() });
    }
  }

  const desiredLowerSet = new Set(desiredThemes.map((t: any) => t.toLowerCase()));
  const existingLowerSet = new Set(existingThemes.map((e: any) => e.lower));

  const ops = [];

  // Remove signals that are no longer in desired themes
  for (const e of existingThemes) {
    if (!desiredLowerSet.has(e.lower)) {
      ops.push({ remove: e.rn });
    }
  }

  // Create signals for new themes that do not exist yet
  for (const t of desiredThemes) {
    if (!existingLowerSet.has(t.toLowerCase())) {
      ops.push({
        create: {
          assetGroup: assetGroupRn,
          searchTheme: { text: t },
        },
      });
    }
  }

  if (!ops.length) {
    console.info(`[Google Ads PMax Update] Search themes are already up to date (${desiredThemes.length} themes)`);
    return;
  }

  console.info(`[Google Ads PMax Update] Syncing search themes on ${assetGroupRn}: ${ops.filter((o: any) => o.remove).length} to remove, ${ops.filter((o) => o.create).length} to create...`);

  try {
    const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/assetGroupSignals:mutate`, {
      operations: ops,
      partialFailure: true,
    });

    if (d?.partialFailureError) {
      console.warn(`[Google Ads PMax Update Warning] Partial failure syncing search themes: ${d.partialFailureError.message}`);
    } else {
      console.info(`[Google Ads] Synced search themes on ${assetGroupRn}`);
    }
    return d;
  } catch (err: any) {
    console.error(`[Google Ads PMax Update ERROR] Failed syncing search themes on ${assetGroupRn}: ${err.message}`);
    throw err;
  }
}

const dateStr = (d: any) => (typeof d === "string" ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

export const google = {
  code: "google_ads",
  atomic: true,
  validate(ctx: GoogleAdsCtx) { if (!ctx.developerToken) throw new Error("Google Ads developer token is not configured"); if (!ctx.accessToken || !ctx.customerId) throw new Error("Google Ads is not fully connected — reconnect and pick a customer account in Connections"); },

  /** Budget + campaign + asset group in one mutate. posts: [{ post, mediaUrls, targeting }] — the first post's creative is used. */
  async publishAtomic(ctx: GoogleAdsCtx, campaign: any, posts: any, { brand, uid, onPostPatch }: PublishAtomicOptions = {}) {
    google.validate(ctx);
    const first = posts[0]; if (!first) throw new Error("Google Ads needs at least one post (creative) on this campaign");
    const p = first.post; const fv = p.fieldValues || {};
    const targeting = { ...(campaign.draftState?.targeting || {}), ...(first.targeting || {}) };
    const type = resolveCampaignType(campaign, targeting);
    const channel = assertSupportedType(type);
    const bidding = resolveBidding(channel, targeting);
    const isLifetime = String(campaign.budgetType || "daily").toLowerCase() === "lifetime";
    const budgetMicros = Math.round(Number(first.budgetAmount || campaign.budgetAmount || 1) * 1_000_000);
    // Everything but Performance Max is an ad-group campaign with its own ad shape.
    if (type !== "PERFORMANCE_MAX") return publishStandard(ctx, campaign, posts, { brand }, { type, channel, targeting, bidding, isLifetime, budgetMicros });
    const finalUrl = [p.destinationUrl, campaign.trackingFinalUrl, campaign.landingPageUrl].map((u: any) => (typeof u === "string" ? u.trim() : "")).find((u: any) => /^https?:\/\/\S+$/i.test(u));
    if (!finalUrl) throw new Error(`Cannot publish to Google Ads without a landing page URL. Set one on "${campaign.name}" and try again.`);

    // Performance Max creative asset maximization (ReachGit parity for Google "Excellent" Ad Strength)
    const imageSet = fv.imageSet && typeof fv.imageSet === "object" ? { ...fv.imageSet } : {};
    imageSet.extras = imageSet.extras && typeof imageSet.extras === "object" ? { ...imageSet.extras } : { landscape: [], square: [], portrait: [] };
    imageSet.extras.landscape = Array.isArray(imageSet.extras.landscape) ? [...imageSet.extras.landscape] : [];
    imageSet.extras.square = Array.isArray(imageSet.extras.square) ? [...imageSet.extras.square] : [];
    imageSet.extras.portrait = Array.isArray(imageSet.extras.portrait) ? [...imageSet.extras.portrait] : [];

    const urlOf = (r: any) => (typeof r === "string" ? r : r?.url) || null;
    const countL = (urlOf(imageSet.landscape) ? 1 : 0) + imageSet.extras.landscape.length;
    const countS = (urlOf(imageSet.square) ? 1 : 0) + imageSet.extras.square.length;
    const countP = (urlOf(imageSet.portrait) ? 1 : 0) + imageSet.extras.portrait.length;

    const effectiveUid = uid || campaign.user_id;
    const ws = campaign.workspace_id ? { id: campaign.workspace_id, tenant_Id: campaign.tenant_Id } : null;

    // If extras already exist or required images already exist, skip generation completely to avoid waste & duplicate cost.
    const hasAnyExtras = imageSet.extras.landscape.length > 0 || imageSet.extras.square.length > 0 || imageSet.extras.portrait.length > 0;
    const hasRequiredImages = countL >= 1 && countS >= 1;

    if (ws && effectiveUid && !hasAnyExtras && !hasRequiredImages) {
      console.info(`[Google Ads] AI image generation is stubbed in this build (Phase 5); continuing with existing assets.`);
      const logoUrl = urlOf(imageSet.logo) || fv.logoUrl || brand?.logoUrl || null;
      const existingRefs = [logoUrl, urlOf(imageSet.portrait), urlOf(imageSet.square), urlOf(imageSet.landscape), ...(first.mediaUrls || [])].filter(Boolean);
      const prompt = String(fv.imagePrompt || p.imagePrompt || "").trim() ||
        `Professional advertising photography for ${brand?.name || p.title || campaign.name}`;

      const neededRounds = 1;

      const angleThemes = [
        "wide environmental establishing scene with commercial lighting and high depth",
        "dynamic lifestyle action and customer interaction in authentic setting",
        "clean cinematic hero perspective with premium focal quality",
      ];

      const genTasks: any[] = [];
      for (let i = 0; i < neededRounds; i++) {
        const roundTheme = angleThemes[i % angleThemes.length];
        const roundPrompt = `${prompt}. Variation theme: ${roundTheme}.`;
        genTasks.push(
          generateDistinctMaximizedImageSet({
            ws,
            uid: effectiveUid,
            prompt: roundPrompt,
            refs: existingRefs.slice(0, 3),
            campaignId: campaign.id,
          }).catch((err: any) => {
            console.warn(`[Google Ads Publish] Generation round ${i + 1} warning:`, err?.message);
            return null;
          })
        );
      }

      const genResults = (await Promise.all(genTasks)).filter(Boolean);
      let newAssetsGenerated = 0;

      for (const res of genResults) {
        if (res.landscapeMediaAsset?.url) {
          if (!urlOf(imageSet.landscape)) {
            imageSet.landscape = { url: res.landscapeMediaAsset.url, role: "landscape", mediaAssetId: res.landscapeMediaAsset.id, width: 1200, height: 628, googleReady: true };
          } else if (imageSet.extras.landscape.length < 3) {
            imageSet.extras.landscape.push({ url: res.landscapeMediaAsset.url, role: "landscape", mediaAssetId: res.landscapeMediaAsset.id, width: 1200, height: 628, googleReady: true, isMaximized: true });
          }
          newAssetsGenerated++;
        }
        if (res.squareMediaAsset?.url) {
          if (!urlOf(imageSet.square)) {
            imageSet.square = { url: res.squareMediaAsset.url, role: "square", mediaAssetId: res.squareMediaAsset.id, width: 1200, height: 1200, googleReady: true };
          } else if (imageSet.extras.square.length < 3) {
            imageSet.extras.square.push({ url: res.squareMediaAsset.url, role: "square", mediaAssetId: res.squareMediaAsset.id, width: 1200, height: 1200, googleReady: true, isMaximized: true });
          }
          newAssetsGenerated++;
        }
        if (res.portraitMediaAsset?.url) {
          if (!urlOf(imageSet.portrait)) {
            imageSet.portrait = { url: res.portraitMediaAsset.url, role: "portrait", mediaAssetId: res.portraitMediaAsset.id, width: 960, height: 1200, googleReady: true };
          } else if (imageSet.extras.portrait.length < 1) {
            imageSet.extras.portrait.push({ url: res.portraitMediaAsset.url, role: "portrait", mediaAssetId: res.portraitMediaAsset.id, width: 960, height: 1200, googleReady: true, isMaximized: true });
          }
          newAssetsGenerated++;
        }
      }

      if (newAssetsGenerated > 0) {
        fv.imageSet = imageSet;
        const allNewUrls = [
          urlOf(imageSet.landscape),
          urlOf(imageSet.square),
          urlOf(imageSet.portrait),
          ...imageSet.extras.landscape.map(urlOf),
          ...imageSet.extras.square.map(urlOf),
          ...imageSet.extras.portrait.map(urlOf),
        ].filter(Boolean);
        first.mediaUrls = [...new Set([...(first.mediaUrls || []), ...allNewUrls])];
        fv.mediaUrls = first.mediaUrls;

        if (p.id && onPostPatch) {
          try {
            await onPostPatch(p.id, { fieldValues: { ...fv, imageSet, mediaUrls: first.mediaUrls } });
          } catch (saveErr: any) {
            console.error(`[Google Ads] Could not persist extras to post ${p.id}:`, saveErr?.message || saveErr);
          }
        }
        console.info(`[Google Ads] Added ${newAssetsGenerated} maximized image assets to the campaign.`);
      }
    }

    const texts = buildTexts({ headline: p.headline, title: p.title, body: p.body, description: p.description, headlines: fv.headlines, descriptions: fv.descriptions, longHeadlines: fv.longHeadlines, businessName: fv.businessName, campaignName: campaign.name, brand: brand?.name });
    const startD = campaign.startDate ? (dateStr(campaign.startDate) < today() ? today() : dateStr(campaign.startDate)) : null;
    const ytId = youtubeIdOf(p, first.mediaUrls);

    // Fast parallel asset preparation: images + YouTube asset concurrently
    const [images, youtubeAsset] = await Promise.all([
      buildImageAssets(ctx, first.mediaUrls, { logoUrl: fv.logoUrl || brand?.logoUrl, name: p.title || campaign.name, imageSet: fv.imageSet }),
      ytId
        ? createYouTubeAsset(ctx, ytId, p.title || campaign.name).catch((err: any) => {
            console.warn(`[PMax] Could not create YouTube video asset: ${err?.message}`);
            return null;
          })
        : Promise.resolve(null),
    ]);

    console.info(`[Google Ads] Publishing PMax campaign "${campaign.name}" (${texts.headlines.length} headlines, ${images.landscape.length}/${images.square.length}/${images.portrait.length} images, ${images.logo.length} logos${youtubeAsset ? ", YouTube attached" : ""})`);

    const { ops, agRn } = buildAtomicOps({ customerId: ctx.customerId, campaignName: `${campaign.name.slice(0, 90)} · ${today()} · ${randomHex(3)}`, assetGroupName: `${p.title || campaign.name} Asset Group`.slice(0, 120), finalUrl, budgetMicros, isLifetime, channel, bidding, startDateTime: startD ? `${startD} 00:00:00` : undefined, endDateTime: campaign.endDate ? `${dateStr(campaign.endDate)} 23:59:59` : undefined, texts, images, youtubeAsset });
    const d = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/googleAds:mutate`, { mutateOperations: ops });
    const { campaignRn, agRn: createdAg } = parseMutate(d);
    const platformCampaignId = campaignRn?.split("/").pop(); if (!platformCampaignId || !createdAg) throw new Error("Google Ads did not return the campaign and asset group it created");

    console.info(`[Google Ads] Published PMax campaign ${platformCampaignId} (asset group ${createdAg})`);

    // Post-launch: apply campaign criteria (locations/languages) and asset group signals (audience + search themes)
    const audPromise = createAgeAudience(ctx, targeting, "PMax").catch((err: any) => {
      console.warn(`[Google Ads PMax] Warning: Failed to create age audience: ${err.message}`);
      return null;
    });

    const [aud] = await Promise.all([
      audPromise,
      applyTargeting(ctx, platformCampaignId, targeting).catch((err: any) => {
        console.warn(`[Google Ads PMax] Warning: Failed applying campaign criteria: ${err.message}`);
      }),
    ]);

    await applyPmaxAssetGroupSignals(ctx, createdAg, { targeting, post: p, campaign, audienceRn: aud }).catch((err: any) => {
      console.error(`[Google Ads PMax Signals ERROR] Failed applying asset group signals: ${err.message}`);
    });

    return { platformCampaignId, platformAdSetId: createdAg, adIds: [createdAg], campaignType: type, nativeObjective: type, texts };
  },

  async updateCampaign(ctx: GoogleAdsCtx, campaign: any, platformCampaignId: any, adSetId: any, targeting: any = {}) {
    google.validate(ctx);
    console.info(`[Google Ads] Updating campaign "${campaign.name}" (${platformCampaignId})`);

    // 1. Budget update
    try {
      const rows = await search(ctx, `SELECT campaign.id, campaign.campaign_budget FROM campaign WHERE campaign.id = ${platformCampaignId}`);
      const budgetRn = rows[0]?.campaign?.campaignBudget;
      if (budgetRn && campaign.budgetAmount) {
        const isLifetime = String(campaign.budgetType || "daily").toLowerCase() === "lifetime";
        const micros = String(Math.round(Number(campaign.budgetAmount) * 1_000_000));
        const field = isLifetime ? "totalAmountMicros" : "amountMicros";
        await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaignBudgets:mutate`, {
          operations: [{ update: { resourceName: budgetRn, [field]: micros }, updateMask: field }],
        });
        console.info(`[Google Ads] Budget updated to ${campaign.budgetAmount} (${micros} micros) on ${budgetRn}`);
      }
    } catch (bErr: any) {
      console.info(`[Google Ads Update Warning] Failed updating budget for ${platformCampaignId}: ${bErr.message}`);
    }

    // 2. Schedule (Dates) update — protobuf JSON REST field masks are camelCase: startDateTime, endDateTime
    const upd: any = { resourceName: `customers/${ctx.customerId}/campaigns/${platformCampaignId}` };
    const mask: any[] = [];
    if (campaign.startDate) {
      const start = dateStr(campaign.startDate);
      if (start > today()) {
        upd.startDateTime = `${start} 00:00:00`;
        mask.push("startDateTime");
      }
    }
    if (campaign.endDate) {
      let end = dateStr(campaign.endDate);
      if (end <= today()) end = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      upd.endDateTime = `${end} 23:59:59`;
      mask.push("endDateTime");
    }
    if (mask.length) {
      try {
        await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaigns:mutate`, {
          operations: [{ update: upd, updateMask: mask.join(",") }],
        });
        console.info(`[Google Ads] Schedule updated on campaign ${platformCampaignId}: start=${upd.startDateTime || "unchanged"}, end=${upd.endDateTime}`);
      } catch (sErr: any) {
        console.info(`[Google Ads Update ERROR] Failed updating schedule on ${platformCampaignId}: ${sErr.message}`);
        throw sErr;
      }
    }

    // 3. Keep/Resume Campaign ENABLED (Google keeps expired campaigns as ENDED until schedule is extended and status is set to ENABLED)
    try {
      await google.resumeCampaign(ctx, platformCampaignId);
      console.info(`[Google Ads] Campaign ${platformCampaignId} resumed/ensured ENABLED`);
    } catch (rErr: any) {
      console.info(`[Google Ads Update Warning] Could not resume campaign ${platformCampaignId}: ${rErr.message}`);
    }

    // 4. Targeting (Locations, Languages, Keywords, Search Themes, Demographics, Age, Gender) for ALL Google Ad Types
    let type = String(targeting.campaignType || campaign.campaignType || "").toUpperCase().trim();
    if (!type || type === "UNDEFINED") {
      type = resolveCampaignType(campaign, targeting);
    }
    if (platformCampaignId) {
      try {
        const campSearch = await search(ctx, `SELECT campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${platformCampaignId} LIMIT 1`);
        const act = campSearch[0]?.campaign?.advertisingChannelType;
        if (act) type = act;
      } catch (err: any) {
        // use resolved type
      }
    }
    console.info(`[Google Ads Update] Updating targeting criteria for ${type} campaign (${platformCampaignId})...`);

    try {
      if (type === "PERFORMANCE_MAX") {
        const hasLocOrLang = (Array.isArray(targeting.locations) && targeting.locations.length > 0) || (Array.isArray(targeting.languages) && targeting.languages.length > 0);
        if (hasLocOrLang) {
          const campSearch = await search(ctx, `SELECT campaign_criterion.resource_name, campaign_criterion.type FROM campaign_criterion WHERE campaign.resource_name = 'customers/${ctx.customerId}/campaigns/${platformCampaignId}' AND campaign_criterion.type IN ('LOCATION', 'LANGUAGE')`);
          const removeOps = campSearch.map((r: any) => ({ remove: r.campaignCriterion.resourceName }));
          if (removeOps.length) {
            await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaignCriteria:mutate`, { operations: removeOps }).catch((err: any) => {
              console.info(`[Google Ads Update Warning] Failed removing old campaign criteria: ${err.message}`);
            });

          }
          await applyTargeting(ctx, platformCampaignId, targeting);
        }

        // Update Search Themes for PMax
        let assetGroupRn = adSetId;
        if (assetGroupRn && !String(assetGroupRn).includes("/assetGroups/")) {
          assetGroupRn = `customers/${ctx.customerId}/assetGroups/${assetGroupRn}`;
        }
        if (!assetGroupRn) {
          const agRows = await search(ctx, `SELECT asset_group.resource_name FROM asset_group WHERE campaign.id = ${platformCampaignId} AND asset_group.status != 'REMOVED' LIMIT 1`);
          assetGroupRn = agRows[0]?.assetGroup?.resourceName;
        }

        if (assetGroupRn) {
          await syncPmaxSearchThemes(ctx, assetGroupRn, { targeting, campaign });
        }
      } else {
        // Standard ad group campaigns (SEARCH, DISPLAY, DEMAND_GEN, VIDEO, SHOPPING)
        let adGroupRn = adSetId;
        if (adGroupRn && !String(adGroupRn).includes("/adGroups/")) {
          adGroupRn = `customers/${ctx.customerId}/adGroups/${adGroupRn}`;
        }
        if (!adGroupRn) {
          const agRows = await search(ctx, `SELECT ad_group.resource_name FROM ad_group WHERE campaign.id = ${platformCampaignId} AND ad_group.status != 'REMOVED' LIMIT 1`);
          adGroupRn = agRows[0]?.adGroup?.resourceName;
        }

        if (adGroupRn) {
          // Update CPC bid if targeting.bidAmount is provided for standard campaigns (SEARCH, DISPLAY, SHOPPING)
          if (targeting.bidAmount && (type === "SEARCH" || type === "DISPLAY" || type === "SHOPPING")) {
            const cpcMicros = String(Math.round(Number(targeting.bidAmount) * 1e6));
            await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroups:mutate`, {
              operations: [{ update: { resourceName: adGroupRn, cpcBidMicros: cpcMicros }, updateMask: "cpcBidMicros" }],
            }).catch((err: any) => {
              console.info(`[Google Ads Update Warning] Could not update ad group CPC bid: ${err.message}`);
            });
          }

          // Remove old ad group criteria (keywords, demographics, etc.)
          const agSearch = await search(ctx, `SELECT ad_group_criterion.resource_name, ad_group_criterion.type FROM ad_group_criterion WHERE ad_group.resource_name = '${adGroupRn}' AND ad_group_criterion.type IN ('KEYWORD', 'GENDER', 'AGE_RANGE', 'LOCATION', 'LANGUAGE', 'AUDIENCE', 'USER_INTEREST', 'USER_LIST')`);
          const agRemoveOps = agSearch.map((r: any) => ({ remove: r.adGroupCriterion.resourceName }));
          if (agRemoveOps.length) {
            await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroupCriteria:mutate`, { operations: agRemoveOps }).catch((err: any) => {
              console.info(`[Google Ads Update Warning] Failed removing old ad group criteria: ${err.message}`);
            });
            console.info(`[Google Ads Update] Removed ${agRemoveOps.length} old ad group criteria for ${type}`);
          }

          // Remove old campaign criteria (location, language)
          const campSearch = await search(ctx, `SELECT campaign_criterion.resource_name, campaign_criterion.type FROM campaign_criterion WHERE campaign.resource_name = 'customers/${ctx.customerId}/campaigns/${platformCampaignId}' AND campaign_criterion.type IN ('LOCATION', 'LANGUAGE')`);
          const campRemoveOps = campSearch.map((r: any) => ({ remove: r.campaignCriterion.resourceName }));
          if (campRemoveOps.length) {
            await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaignCriteria:mutate`, { operations: campRemoveOps }).catch((err: any) => {
              console.info(`[Google Ads Update Warning] Failed removing old campaign criteria: ${err.message}`);
            });
            console.info(`[Google Ads Update] Removed ${campRemoveOps.length} old campaign criteria for ${type}`);
          }

          // Apply new targeting criteria
          await applyStandardTargeting(ctx, platformCampaignId, adGroupRn, type, targeting);
        } else {
          console.info(`[Google Ads Update Warning] No ad group found for ${type} campaign ${platformCampaignId}, applying campaign-level targeting`);
          await applyTargeting(ctx, platformCampaignId, targeting);
        }
      }
    } catch (tErr: any) {
      console.info(`[Google Ads Update ERROR] Failed targeting update for campaign ${platformCampaignId}: ${tErr.message}`);
      throw tErr;
    }

    console.info(`[Google Ads] Campaign ${platformCampaignId} (${type}) updated`);
  },

  /**
   * Push changed creative to a live campaign. Google treats most ad fields as immutable once
   * created, so — as reach_be did — ad-group campaigns get their ad removed and rebuilt, while a
   * PMax asset group has only the changed field types swapped: existing links of that type are
   * removed and fresh assets linked, leaving untouched types (and their learning) alone.
   */
  async updateCreative(ctx: GoogleAdsCtx, campaign: any, posts: any, { brand, type, adSetId }: any = {}) {
    google.validate(ctx);
    const first = posts[0];
    if (!first) {
      console.info(`[Google Ads Creative] No post provided to update, skipping creative update`);
      return { skipped: true, reason: "no post" };
    }
    const p = first.post;
    const fv = p.fieldValues || {};

    let kind = String(type || fv.campaignType || first.targeting?.campaignType || "").toUpperCase().trim();
    if (!kind || kind === "UNDEFINED") {
      kind = resolveCampaignType(campaign, first.targeting);
    }
    if (campaign.externalCampaignId) {
      try {
        const campRows = await search(ctx, `SELECT campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${campaign.externalCampaignId} LIMIT 1`);
        const act = campRows[0]?.campaign?.advertisingChannelType;
        if (act) kind = act;
      } catch (err: any) {
        // fallback to kind
      }
    }
    console.info(`[Google Ads] Updating creative for ${kind} campaign ${campaign.externalCampaignId || campaign.id}`);

    let mediaUrlsToUse = first.mediaUrls || [];
    if (fv.imageSet && typeof fv.imageSet === "object") {
      const slotUrls = ["landscape", "square", "portrait", "logo"]
        .map((k: any) => (typeof fv.imageSet[k] === "string" ? fv.imageSet[k] : fv.imageSet[k]?.url))
        .filter(Boolean);
      if (slotUrls.length > 0) {
        mediaUrlsToUse = [...new Set(slotUrls)];
      }
    }

    const texts = buildTexts({ headline: p.headline, title: p.title, body: p.body, description: p.description, headlines: fv.headlines, descriptions: fv.descriptions, longHeadlines: fv.longHeadlines, businessName: fv.businessName, campaignName: campaign.name, brand: brand?.name });
    const finalUrl = [p.destinationUrl, campaign.trackingFinalUrl, campaign.landingPageUrl].map((u: any) => (typeof u === "string" ? u.trim() : "")).find((u: any) => /^https?:\/\/\S+$/i.test(u));
    const logoUrl = fv.logoUrl || brand?.logoUrl;

    try {
      if (kind !== "PERFORMANCE_MAX") {
        let adGroupRn = adSetId;
        if (adGroupRn && !String(adGroupRn).includes("/adGroups/")) {
          adGroupRn = `customers/${ctx.customerId}/adGroups/${adGroupRn}`;
        }
        if (!adGroupRn) {
          const agRows = await search(ctx, `SELECT ad_group.resource_name FROM ad_group WHERE campaign.id = ${campaign.externalCampaignId || 0} AND ad_group.status != 'REMOVED' LIMIT 1`);
          adGroupRn = agRows[0]?.adGroup?.resourceName;
        }
        if (!adGroupRn) throw new Error(`No ad group found to update creative for ${kind} campaign`);

        const ytId = (kind === "VIDEO" || kind === "DEMAND_GEN") ? youtubeIdOf(p, mediaUrlsToUse) : "";
        const youtubeAsset = ytId ? await createYouTubeAsset(ctx, ytId, p.title || campaign.name) : null;
        const needsImages = kind === "DISPLAY" || kind === "DEMAND_GEN";
        let images: ImageAssetsOut = { landscape: [], square: [], portrait: [], logo: [] };
        if (needsImages || (kind === "VIDEO" && logoUrl)) {
          try {
            images = await buildImageAssets(ctx, needsImages ? mediaUrlsToUse : [], { logoUrl, name: p.title || campaign.name, imageSet: fv.imageSet });
          } catch (e: any) {
            if (needsImages && !youtubeAsset) throw e;
          }
        }
        const adOps = buildStandardAds({ type: kind, adGroupRn, finalUrl, texts, images, post: p, youtubeAsset });
        const ad = await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroupAds:mutate`, { operations: adOps.map((create: any) => ({ create })) });
        const newAds = (ad?.results || []).map((r: any) => r?.resourceName).filter(Boolean);
        // Only retire old ads once replacement exists
        const old = (await search(ctx, `SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE ad_group.resource_name = '${adGroupRn}' AND ad_group_ad.status != 'REMOVED'`)).map((r: any) => r.adGroupAd?.resourceName).filter((rn: any) => rn && !newAds.includes(rn));
        if (old.length) {
          try {
            await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroupAds:mutate`, { operations: old.map((rn: any) => ({ remove: rn })) });
          } catch (remErr: any) {
            await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/adGroupAds:mutate`, {
              operations: old.map((rn: any) => ({ update: { resourceName: rn, status: "PAUSED" }, updateMask: "status" })),
            }).catch(() => {});
          }
        }
        console.info(`[Google Ads] Created replacement ad(s) for ${kind}: ${newAds.join(", ")}, removed/paused ${old.length} old ad(s)`);
        return { adIds: newAds, replaced: old.length, texts };
      }

      const agRn = String(adSetId || "").includes("/assetGroups/") ? adSetId : (await search(ctx, `SELECT asset_group.resource_name FROM asset_group WHERE campaign.id = ${campaign.externalCampaignId || 0} ORDER BY asset_group.id DESC LIMIT 1`))[0]?.assetGroup?.resourceName;
      if (!agRn) throw new Error("No asset group found to update on this Performance Max campaign");
      
      const links: any[] = await search(ctx, `SELECT asset_group_asset.resource_name, asset_group_asset.field_type, asset_group_asset.status, asset.text_asset.text, asset.name FROM asset_group_asset WHERE asset_group.resource_name = '${agRn}' AND asset_group_asset.status != 'REMOVED'`);
      
      const existingTexts = (fieldType: any) => {
        const set = new Set();
        for (const link of links) {
          const ft = String(link.assetGroupAsset?.fieldType || link.fieldType || "").toUpperCase();
          const text = (link.asset?.textAsset?.text || "").trim();
          if (ft === fieldType && text) set.add(text);
        }
        return set;
      };

      const existingLinksByType = (fieldType: any) => links.filter((link: any) => {
        const ft = String(link.assetGroupAsset?.fieldType || link.fieldType || "").toUpperCase();
        return ft === fieldType;
      });

      const effectiveHeadlines = (Array.isArray(fv.headlines) && fv.headlines.length) ? fv.headlines : (Array.isArray(p.headlines) && p.headlines.length ? p.headlines : null);
      const effectiveDescriptions = (Array.isArray(fv.descriptions) && fv.descriptions.length) ? fv.descriptions : (Array.isArray(p.descriptions) && p.descriptions.length ? p.descriptions : null);
      const effectiveLongHeadlines = (Array.isArray(fv.longHeadlines) && fv.longHeadlines.length) ? fv.longHeadlines : (Array.isArray(p.longHeadlines) && p.longHeadlines.length ? p.longHeadlines : null);

      const pmaxTextInput = {
        headline: (effectiveHeadlines && effectiveHeadlines[0]) || p.headline,
        content: p.content || p.body,
        description: (effectiveDescriptions && effectiveDescriptions[0]) || p.description,
        headlines: effectiveHeadlines,
        descriptions: effectiveDescriptions,
        longHeadline: (effectiveLongHeadlines && effectiveLongHeadlines[0]) || fv.longHeadline || p.longHeadline,
        longHeadlines: effectiveLongHeadlines,
        businessName: fv.businessName || p.businessName || brand?.name,
        postName: p.title || p.name,
        campaignName: campaign.name,
      };
      const rawHeadlines = buildPMaxHeadlines(pmaxTextInput);
      const rawLongHeadlines = buildPMaxLongHeadlines(pmaxTextInput);
      const rawDescriptions = buildPMaxDescriptions(pmaxTextInput);
      const rawBusinessName = buildPMaxBusinessName(pmaxTextInput);

      const headlinesChanged =
        rawHeadlines.some((h: any) => !existingTexts("HEADLINE").has(h.trim())) ||
        rawHeadlines.length !== existingLinksByType("HEADLINE").length;
      const longHeadlinesChanged =
        rawLongHeadlines.some((h: any) => !existingTexts("LONG_HEADLINE").has(h.trim())) ||
        rawLongHeadlines.length !== existingLinksByType("LONG_HEADLINE").length;
      const descriptionsChanged =
        rawDescriptions.some((d: any) => !existingTexts("DESCRIPTION").has(d.trim())) ||
        rawDescriptions.length !== existingLinksByType("DESCRIPTION").length;
      const businessNameChanged = !existingTexts("BUSINESS_NAME").has(rawBusinessName.trim());

      console.info(
        `[Google Ads Creative] PMax changes detected: headlines=${headlinesChanged}, longHeadlines=${longHeadlinesChanged}, descriptions=${descriptionsChanged}, businessName=${businessNameChanged}`
      );

      if (!mediaUrlsToUse.length && fv.imageSet && typeof fv.imageSet === "object") {
        const slotUrls = ["landscape", "square", "portrait", "logo"]
          .map((k: any) => (typeof fv.imageSet[k] === "string" ? fv.imageSet[k] : fv.imageSet[k]?.url))
          .filter(Boolean);
        if (slotUrls.length > 0) {
          mediaUrlsToUse = [...new Set(slotUrls)];
        }
      }

      const hasMedia = mediaUrlsToUse.length > 0 || Boolean(fv.imageSet);
      let images: ImageAssetsOut = { landscape: [], square: [], portrait: [], logo: [] };
      if (hasMedia) {
        images = await buildImageAssets(ctx, mediaUrlsToUse, {
          logoUrl,
          name: p.title || campaign.name,
          imageSet: fv.imageSet,
        });
      }
      const imagesChanged =
        hasMedia &&
        (images.landscape.length > 0 || images.square.length > 0 || images.portrait.length > 0);
      const logoChanged = hasMedia && images.logo.length > 0;

      const updatedFieldTypes = new Set();
      if (headlinesChanged) updatedFieldTypes.add("HEADLINE");
      if (longHeadlinesChanged) updatedFieldTypes.add("LONG_HEADLINE");
      if (descriptionsChanged) updatedFieldTypes.add("DESCRIPTION");
      if (businessNameChanged) updatedFieldTypes.add("BUSINESS_NAME");
      if (imagesChanged) {
        if (images.landscape.length > 0) updatedFieldTypes.add("MARKETING_IMAGE");
        if (images.square.length > 0) updatedFieldTypes.add("SQUARE_MARKETING_IMAGE");
        if (images.portrait.length > 0) updatedFieldTypes.add("PORTRAIT_MARKETING_IMAGE");
      }
      if (logoChanged) updatedFieldTypes.add("LOGO");

      const mutateOperations: any[] = [];

      if (finalUrl) {
        mutateOperations.push({
          assetGroupOperation: {
            update: { resourceName: agRn, finalUrls: [finalUrl] },
            updateMask: "finalUrls",
          },
        });
      }

      // REMOVES FIRST (ported directly from ReachGit)
      const rawHeadlinesSet = new Set(rawHeadlines.map((h: any) => h.trim().toLowerCase()));
      const rawLongHeadlinesSet = new Set(rawLongHeadlines.map((lh: any) => lh.trim().toLowerCase()));
      const rawDescriptionsSet = new Set(rawDescriptions.map((d: any) => d.trim().toLowerCase()));

      for (const link of links) {
        const resourceName =
          link.assetGroupAsset?.resourceName ||
          link.assetGroupAsset?.resource_name ||
          link.resourceName ||
          link.resource_name;
        const rawFt =
          link.assetGroupAsset?.fieldType ||
          link.assetGroupAsset?.field_type ||
          link.fieldType ||
          link.field_type ||
          "";
        const fieldType = String(rawFt).toUpperCase();
        const status = String(link.assetGroupAsset?.status || link.status || "").toUpperCase();
        const text = (
          link.asset?.textAsset?.text ||
          link.asset?.text_asset?.text ||
          ""
        ).trim().toLowerCase();

        if (!resourceName || !fieldType || status === "REMOVED") continue;

        if (fieldType === "HEADLINE" && headlinesChanged) {
          if (!rawHeadlinesSet.has(text)) {
            mutateOperations.push({ assetGroupAssetOperation: { remove: resourceName } });
          }
        } else if (fieldType === "LONG_HEADLINE" && longHeadlinesChanged) {
          if (!rawLongHeadlinesSet.has(text)) {
            mutateOperations.push({ assetGroupAssetOperation: { remove: resourceName } });
          }
        } else if (fieldType === "DESCRIPTION" && descriptionsChanged) {
          if (!rawDescriptionsSet.has(text)) {
            mutateOperations.push({ assetGroupAssetOperation: { remove: resourceName } });
          }
        } else if (
          updatedFieldTypes.has(fieldType) &&
          fieldType !== "HEADLINE" &&
          fieldType !== "DESCRIPTION" &&
          fieldType !== "LONG_HEADLINE"
        ) {
          mutateOperations.push({ assetGroupAssetOperation: { remove: resourceName } });
        }
      }

      // CREATES SECOND (ported directly from ReachGit)
      if (headlinesChanged) {
        const newHeadlines = rawHeadlines
          .slice(0, 15)
          .filter((h: any) => !existingTexts("HEADLINE").has(h.trim()));
        for (const hText of newHeadlines) {
          try {
            const assetRn = await createTextAsset(ctx, hText);
            mutateOperations.push({
              assetGroupAssetOperation: {
                create: { assetGroup: agRn, asset: assetRn, fieldType: "HEADLINE" },
              },
            });
          } catch (e: any) {
            console.info(`[Google Ads Creative Warning] Could not create headline asset "${hText}": ${e.message}`);
          }
        }
      }

      if (longHeadlinesChanged) {
        const newLongHeadlines = rawLongHeadlines
          .slice(0, 5)
          .filter((lh: any) => !existingTexts("LONG_HEADLINE").has(lh.trim()));
        for (const lhText of newLongHeadlines) {
          try {
            const assetRn = await createTextAsset(ctx, lhText);
            mutateOperations.push({
              assetGroupAssetOperation: {
                create: { assetGroup: agRn, asset: assetRn, fieldType: "LONG_HEADLINE" },
              },
            });
          } catch (e: any) {
            console.info(`[Google Ads Creative Warning] Could not create long headline asset "${lhText}": ${e.message}`);
          }
        }
      }

      if (descriptionsChanged) {
        const newDescriptions = rawDescriptions
          .slice(0, 5)
          .filter((d: any) => !existingTexts("DESCRIPTION").has(d.trim()));
        for (const dText of newDescriptions) {
          try {
            const assetRn = await createTextAsset(ctx, dText);
            mutateOperations.push({
              assetGroupAssetOperation: {
                create: { assetGroup: agRn, asset: assetRn, fieldType: "DESCRIPTION" },
              },
            });
          } catch (e: any) {
            console.info(`[Google Ads Creative Warning] Could not create description asset "${dText}": ${e.message}`);
          }
        }
      }

      if (businessNameChanged) {
        try {
          const assetRn = await createTextAsset(ctx, rawBusinessName);
          if (assetRn) {
            mutateOperations.push({
              assetGroupAssetOperation: {
                create: { assetGroup: agRn, asset: assetRn, fieldType: "BUSINESS_NAME" },
              },
            });
          }
        } catch (e: any) {
          console.info(`[Google Ads Creative Warning] Could not create business name asset: ${e.message}`);
        }
      }

      if (imagesChanged) {
        for (const a of [...new Set(images.landscape)].slice(0, 20)) {
          mutateOperations.push({ assetGroupAssetOperation: { create: { assetGroup: agRn, asset: a, fieldType: "MARKETING_IMAGE" } } });
        }
        for (const a of [...new Set(images.square)].slice(0, 20)) {
          mutateOperations.push({ assetGroupAssetOperation: { create: { assetGroup: agRn, asset: a, fieldType: "SQUARE_MARKETING_IMAGE" } } });
        }
        for (const a of [...new Set(images.portrait)].slice(0, 20)) {
          mutateOperations.push({ assetGroupAssetOperation: { create: { assetGroup: agRn, asset: a, fieldType: "PORTRAIT_MARKETING_IMAGE" } } });
        }
      }

      if (logoChanged) {
        for (const a of [...new Set(images.logo)].slice(0, 5)) {
          mutateOperations.push({ assetGroupAssetOperation: { create: { assetGroup: agRn, asset: a, fieldType: "LOGO" } } });
        }
      }

      const ytId = youtubeIdOf(p, mediaUrlsToUse);
      if (ytId) {
        try {
          const ytAsset = await createYouTubeAsset(ctx, ytId, p.title || campaign.name);
          mutateOperations.push({ assetGroupAssetOperation: { create: { assetGroup: agRn, asset: ytAsset, fieldType: "YOUTUBE_VIDEO" } } });
        } catch (e: any) {
          console.warn(`[PMax Update] Could not attach YouTube video asset: ${e?.message}`);
        }
      }

      // SAFEGUARD VALIDATION (ported directly from ReachGit)
      const minRequirements = {
        HEADLINE: 3,
        LONG_HEADLINE: 1,
        DESCRIPTION: 2,
        MARKETING_IMAGE: 1,
        SQUARE_MARKETING_IMAGE: 1,
        LOGO: 1,
      };
      const removedResourceNames = new Set(
        mutateOperations
          .filter((op: any) => op.assetGroupAssetOperation?.remove)
          .map((op: any) => op.assetGroupAssetOperation.remove)
      );
      const finalCounts: Record<string, number> = {};
      Object.keys(minRequirements).forEach((fieldType: any) => {
        const createdCount = mutateOperations.filter(
          (op: any) => op.assetGroupAssetOperation?.create?.fieldType === fieldType
        ).length;
        const keptExistingCount = links.filter((link: any) => {
          const resourceName =
            link.assetGroupAsset?.resourceName ||
            link.assetGroupAsset?.resource_name ||
            link.resourceName ||
            link.resource_name;
          const ft = String(
            link.assetGroupAsset?.fieldType ||
            link.assetGroupAsset?.field_type ||
            link.fieldType ||
            link.field_type ||
            ""
          ).toUpperCase();
          const status = String(link.assetGroupAsset?.status || link.status || "").toUpperCase();
          return ft === fieldType && status !== "REMOVED" && !removedResourceNames.has(resourceName);
        }).length;
        finalCounts[fieldType] = keptExistingCount + createdCount;
      });

      const validationErrors: any[] = [];
      Object.entries(minRequirements).forEach(([fieldType, min]: any) => {
        const count = finalCounts[fieldType] || 0;
        if (count < min) {
          validationErrors.push(`${fieldType}: required min ${min}, but final count is ${count}`);
        }
      });
      if (validationErrors.length > 0) {
        console.error(`[PMax Update Safeguard] Validation failed for Asset Group ${agRn}: ${validationErrors.join("; ")}`);
        throw new Error(
          `Google Ads API validation error: Update blocked because asset requirements would not be met (${validationErrors.join("; ")}). Please attach required assets before pushing.`
        );
      }

      if (mutateOperations.length) {
        console.info(
          `[PMax Update] Sending ${mutateOperations.length} mutate operations (REMOVES first, CREATES second) for field types: ${[...updatedFieldTypes].join(", ") || "none (URL only)"}`
        );
        await request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/googleAds:mutate`, { mutateOperations });
      }

      console.info(`[Google Ads] Updated PMax creative assets on ${agRn}`);
      return {
        adIds: [agRn],
        texts: {
          headlines: rawHeadlines,
          longHeadlines: rawLongHeadlines,
          descriptions: rawDescriptions,
          businessName: rawBusinessName,
        },
      };
    } catch (cErr: any) {
      console.info(`[Google Ads Creative ERROR] Failed updating creative for ${campaign.externalCampaignId}: ${cErr.message}`);
      throw cErr;
    }
  },

  pauseCampaign: (ctx: GoogleAdsCtx, id: any) => request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaigns:mutate`, { operations: [{ update: { resourceName: `customers/${ctx.customerId}/campaigns/${id}`, status: "PAUSED" }, updateMask: "status" }] }),
  resumeCampaign: (ctx: GoogleAdsCtx, id: any) => request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaigns:mutate`, { operations: [{ update: { resourceName: `customers/${ctx.customerId}/campaigns/${id}`, status: "ENABLED" }, updateMask: "status" }] }),
  removeCampaign: (ctx: GoogleAdsCtx, id: any) => request(ctx, "POST", `${base(ctx)}/customers/${ctx.customerId}/campaigns:mutate`, { operations: [{ remove: `customers/${ctx.customerId}/campaigns/${id}` }] }),

  /**
   * Reach/frequency, mirroring reach_be. Two constraints from Google, both learnt the hard way:
   * `segments.date` may not appear in the SELECT (the metrics are per-user, not per-day), and
   * `unique_users` only exists for Display, Video, Discovery and App campaigns — anything else
   * errors. Google also refuses ranges over 92 days. A failure here is never fatal: the daily
   * metrics are the real payload, so we return nothing and carry on.
   */
  async getReachMetrics(ctx: GoogleAdsCtx, platformCampaignId: any, { since, until }: any) {
    let qSince = since;
    const spanDays = (new Date(until).getTime() - new Date(since).getTime()) / 86_400_000;
    if (spanDays > 92) {
      qSince = new Date(new Date(until).getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    }
    try {
      const rows = await search(ctx, `SELECT campaign.id, metrics.unique_users, metrics.average_impression_frequency_per_user FROM campaign WHERE campaign.id = ${platformCampaignId} AND segments.date BETWEEN '${qSince}' AND '${until}'`);
      let reach = 0, freqSum = 0, freqCount = 0;
      for (const r of rows) {
        const m = r.metrics || {};
        const u = parseInt(m.uniqueUsers || "0", 10);
        const f = parseFloat(m.averageImpressionFrequencyPerUser || "0");
        if (u > 0) reach += u;
        if (f > 0) { freqSum += f; freqCount += 1; }
      }
      return { reach: reach || undefined, frequency: freqCount ? Number((freqSum / freqCount).toFixed(2)) : undefined };
    } catch { return {}; }
  },

  async getCampaignStats(ctx: GoogleAdsCtx, platformCampaignId: any, { since, until }: any) {
    google.validate(ctx);
    const rows = await search(ctx, `SELECT campaign.id, campaign.status, campaign.primary_status, campaign.primary_status_reasons, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.video_trueview_views, metrics.engagements, metrics.interactions FROM campaign WHERE campaign.id = ${platformCampaignId} AND segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date ASC`);
    const c = rows[0]?.campaign || {}; const prim = String(c.primaryStatus || ""); const reasons = c.primaryStatusReasons || [];
    const status = c.status === "REMOVED" ? { status: "completed" } : c.status === "PAUSED" ? { status: "paused" } : ["NOT_ELIGIBLE", "MISCONFIGURED", "LIMITED"].includes(prim) && reasons.length ? { status: prim === "LIMITED" ? "live" : "failed", reason: reasons.map((r: any) => String(r).toLowerCase().replace(/_/g, " ")).join(", ") } : prim === "PENDING" ? { status: "publishing", reason: "Pending review at Google" } : prim === "ENDED" ? { status: "completed" } : { status: "live" };
    const daily = rows.filter((r: any) => r.segments?.date).map((r: any) => { const m = r.metrics || {}; const spend = parseInt(m.costMicros || "0", 10) / 1_000_000; return { date: r.segments.date, impressions: parseInt(m.impressions || "0", 10), clicks: parseInt(m.clicks || "0", 10), spend: Number(spend.toFixed(4)), conversions: parseFloat(m.conversions || "0"), revenue: Number(parseFloat(m.conversionsValue || "0").toFixed(2)), reach: 0, frequency: 0, videoViews: parseInt(m.videoTrueviewViews || "0", 10), engagements: parseInt(m.engagements || m.interactions || "0", 10) }; });
    // Reach and frequency are per-user aggregates: they are not summable across days, so they
    // come from a second, unsegmented query and land on the range as a whole.
    const totals = await google.getReachMetrics(ctx, platformCampaignId, { since, until });
    return { daily, status, ...totals };
  },
};
