// Microsoft Advertising (Bing Ads) campaign provider.
// Port of the old lib_campaign-providers_bing.js (v13 CampaignManagement SOAP API)
// to TypeScript for Cloudflare Workers.
// ctx = { accessToken, adAccountId: "...", developerToken, currency, country, customerId, ... }
//
// Worker notes:
// - No `sharp`: images are fetched and uploaded as-is (resize skipped on Workers).
// - No Node APIs (`Buffer`, `process.env`): tokens/URLs are read from `ctx` only,
//   image bytes are handled as Uint8Array, base64 via btoa/atob helpers.

export interface BingAdsCtx extends Record<string, any> {
  accessToken: string;
  adAccountId: string | number;
  developerToken?: string;
  currency?: string;
  country?: string;
  customerId?: string;
  /** Base URL used to fetch relative image paths (replaces process.env.APP_URL/PUBLIC_URL). */
  appUrl?: string;
  publicUrl?: string;
}

const BING_ADS_SOAP_API =
  "https://campaign.api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/CampaignManagementService.svc";

function escapeXml(unsafe: string | null | undefined): string {
  return (unsafe || "").replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}

function extractId(xml: string, tag: string): string | null {
  const regex = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>(\\d+)<\\/(?:[\\w-]+:)?${tag}>`);
  const match = xml.match(regex);
  return match && match[1] ? match[1] : null;
}

function extractBatchError(xml: string): string | null {
  const regex = /<Message>([^<]+)<\/Message>/;
  const match = xml.match(regex);
  return match && match[1] ? match[1] : null;
}

function getBingLanguage(code?: string | null): string {
  if (!code) return "English";
  const map: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    ar: "Arabic",
    zh: "TraditionalChinese",
    ja: "Japanese",
    ru: "Russian",
    nl: "Dutch",
    sv: "Swedish",
  };
  const key = String(code).toLowerCase().substring(0, 2);
  return map[key] || "English";
}

function getBingLocationId(countryCode?: string | null): string | null {
  if (!countryCode) return null;
  const raw = String(countryCode).toLowerCase().trim();
  const map: Record<string, string> = {
    us: "190",
    "2840": "190",
    "united states": "190",
    gb: "32",
    uk: "32",
    "2826": "32",
    "united kingdom": "32",
    ca: "35",
    "2124": "35",
    canada: "35",
    au: "9",
    "2036": "9",
    australia: "9",
    in: "104",
    "2356": "104",
    india: "104",
    de: "63",
    "2276": "63",
    germany: "63",
    fr: "73",
    "2250": "73",
    france: "73",
    br: "27",
    "2076": "27",
    brazil: "27",
    mx: "146",
    "2484": "146",
    mexico: "146",
    it: "106",
    "2380": "106",
    italy: "106",
    es: "197",
    "2724": "197",
    spain: "197",
    jp: "109",
    "2392": "109",
    japan: "109",
    za: "201",
    "2710": "201",
    "south africa": "201",
    se: "181",
    "2752": "181",
    sweden: "181",
    nl: "150",
    "2528": "150",
    netherlands: "150",
    no: "154",
    "2578": "154",
    norway: "154",
    dk: "55",
    "2208": "55",
    denmark: "55",
    fi: "71",
    "2246": "71",
    finland: "71",
    ch: "182",
    "2756": "182",
    switzerland: "182",
    at: "11",
    "2040": "11",
    austria: "11",
    be: "19",
    "2056": "19",
    belgium: "19",
    ie: "101",
    "2372": "101",
    ireland: "101",
    pt: "164",
    "2620": "164",
    portugal: "164",
    nz: "152",
    "2554": "152",
    "new zealand": "152",
    pl: "162",
    "2616": "162",
    poland: "162",
    sg: "185",
    "2702": "185",
    singapore: "185",
    ae: "219",
    "2784": "219",
    "united arab emirates": "219",
    sa: "180",
    "2682": "180",
    "saudi arabia": "180",
    tr: "218",
    "2792": "218",
    turkey: "218",
  };
  const hit = map[raw];
  if (hit) return hit;
  // If it is already a known Bing location ID
  if (Object.values(map).includes(raw)) return raw;
  return null;
}

function getBingAgeRanges(ages?: unknown): string[] {
  if (!ages || !Array.isArray(ages)) return [];
  const bingAges = new Set<string>();
  for (const age of ages) {
    const a = String(age).toLowerCase();
    if (a.includes("18") || a.includes("20")) bingAges.add("EighteenToTwentyFour");
    if (a.includes("25") || a.includes("30")) bingAges.add("TwentyFiveToThirtyFour");
    if (a.includes("35") || a.includes("40")) bingAges.add("ThirtyFiveToFortyNine");
    if (a.includes("45") || a.includes("50")) bingAges.add("FiftyToSixtyFour");
    if (a.includes("55") || a.includes("60")) bingAges.add("FiftyToSixtyFour");
    if (a.includes("65") || a.includes("old")) bingAges.add("SixtyFiveAndAbove");
  }
  return Array.from(bingAges);
}

function buildHeadlinesXml(headline?: any, content?: any, rawHeadlines?: any): string {
  const lines: string[] = [];
  if (Array.isArray(rawHeadlines) && rawHeadlines.length > 0) {
    lines.push(...rawHeadlines.map((h) => String(h).trim().substring(0, 30)));
  }
  if (headline) lines.push(String(headline).trim().substring(0, 30));
  if (content) {
    const parts = String(content)
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 3 && s.length <= 30);
    lines.push(...parts);
  }

  const fallbacks = [
    "Learn More Today",
    "Discover Our Offers",
    "Exclusive Deal",
    "Limited Time Offer",
    "Sign Up Now",
  ];

  let uniqueLines = Array.from(new Set(lines.filter(Boolean)));
  for (const fb of fallbacks) {
    if (uniqueLines.length >= 3) break;
    if (!uniqueLines.includes(fb)) uniqueLines.push(fb);
  }
  uniqueLines = uniqueLines.slice(0, 15);

  return uniqueLines
    .map(
      (line) => `
      <AssetLink>
        <Asset i:type="TextAsset">
          <Text>${escapeXml(line)}</Text>
        </Asset>
      </AssetLink>`
    )
    .join("");
}

function buildDescriptionsXml(content?: any, description?: any, rawDescriptions?: any, maxCount = 4): string {
  const lines: string[] = [];
  if (Array.isArray(rawDescriptions) && rawDescriptions.length > 0) {
    lines.push(...rawDescriptions.map((d) => String(d).trim().substring(0, 90)));
  }
  if (description) lines.push(String(description).trim().substring(0, 90));
  if (content) {
    const trimmed = String(content).trim();
    if (trimmed.length <= 90) {
      lines.push(trimmed);
    } else {
      lines.push(trimmed.substring(0, 90));
      lines.push(trimmed.substring(90, 180));
    }
  }

  const fallbacks = [
    "Learn more about our incredible services today. Click here to get started!",
    "Check out what we have to offer and take advantage of our deals now.",
  ];

  let uniqueLines = Array.from(new Set(lines.filter(Boolean)));
  for (const fb of fallbacks) {
    if (uniqueLines.length >= 2) break;
    if (!uniqueLines.includes(fb)) uniqueLines.push(fb);
  }
  // Microsoft Advertising limits:
  // ResponsiveSearchAd: max 4 descriptions (min 2)
  // PerformanceMax AssetGroup: max 5 descriptions (min 1)
  uniqueLines = uniqueLines.slice(0, maxCount);

  return uniqueLines
    .map(
      (line) => `
      <AssetLink>
        <Asset i:type="TextAsset">
          <Text>${escapeXml(line)}</Text>
        </Asset>
      </AssetLink>`
    )
    .join("");
}

function buildLongHeadlinesXml(rawLongHeadlines?: any, fallbackHeadline?: any, fallbackDescription?: any): string {
  const lines: string[] = [];
  if (Array.isArray(rawLongHeadlines) && rawLongHeadlines.length > 0) {
    lines.push(...rawLongHeadlines.map((lh) => String(lh).trim().substring(0, 90)));
  } else if (typeof rawLongHeadlines === "string" && rawLongHeadlines.trim()) {
    lines.push(rawLongHeadlines.trim().substring(0, 90));
  }
  if (fallbackDescription) {
    lines.push(String(fallbackDescription).trim().substring(0, 90));
  }
  if (fallbackHeadline) {
    lines.push(String(fallbackHeadline).trim().substring(0, 90));
  }

  const fallbacks = [
    "Discover exceptional quality and exclusive offers designed for you today.",
    "Explore our complete collection and find the perfect match for your style.",
  ];

  let uniqueLines = Array.from(new Set(lines.filter(Boolean)));
  for (const fb of fallbacks) {
    if (uniqueLines.length >= 1) break;
    if (!uniqueLines.includes(fb)) uniqueLines.push(fb);
  }
  uniqueLines = uniqueLines.slice(0, 5);

  return uniqueLines
    .map(
      (line) => `
      <AssetLink>
        <Asset i:type="TextAsset">
          <Text>${escapeXml(line)}</Text>
        </Asset>
      </AssetLink>`
    )
    .join("");
}

export function extractKeywords(
  campaign?: any,
  post: any = {},
  targeting: any = {},
  adSet: any = {}
): string[] {
  const sources = [
    targeting?.keywords,
    targeting?.searchThemes,
    campaign?.targeting?.keywords,
    campaign?.targeting?.searchThemes,
    campaign?.draftState?.targeting?.keywords,
    campaign?.draftState?.targeting?.searchThemes,
    campaign?.draftState?.audience?.keywords,
    campaign?.audience?.keywords,
    post?.fieldValues?.keywords,
    post?.fieldValues?.searchThemes,
    post?.keywords,
    adSet?.targeting?.keywords,
    adSet?.targeting?.searchThemes,
  ];

  const all: string[] = [];
  for (const s of sources) {
    if (Array.isArray(s)) {
      all.push(...s);
    } else if (typeof s === "string" && s.trim()) {
      all.push(s.trim());
    }
  }

  // Also if audience has interest names (since Bing has no native interest taxonomy in Search):
  const interests = campaign?.draftState?.audience?.interests || campaign?.audience?.interests;
  if (Array.isArray(interests)) {
    for (const item of interests) {
      if (typeof item === "string") all.push(item);
      else if (item?.name) all.push(item.name);
    }
  }

  // Fallbacks: if no keywords found at all, derive from campaign name, headline, business name
  if (all.length === 0) {
    const fallbackSeed = post?.headline || post?.title || campaign?.name || "marketing";
    const cleanedSeed = String(fallbackSeed).replace(/[^a-zA-Z0-9 ]/g, " ").trim();
    if (cleanedSeed) {
      all.push(cleanedSeed);
    }
  }

  return Array.from(new Set(all.map((k) => String(k).trim()).filter(Boolean)));
}

export async function addKeywordsToAdGroup(
  ctx: BingAdsCtx,
  adGroupId: string | number,
  rawKeywords: any[] = [],
  bidAmount = 1,
  landingPageUrl: string | null = null
): Promise<string[]> {
  if (!adGroupId) return [];
  const list = Array.isArray(rawKeywords) ? rawKeywords : [rawKeywords];
  const cleaned: { text: string; matchType: string }[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!item) continue;
    let text = String(item).trim();
    if (!text) continue;

    let matchType = "Broad";
    if (text.startsWith("[") && text.endsWith("]")) {
      matchType = "Exact";
      text = text.slice(1, -1).trim();
    } else if (text.startsWith('"') && text.endsWith('"')) {
      matchType = "Phrase";
      text = text.slice(1, -1).trim();
    }

    // Clean text: remove control characters, limit to 100 chars
    text = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").substring(0, 100).trim();
    if (!text) continue;

    const key = `${matchType}:${text.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      cleaned.push({ text, matchType });
    }
  }

  if (cleaned.length === 0) {
    return [];
  }

  const bid = Number(bidAmount) > 0 ? Number(bidAmount) : 1;
  const createdKeywordIds: string[] = [];

  let cleanLp = String(landingPageUrl || "").trim();
  if (cleanLp && !cleanLp.startsWith("http://") && !cleanLp.startsWith("https://")) {
    cleanLp = `https://${cleanLp}`;
  }
  const finalUrlsXml = cleanLp
    ? `<FinalUrls xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><a:string>${escapeXml(cleanLp)}</a:string></FinalUrls>`
    : "";

  // Batch in chunks of 1000 (Bing API limit)
  for (let i = 0; i < cleaned.length; i += 1000) {
    const chunk = cleaned.slice(i, i + 1000);
    const keywordsXml = chunk
      .map(
        (kw) => `
          <Keyword>
            <Bid><Amount>${bid.toFixed(2)}</Amount></Bid>
            ${finalUrlsXml}
            <MatchType>${kw.matchType}</MatchType>
            <Status>Active</Status>
            <Text>${escapeXml(kw.text)}</Text>
          </Keyword>
        `
      )
      .join("");

    const bodyXml = `
      <AddKeywordsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
        <AdGroupId>${adGroupId}</AdGroupId>
        <Keywords>
          ${keywordsXml}
        </Keywords>
      </AddKeywordsRequest>
    `;

    try {
      const responseXml = await makeSoapRequest(ctx, "AddKeywords", bodyXml);
      const matches = responseXml.matchAll(/<(?:[\w-]+:)?long[^>]*>(\d+)<\/(?:[\w-]+:)?long>/g);
      for (const m of matches) {
        if (m[1]) createdKeywordIds.push(m[1]);
      }
    } catch (err: any) {
      if (err?.message && err.message.includes("1542")) {
        console.warn(`[Bing Ads] Some keywords already exist in ad group ${adGroupId}`);
      } else {
        console.error(`[Bing Ads] Failed to add keywords chunk to ad group ${adGroupId}:`, err?.message || err);
      }
    }
  }

  return createdKeywordIds;
}

export async function makeSoapRequest(
  ctx: BingAdsCtx,
  action: string,
  bodyXml: string
): Promise<string> {
  const token = String(ctx.accessToken || "").split(":::")[0];
  const accountId = String(ctx.adAccountId || "").replace(/[^0-9]/g, "");
  if (!accountId) {
    throw new Error(
      "Microsoft Advertising Account ID is missing or invalid. Enter your numeric Account ID in Connections."
    );
  }
  // Developer token comes from ctx only (no process.env on Workers).
  const devToken = ctx.developerToken || "145DN08F29379687";

  const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
    <AuthenticationToken>${token}</AuthenticationToken>
    <CustomerAccountId>${accountId}</CustomerAccountId>
    <DeveloperToken>${devToken}</DeveloperToken>
  </s:Header>
  <s:Body>
    ${bodyXml}
  </s:Body>
</s:Envelope>`;

  const response = await fetch(BING_ADS_SOAP_API, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: action,
    },
    body: soapEnvelope,
    signal: AbortSignal.timeout(45000),
  });

  const text = await response.text();

  if (!response.ok || text.includes("<s:Fault>")) {
    const faultStringMatch = text.match(/<faultstring[^>]*>(.*?)<\/faultstring>/i);
    const messageMatch = text.match(/<Message>(.*?)<\/Message>/i);
    const codeMatch = text.match(/<ErrorCode>(.*?)<\/ErrorCode>/i);

    let errorMsg = "Unknown SOAP Error";
    if (messageMatch && messageMatch[1]) {
      errorMsg = codeMatch && codeMatch[1] ? `${codeMatch[1]}: ${messageMatch[1]}` : messageMatch[1];
    } else if (faultStringMatch && faultStringMatch[1]) {
      errorMsg = faultStringMatch[1];
    }
    throw new Error(`Bing Ads API Error: ${errorMsg}`);
  }

  return text;
}

const BING_VALID_CTAS = new Set([
  "ActNow", "AddToCart", "Apply", "ApplyNow", "Attend", "Automated", "BetNow", "BidNow",
  "BookACar", "BookHotel", "BookNow", "BookTravel", "Browse", "BuildNow", "Buy", "BuyNow",
  "ChatNow", "Compare", "ContactUs", "Coupon", "CustomText", "Dealers", "Default",
  "Directions", "Discover", "Dismiss", "Donate", "Download", "EmailNow", "EnrollNow",
  "Explore", "FileNow", "FindJob", "FindStore", "FreePlay", "FreeQuote", "FreeTrial",
  "GetDeals", "GetDemo", "GetNow", "GetOffer", "GetQuote", "GoToDemo", "Install", "Join",
  "JoinNow", "LearnMore", "ListenNow", "LogIn", "Message", "NewCars", "NoButton", "OpenLink",
  "OrderNow", "PlayGame", "PlayNow", "PostJob", "Register", "RegisterNow", "RenewNow",
  "RentACar", "RentNow", "Reorder", "RequestDemo", "Reserve", "Sale", "SaveNow", "Schedule",
  "SeeDemo", "SeeMenu", "SeeModels", "SeeMore", "SeeOffer", "SeeOffers", "SellNow", "ShopNow",
  "Showtimes", "SignIn", "SignUp", "StartFree", "StartNow", "Subscribe", "SwitchNow",
  "TestDrive", "TryNow", "Unknown", "UsedCars", "ViewCars", "ViewDemo", "ViewNow",
  "ViewPlans", "ViewQuote", "VisitSite", "VisitStore", "VoteNow", "Watch", "WatchMore", "WatchNow"
]);

const BING_CTA_MAP = new Map<string, string>();
for (const cta of BING_VALID_CTAS) {
  BING_CTA_MAP.set(cta.toLowerCase(), cta);
}

const BING_CTA_ALIASES: Record<string, string> = {
  // Swedish translations & variations
  "ansok nu": "ApplyNow",
  "ansok": "ApplyNow",
  "ansokan": "ApplyNow",
  "las mer": "LearnMore",
  "kop nu": "ShopNow",
  "handla nu": "ShopNow",
  "registrera dig": "SignUp",
  "registrera": "SignUp",
  "bli medlem": "SignUp",
  "ladda ner": "Download",
  "ladda ned": "Download",
  "kom igang": "StartNow",
  "borja nu": "StartNow",
  "boka nu": "BookNow",
  "boka": "BookNow",
  "kontakta oss": "ContactUs",
  "kontakta": "ContactUs",
  "se mer": "SeeMore",
  "titta mer": "SeeMore",
  "prenumerera": "Subscribe",
  "fa offert": "GetQuote",
  "begar offert": "GetQuote",
  "offert": "GetQuote",
  "besok webbplatsen": "VisitSite",
  "besok webbplats": "VisitSite",
  "besok sida": "VisitSite",
  "se erbjudande": "SeeOffer",
  "fa erbjudande": "GetOffer",
  "erbjudande": "GetOffer",
  "utforska": "Explore",
  "ga med": "JoinNow",
  // English common variations
  "apply now": "ApplyNow",
  "apply": "Apply",
  "learn more": "LearnMore",
  "shop now": "ShopNow",
  "buy now": "BuyNow",
  "sign up": "SignUp",
  "download": "Download",
  "get started": "StartNow",
  "start now": "StartNow",
  "start free": "StartFree",
  "book now": "BookNow",
  "contact us": "ContactUs",
  "watch more": "WatchMore",
  "watch now": "WatchNow",
  "subscribe": "Subscribe",
  "get quote": "GetQuote",
  "visit site": "VisitSite",
  "order now": "OrderNow",
  "see more": "SeeMore",
  "get offer": "GetOffer",
  "explore": "Explore",
  "donate": "Donate",
  "join now": "JoinNow",
  "join": "Join",
  "install": "Install",
  "add to cart": "AddToCart",
  "request demo": "RequestDemo",
  "get demo": "GetDemo"
};

export function normalizeBingCallToAction(raw?: string | null): string {
  if (!raw || typeof raw !== "string") return "LearnMore";
  const clean = raw.trim();
  if (!clean) return "LearnMore";

  // 1. Direct match with valid enum
  if (BING_VALID_CTAS.has(clean)) return clean;

  // 2. Normalize: remove accents, replace underscores/hyphens with spaces, lowercase
  const normalized = clean
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const aliasHit = BING_CTA_ALIASES[normalized];
  if (aliasHit) {
    return aliasHit;
  }

  // 3. Try removing spaces and comparing case-insensitively
  const condensed = normalized.replace(/\s+/g, "");
  const mapHit = BING_CTA_MAP.get(condensed);
  if (mapHit) {
    return mapHit;
  }

  // 4. Check if any alias starts with or is contained
  for (const [key, val] of Object.entries(BING_CTA_ALIASES)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) {
      return val;
    }
  }

  return "LearnMore";
}

const uploadedBingMediaCache = new Map<string, { id: string; subType: string }>();

/** Decode a base64 string to bytes (Node `Buffer` replacement for Workers). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode bytes to base64 (Node `buf.toString("base64")` replacement for Workers). */
function bytesToBase64(bytes: Uint8Array): string {
  // Chunk the fromCharCode spread so large images don't blow the call stack.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function resolveBingImageUrl(url: string, ctx: BingAdsCtx): string | null {
  const clean = String(url || "").trim();
  if (!clean) return null;
  if (clean.startsWith("http://") || clean.startsWith("https://") || clean.startsWith("data:")) return clean;
  // Relative URLs need a fetchable base — read it from ctx (Workers have no process.env).
  const base = String(ctx.appUrl || ctx.publicUrl || "").trim();
  if (!base) {
    console.warn("[Bing Ads] Cannot fetch relative image URL without ctx.appUrl/publicUrl:", clean);
    return null;
  }
  return `${base.replace(/\/$/, "")}/${clean.replace(/^\//, "")}`;
}

async function fetchImageBuffer(url: unknown, ctx: BingAdsCtx): Promise<Uint8Array | null> {
  try {
    let clean = "";
    if (typeof url === "string") {
      clean = url.trim();
    } else if (url && typeof (url as { url?: unknown }).url === "string") {
      clean = String((url as { url: string }).url).trim();
    }
    if (!clean) return null;
    if (clean.startsWith("data:")) {
      const parts = clean.split(",");
      return base64ToBytes(parts[1] || "");
    }
    const fullUrl = resolveBingImageUrl(clean, ctx);
    if (!fullUrl) return null;
    const response = await fetch(fullUrl, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) {
      console.warn(`[Bing Ads] Failed to fetch image ${fullUrl}: HTTP ${response.status}`);
      return null;
    }
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.length ? buf : null;
  } catch (err: any) {
    console.warn(`[Bing Ads] Failed fetching image "${url}":`, err?.message || err);
    return null;
  }
}

// On Cloudflare Workers there is no image-resizing library available (the Node
// port used `sharp`). Resize/format is skipped on Workers: the original image
// bytes are uploaded as-is and Bing derives what it needs server-side.
async function formatLandscapeImage(input: Uint8Array): Promise<Uint8Array> {
  return input;
}

// On Cloudflare Workers there is no image-resizing library available (the Node
// port used `sharp`). Resize/format is skipped on Workers: the original image
// bytes are uploaded as-is and Bing derives what it needs server-side.
async function formatSquareImage(input: Uint8Array): Promise<Uint8Array> {
  return input;
}

async function uploadImageToBingSoap(
  ctx: BingAdsCtx,
  accountId: string,
  imageBytes: Uint8Array,
  mediaType: string
): Promise<string | null> {
  const addMediaXml = `
    <AddMediaRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
      <AccountId>${accountId}</AccountId>
      <Media>
        <Media i:type="Image">
          <MediaType>${mediaType}</MediaType>
          <Type>Image</Type>
          <Data>${bytesToBase64(imageBytes)}</Data>
        </Media>
      </Media>
    </AddMediaRequest>`;

  const res = await makeSoapRequest(ctx, "AddMedia", addMediaXml);
  return extractId(res, "long");
}

export async function uploadMediaToBing(
  ctx: BingAdsCtx,
  mediaUrls: any[] = [],
  options: any = {}
): Promise<{ id: string; subType: string }[]> {
  const accountId = String(ctx.adAccountId || "").replace(/[^0-9]/g, "");
  if (!accountId) return [];

  const imageSet = options.imageSet && typeof options.imageSet === "object" ? options.imageSet : null;
  const urlOf = (v: any): string | null =>
    typeof v === "string" ? v.trim() : v?.url ? String(v.url).trim() : null;

  const landscapeUrl = urlOf(imageSet?.landscape);
  const squareUrl = urlOf(imageSet?.square);
  const portraitUrl = urlOf(imageSet?.portrait);
  const logoUrl = urlOf(imageSet?.logo) || (options.logoUrl ? String(options.logoUrl).trim() : null);

  const candidateUrls = [
    landscapeUrl,
    squareUrl,
    portraitUrl,
    logoUrl,
    ...(Array.isArray(mediaUrls) ? mediaUrls : []),
    options.imageUrl,
  ]
    .map((u) => (typeof u === "string" ? u.trim() : null))
    .filter((u): u is string => Boolean(u));

  const uniqueUrls = Array.from(new Set(candidateUrls));
  if (uniqueUrls.length === 0) return [];

  // 1. Fetch image bytes for all candidate URLs
  const buffersByUrl = new Map<string, Uint8Array>();
  for (const url of uniqueUrls) {
    const buf = await fetchImageBuffer(url, ctx);
    if (buf) {
      buffersByUrl.set(url, buf);
    }
  }

  if (buffersByUrl.size === 0) return [];

  // Determine a primary fallback creative buffer (prefer non-logo creative)
  let fallbackCreativeBuf: Uint8Array | null = null;
  for (const url of uniqueUrls) {
    if (url !== logoUrl && buffersByUrl.has(url)) {
      fallbackCreativeBuf = buffersByUrl.get(url) ?? null;
      break;
    }
  }
  if (!fallbackCreativeBuf) {
    const first = buffersByUrl.values().next();
    if (!first.done) fallbackCreativeBuf = first.value;
  }

  // Upload helper with caching keyed by URL and subType
  const uploadSlot = async (
    rawBuf: Uint8Array | null | undefined,
    formatFn: (b: Uint8Array) => Promise<Uint8Array>,
    mediaType: string,
    subType: string,
    cacheKeyUrl: string
  ): Promise<{ id: string; subType: string } | null> => {
    if (!rawBuf) return null;
    const cacheKey = `${accountId}:${cacheKeyUrl}:${subType}`;
    const cached = uploadedBingMediaCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    try {
      const formattedBuf = await formatFn(rawBuf);
      const id = await uploadImageToBingSoap(ctx, accountId, formattedBuf, mediaType);
      if (id) {
        const item = { id: String(id), subType };
        uploadedBingMediaCache.set(cacheKey, item);
        return item;
      }
    } catch (err: any) {
      console.error(`[Bing Ads] Failed to upload ${subType} (${cacheKeyUrl}):`, err?.message || err);
    }
    return null;
  };

  const mediaAssets: { id: string; subType: string }[] = [];

  // Slot 1: Landscape (1.91:1, 1200x628) -> LandscapeImageMedia
  const lUrl = landscapeUrl && buffersByUrl.has(landscapeUrl) ? landscapeUrl : null;
  const lBuf = lUrl ? buffersByUrl.get(lUrl) : fallbackCreativeBuf;
  const lAsset = await uploadSlot(lBuf, formatLandscapeImage, "Image191x100", "LandscapeImageMedia", lUrl || "fallback_landscape");
  if (lAsset) mediaAssets.push(lAsset);

  // Slot 2: Square (1:1, 1200x1200) -> SquareImageMedia
  const sUrl = squareUrl && buffersByUrl.has(squareUrl) ? squareUrl : null;
  const sBuf = sUrl ? buffersByUrl.get(sUrl) : fallbackCreativeBuf;
  const sAsset = await uploadSlot(sBuf, formatSquareImage, "Image1x1", "SquareImageMedia", sUrl || "fallback_square");
  if (sAsset) mediaAssets.push(sAsset);

  // Slot 3: Logo (1:1, 1200x1200) -> SquareLogoMedia
  const logUrl = logoUrl && buffersByUrl.has(logoUrl) ? logoUrl : null;
  const logBuf = logUrl ? buffersByUrl.get(logUrl) : sBuf || fallbackCreativeBuf;
  const logAsset = await uploadSlot(logBuf, formatSquareImage, "Image1x1", "SquareLogoMedia", logUrl || "fallback_logo");
  if (logAsset) mediaAssets.push(logAsset);

  return mediaAssets;
}

export const bing = {
  code: "bing_ads",

  validate(ctx: BingAdsCtx): void {
    if (!ctx.accessToken) throw new Error("Microsoft Advertising connection has no access token");
    if (!ctx.adAccountId || isNaN(Number(String(ctx.adAccountId).replace(/[^0-9]/g, "")))) {
      throw new Error("Microsoft Advertising Account ID is missing or not numeric. Configure it in Connections.");
    }
  },

  async createCampaign(
    ctx: BingAdsCtx,
    campaign: any
  ): Promise<{ platformCampaignId: string; campaignType: string }> {
    bing.validate(ctx);
    const accountId = String(ctx.adAccountId).replace(/[^0-9]/g, "");

    const targeting = campaign.targeting || campaign.draftState?.targeting || {};
    const rawLang = targeting.language?.[0] || targeting.languages?.[0] || "en";
    let bingLang = getBingLanguage(rawLang);

    let campaignType = "Search";
    let settingsXml = "";
    const adType = (
      targeting.campaignType ||
      campaign.draftState?.bingCampaignType ||
      (campaign.draftState?.googleCampaignType ? String(campaign.draftState.googleCampaignType).toLowerCase() : "") ||
      "search"
    ).toLowerCase();

    if (adType === "audience") {
      campaignType = "Audience";
      bingLang = "All";
    } else if (adType === "app_install" || adType === "app") {
      const appId = targeting.appId;
      const appStore = targeting.appStore || "AppleAppStore";
      if (!appId) throw new Error("App Install campaigns require an appId in targeting settings.");
      campaignType = "App";
      settingsXml = `
            <Settings>
              <Setting i:type="AppSetting">
                <AppId>${escapeXml(appId)}</AppId>
                <AppStore>${escapeXml(appStore)}</AppStore>
              </Setting>
            </Settings>
      `;
    } else if (adType === "shopping") {
      const storeId = targeting.storeId;
      const salesCountryCode = targeting.salesCountryCode || "US";
      const priority = targeting.priority || "0";
      if (!storeId) throw new Error("Shopping campaigns require a storeId (Microsoft Merchant Center ID) in targeting settings.");
      campaignType = "Shopping";
      settingsXml = `
            <Settings>
              <Setting i:type="ShoppingSetting">
                <Priority>${priority}</Priority>
                <SalesCountryCode>${escapeXml(salesCountryCode)}</SalesCountryCode>
                <StoreId>${escapeXml(storeId)}</StoreId>
              </Setting>
            </Settings>
      `;
    } else if (adType === "hotel") {
      const hotelCenterId = targeting.hotelCenterId;
      if (!hotelCenterId) throw new Error("Hotel campaigns require a hotelCenterId in targeting settings.");
      campaignType = "Hotel";
      settingsXml = `
            <Settings>
              <Setting i:type="HotelSetting">
                <HotelCenterId>${escapeXml(hotelCenterId)}</HotelCenterId>
              </Setting>
            </Settings>
      `;
    } else if (adType === "performance_max") {
      campaignType = "PerformanceMax";
    }

    const dailyBudget = (Number(campaign.budgetAmount) || 0) / 100;
    const bodyXml = `
      <AddCampaignsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
        <AccountId>${accountId}</AccountId>
        <Campaigns>
          <Campaign>
            <BudgetType>DailyBudgetStandard</BudgetType>
            <DailyBudget>${dailyBudget > 0 ? dailyBudget : 5}</DailyBudget>
            <Name>${escapeXml(campaign.name.substring(0, 100))}</Name>
            <Status>Paused</Status>
            <CampaignType>${campaignType}</CampaignType>
            ${settingsXml}
            <Languages xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
              <a:string>${bingLang}</a:string>
            </Languages>
          </Campaign>
        </Campaigns>
      </AddCampaignsRequest>
    `;

    const responseXml = await makeSoapRequest(ctx, "AddCampaigns", bodyXml);
    const campaignId = extractId(responseXml, "long");

    if (!campaignId) {
      const errorMessage = extractBatchError(responseXml) || "Unknown error parsing campaign ID";
      throw new Error(`Bing Ads: ${errorMessage}`);
    }

    // Apply Criterions (Location & Age)
    try {
      let criterionsXml = "";
      const criterionsType = new Set<string>();

      const locations = targeting.locations || [];
      if (typeof targeting.location === "string") locations.push(targeting.location);
      const ages = targeting.ages || [];

      for (const loc of locations) {
        const locId = getBingLocationId(loc);
        if (locId) {
          criterionsXml += `
            <CampaignCriterion i:type="BiddableCampaignCriterion">
              <CampaignId>${campaignId}</CampaignId>
              <Criterion i:type="LocationCriterion">
                <LocationId>${locId}</LocationId>
              </Criterion>
            </CampaignCriterion>
          `;
          criterionsType.add("Location");
        }
      }

      const isPmax = adType === "performance_max";
      const bingAges = getBingAgeRanges(ages);

      if (!isPmax) {
        for (const age of bingAges) {
          criterionsXml += `
            <CampaignCriterion i:type="BiddableCampaignCriterion">
              <CampaignId>${campaignId}</CampaignId>
              <Criterion i:type="AgeCriterion">
                <AgeRange>${age}</AgeRange>
              </Criterion>
            </CampaignCriterion>
          `;
          criterionsType.add("Age");
        }
      }

      if (criterionsXml.length > 0) {
        const criterionTypesStr = Array.from(criterionsType).join(" ");
        const criterionsBodyXml = `
          <AddCampaignCriterionsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
            <CampaignCriterions>
              ${criterionsXml}
            </CampaignCriterions>
            <CriterionType>${criterionTypesStr}</CriterionType>
          </AddCampaignCriterionsRequest>
        `;
        await makeSoapRequest(ctx, "AddCampaignCriterions", criterionsBodyXml);
      }
    } catch {}

    return { platformCampaignId: String(campaignId), campaignType: adType };
  },

  async createAdSet(
    ctx: BingAdsCtx,
    campaign: any,
    adSet: any,
    platformCampaignId: string | number
  ): Promise<{ platformAdSetId: string }> {
    bing.validate(ctx);

    const year = new Date().getUTCFullYear();
    const month = new Date().getUTCMonth() + 1;
    const day = new Date().getUTCDate();

    const targeting = campaign.targeting || campaign.draftState?.targeting || adSet?.targeting || {};
    const adType = (
      targeting.campaignType ||
      campaign.draftState?.bingCampaignType ||
      (campaign.draftState?.googleCampaignType ? String(campaign.draftState.googleCampaignType).toLowerCase() : "") ||
      "search"
    ).toLowerCase();
    const nameLower = (campaign.name || "").toLowerCase();
    const isPmax = adType === "performance_max" || nameLower.includes("pmax") || nameLower.includes("performance max");

    if (isPmax) {
      // Defer AssetGroup creation to createAdFromPost
      return { platformAdSetId: `PMAX_DEFERRED_${platformCampaignId}` };
    }

    let adGroupTypeXml = "";
    if (adType === "audience") {
      adGroupTypeXml = "<AdGroupType>Audience</AdGroupType>";
    } else if (adType === "search" || adType === "shopping") {
      adGroupTypeXml = "<AdGroupType>SearchStandard</AdGroupType>";
    }

    // Format a clean, valid AdGroup name for Microsoft Advertising:
    // 1. Max length 256 chars (keep <= 128 for safety).
    // 2. Normalize hyphens and whitespace.
    // 3. Convert Facebook terminology ("ad set") to standard Microsoft Advertising ("Ad Group").
    let baseName = String(adSet.name || `${campaign.name || "Reach"} - Ad Group`)
      .replace(/[—–]/g, " - ")
      .replace(/\s*-\s*ad\s*set\s*$/i, " - Ad Group")
      .replace(/\s*ad\s*set\s*$/i, " Ad Group")
      .trim();

    if (!baseName) baseName = `${campaign.name || "Reach"} - Ad Group`;

    const cleanAdGroupName = baseName
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .substring(0, 128)
      .trim() || "Reach Ad Group";

    const bid = (adSet.bidAmount || 100) / 100;
    // Microsoft Advertising WCF DataContract requires elements in exact xs:sequence order:
    // CpcBid (5) -> Name (13) -> StartDate (18) -> Status (19) -> AdGroupType (25).
    // Placing AdGroupType before Name violates xs:sequence and causes Bing to drop Name,
    // returning error 1202: "The AdGroup name is invalid."
    const bodyXml = `
      <AddAdGroupsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
        <CampaignId>${platformCampaignId}</CampaignId>
        <AdGroups>
          <AdGroup>
            <CpcBid>
              <Amount>${bid > 0 ? bid : 1}</Amount>
            </CpcBid>
            <Name>${escapeXml(cleanAdGroupName)}</Name>
            <StartDate>
              <Day>${day}</Day>
              <Month>${month}</Month>
              <Year>${year}</Year>
            </StartDate>
            <Status>Paused</Status>
            ${adGroupTypeXml}
          </AdGroup>
        </AdGroups>
      </AddAdGroupsRequest>
    `;

    const responseXml = await makeSoapRequest(ctx, "AddAdGroups", bodyXml);
    const adGroupId = extractId(responseXml, "long");

    if (!adGroupId) {
      const errorMessage = extractBatchError(responseXml) || "Unknown error parsing ad group ID";
      throw new Error(`Bing Ads: ${errorMessage}`);
    }

    // Attach keywords for Search and Shopping ad groups
    if (!isPmax && (adType === "search" || adType === "shopping")) {
      const keywords = extractKeywords(campaign, {}, targeting, adSet);
      if (keywords.length > 0) {
        const rawLp =
          adSet.landingPageUrl ||
          campaign.landingPageUrl ||
          campaign.draftState?.landingPageUrl ||
          campaign.draftState?.googleCreativeBundle?.finalUrl ||
          campaign.trackingFinalUrl ||
          targeting.finalUrl ||
          targeting.landingPageUrl;
        let cleanLp = String(rawLp || "").trim();
        if (cleanLp && !cleanLp.startsWith("http://") && !cleanLp.startsWith("https://")) {
          cleanLp = `https://${cleanLp}`;
        }
        try {
          await addKeywordsToAdGroup(ctx, adGroupId, keywords, bid, cleanLp);
        } catch (kwErr: any) {
          console.warn(`[Bing Ads] Failed adding keywords in createAdSet: ${kwErr?.message || kwErr}`);
        }
      }
    }

    return { platformAdSetId: String(adGroupId) };
  },

  async createAdFromPost(
    ctx: BingAdsCtx,
    campaign: any,
    post: any,
    mediaUrls: any[] = [],
    targeting: any = {},
    platformAdSetId?: string | number
  ): Promise<{ platformAdId: string; platformPostId: string; platformCampaignId?: string }> {
    bing.validate(ctx);

    const targetUrl =
      post.destinationUrl ||
      post.fieldValues?.finalUrl ||
      post.fieldValues?.destinationUrl ||
      post.fieldValues?.landingPageUrl ||
      post.linkUrl ||
      post.url ||
      campaign.landingPageUrl ||
      campaign.draftState?.landingPageUrl ||
      campaign.draftState?.googleCreativeBundle?.finalUrl ||
      campaign.trackingFinalUrl ||
      targeting.finalUrl ||
      targeting.landingPageUrl ||
      "https://example.com";

    let cleanTargetUrl = String(targetUrl || "").trim();
    if (cleanTargetUrl && !cleanTargetUrl.startsWith("http://") && !cleanTargetUrl.startsWith("https://")) {
      cleanTargetUrl = `https://${cleanTargetUrl}`;
    }
    if (!cleanTargetUrl) cleanTargetUrl = "https://example.com";

    const content = post.body || post.content || "";
    const campTargeting = campaign.targeting || campaign.draftState?.targeting || {};
    const adType = (
      targeting.campaignType ||
      campTargeting.campaignType ||
      campaign.draftState?.bingCampaignType ||
      (campaign.draftState?.googleCampaignType ? String(campaign.draftState.googleCampaignType).toLowerCase() : "") ||
      "search"
    ).toLowerCase();

    const isPmax =
      adType === "performance_max" ||
      String(platformAdSetId || "").startsWith("PMAX_DEFERRED_") ||
      (campaign.name || "").toLowerCase().includes("pmax") ||
      (campaign.name || "").toLowerCase().includes("performance max");

    // Automatically filter content according to platform specifications:
    // - Search Ads (ResponsiveSearchAd): strictly 2 to 4 descriptions (max 4), 3 to 15 headlines, no images.
    // - Performance Max: up to 5 descriptions, up to 15 headlines, up to 5 long headlines, required images.
    const maxDescriptions = isPmax ? 5 : 4;
    const rawDescriptions = [
      ...(Array.isArray(post.descriptions) ? post.descriptions : []),
      ...(Array.isArray(post.fieldValues?.descriptions) ? post.fieldValues.descriptions : []),
      ...(Array.isArray(campaign.draftState?.googleCreativeBundle?.descriptions) ? campaign.draftState.googleCreativeBundle.descriptions : []),
      post.description,
      content,
    ].filter(Boolean);

    const descriptionsXml = buildDescriptionsXml(
      content || post.description,
      post.description,
      rawDescriptions,
      maxDescriptions
    );

    const rawHeadlines = [
      ...(Array.isArray(post.headlines) ? post.headlines : []),
      ...(Array.isArray(post.fieldValues?.headlines) ? post.fieldValues.headlines : []),
      ...(Array.isArray(campaign.draftState?.googleCreativeBundle?.headlines) ? campaign.draftState.googleCreativeBundle.headlines : []),
      post.headline,
      post.title,
      campaign.draftState?.googleCreativeBundle?.longHeadline,
    ].filter(Boolean);

    const headlinesXml = buildHeadlinesXml(
      post.headline || post.title,
      content,
      rawHeadlines
    );
    const longHeadlinesXml = buildLongHeadlinesXml(
      post.longHeadlines || post.fieldValues?.longHeadlines || post.longHeadline,
      post.headline || post.title,
      post.description || content
    );


    const fv = post.fieldValues || {};
    const imgSet = fv.imageSet || campaign.draftState?.imageSet || {};
    const urlOf = (v: any): string | null =>
      typeof v === "string" ? v.trim() : v?.url ? String(v.url).trim() : null;

    const logoUrl =
      urlOf(imgSet.logo) ||
      fv.logoUrl ||
      campaign.draftState?.logoUrl ||
      campaign.brandLogoUrl ||
      campaign.branding?.logoUrl ||
      null;

    let mediaAssets: { id: string; subType: string }[] = [];
    let imagesXml = "";

    // Automatically filter: only upload media assets for PerformanceMax and Audience campaigns.
    // Search, Shopping, Hotel, and App campaigns do not use asset group image links.
    if (isPmax || adType === "audience") {
      const candidateMediaUrls = [
        urlOf(imgSet.landscape),
        urlOf(imgSet.square),
        urlOf(imgSet.portrait),
        logoUrl,
        ...(mediaUrls || []),
        post.imageUrl,
        post.mediaUrl,
      ].filter(Boolean);

      if (candidateMediaUrls.length > 0) {
        mediaAssets = await uploadMediaToBing(ctx, candidateMediaUrls, {
          imageSet: imgSet,
          logoUrl,
          imageUrl: post.imageUrl || post.mediaUrl,
        });
      }

      if (mediaAssets.length > 0) {
        const assetLinks = mediaAssets
          .map(
            (asset) => `
              <AssetLink>
                <Asset i:type="ImageAsset">
                  <Id>${asset.id}</Id>
                  <SubType>${asset.subType}</SubType>
                </Asset>
              </AssetLink>`
          )
          .join("");
        imagesXml = `<Images>${assetLinks}</Images>`;
      }
    }

    if (isPmax && mediaAssets.length === 0) {
      throw new Error("Performance Max campaigns require at least one image. Please upload an image for your post.");
    }
    if (adType === "audience" && mediaAssets.length === 0) {
      throw new Error("Audience campaigns (ResponsiveAds) require at least one image. Please upload an image for your post.");
    }

    if (isPmax) {
      const pmaxCampaignId = String(platformAdSetId).replace("PMAX_DEFERRED_", "");

      const businessName = escapeXml(
        String(post.fieldValues?.businessName || campaign.name || "Reach Business")
          .replace(/[—–]/g, " - ")
          .replace(/[^a-zA-Z0-9 \-_.]/g, "")
          .trim()
          .substring(0, 25) || "Reach Business"
      );
      const callToAction = escapeXml(normalizeBingCallToAction(post.callToAction));
      const assetGroupName = escapeXml(
        String(post.headline || post.title || "PMax Asset Group")
          .replace(/[—–]/g, " - ")
          .replace(/[^a-zA-Z0-9 \-_.]/g, "")
          .trim()
          .substring(0, 20) || "PMax Asset Group"
      );

      const assetGroupBodyXml = `
        <AddAssetGroupsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
          <AssetGroups>
            <AssetGroup>
              <BusinessName>${businessName}</BusinessName>
              <CallToAction>${callToAction}</CallToAction>
              <Descriptions>
                ${descriptionsXml}
              </Descriptions>
              <FinalUrls xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
                <a:string>${escapeXml(cleanTargetUrl)}</a:string>
              </FinalUrls>
              <Headlines>
                ${headlinesXml}
              </Headlines>
              ${imagesXml}
              <LongHeadlines>
                ${longHeadlinesXml}
              </LongHeadlines>
              <Name>${assetGroupName}</Name>
              <Status>Paused</Status>
            </AssetGroup>
          </AssetGroups>
          <CampaignId>${pmaxCampaignId}</CampaignId>
        </AddAssetGroupsRequest>
      `;

      try {
        const responseXml = await makeSoapRequest(ctx, "AddAssetGroups", assetGroupBodyXml);
        const assetGroupId = extractId(responseXml, "long");

        if (!assetGroupId) {
          const errorMessage = extractBatchError(responseXml) || "Unknown error parsing asset group ID";
          throw new Error(`Bing Ads: ${errorMessage}`);
        }

        return { platformAdId: String(assetGroupId), platformPostId: String(assetGroupId) };
      } catch (err: any) {
        if (err?.message && err.message.includes("UnsupportedCampaignTypeForAssetGroup")) {
          // Campaign on Microsoft Advertising was created as Search, not PerformanceMax.
          console.warn(`[Bing Ads] Remote campaign ${pmaxCampaignId} is not a PerformanceMax campaign on Microsoft Advertising. Creating a new PerformanceMax campaign...`);
          try {
            const newCamp = await bing.createCampaign(ctx, {
              ...campaign,
              name: `${(campaign.name || "Reach").substring(0, 80)} PMax`,
              budgetAmount: campaign.budgetAmount,
              targeting: { ...targeting, campaignType: "performance_max" }
            });
            const newPmaxCampaignId = newCamp.platformCampaignId;
            const retryAssetGroupXml = assetGroupBodyXml.replace(
              `<CampaignId>${pmaxCampaignId}</CampaignId>`,
              `<CampaignId>${newPmaxCampaignId}</CampaignId>`
            );
            const retryRes = await makeSoapRequest(ctx, "AddAssetGroups", retryAssetGroupXml);
            const newAssetGroupId = extractId(retryRes, "long");
            if (newAssetGroupId) {
              return {
                platformAdId: String(newAssetGroupId),
                platformPostId: String(newAssetGroupId),
                platformCampaignId: String(newPmaxCampaignId)
              };
            }
          } catch (createCampErr: any) {
            console.warn(`[Bing Ads] Failed to auto-create new PMax campaign:`, createCampErr?.message || createCampErr);
          }

          // Fall back gracefully to creating an AdGroup and ResponsiveSearchAd so the campaign runs
          console.warn(`[Bing Ads] Falling back to Search AdGroup and ResponsiveSearchAd.`);
          const adGroupRes = await bing.createAdSet(
            ctx,
            campaign,
            { name: `${campaign.name || "Reach"} Ad Group`, bidAmount: 100, targeting: { campaignType: "search" } },
            pmaxCampaignId
          );
          return await bing.createAdFromPost(
            ctx,
            campaign,
            post,
            mediaUrls,
            { ...targeting, campaignType: "search" },
            adGroupRes.platformAdSetId
          );
        }
        throw err;
      }
    }

    let adXml = "";
    if (adType === "shopping") {
      adXml = `
          <Ad i:type="ProductAd">
            <Status>Paused</Status>
            <PromotionalText>${escapeXml(post.headline || "Shop Now")}</PromotionalText>
          </Ad>
      `;
    } else if (adType === "hotel") {
      adXml = `
          <Ad i:type="HotelAd">
            <Status>Paused</Status>
          </Ad>
      `;
    } else if (adType === "audience") {
      adXml = `
          <Ad i:type="ResponsiveAd">
            <BusinessName>${escapeXml((campaign.name || "Reach Business").substring(0, 25))}</BusinessName>
            <FinalUrls xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
              <a:string>${escapeXml(cleanTargetUrl)}</a:string>
            </FinalUrls>
            <Status>Paused</Status>
            <CallToAction>${escapeXml(normalizeBingCallToAction(post.callToAction))}</CallToAction>
            <Headline>${escapeXml(post.headline || post.title || "Learn More")}</Headline>
            ${imagesXml}
            <Text>${escapeXml(post.description || content || "Check this out!")}</Text>
          </Ad>
      `;
    } else if (adType === "app_install" || adType === "app") {
      const appId = campTargeting.appId || targeting.appId || "app.id";
      const appStore = campTargeting.appStore || targeting.appStore || "AppleAppStore";
      const appPlatform = appStore.toLowerCase().includes("google") || appStore.toLowerCase().includes("android") ? "Android" : "iOS";

      adXml = `
          <Ad i:type="AppInstallAd">
            <Status>Paused</Status>
            <AppPlatform>${appPlatform}</AppPlatform>
            <AppStoreId>${escapeXml(appId)}</AppStoreId>
            <Text>${escapeXml(post.description || content || "Download our app today!")}</Text>
            <Title>${escapeXml(post.headline || post.title || "Get the App")}</Title>
          </Ad>
      `;
    } else {
      // Default to Search with ResponsiveSearchAd
      adXml = `
          <Ad i:type="ResponsiveSearchAd">
            <FinalUrls xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
              <a:string>${escapeXml(cleanTargetUrl)}</a:string>
            </FinalUrls>
            <Status>Paused</Status>
            <Descriptions>
              ${descriptionsXml}
            </Descriptions>
            <Headlines>
              ${headlinesXml}
            </Headlines>
          </Ad>
      `;
    }

    const bodyXml = `
      <AddAdsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
        <AdGroupId>${platformAdSetId}</AdGroupId>
        <Ads>
          ${adXml}
        </Ads>
      </AddAdsRequest>
    `;

    const responseXml = await makeSoapRequest(ctx, "AddAds", bodyXml);
    const adId = extractId(responseXml, "long");

    if (!adId) {
      const errorMessage = extractBatchError(responseXml) || "Unknown error parsing ad ID";
      throw new Error(`Bing Ads: ${errorMessage}`);
    }
    if (!isPmax && (adType === "search" || adType === "shopping")) {
      const keywords = extractKeywords(campaign, post, targeting);
      if (keywords.length > 0 && platformAdSetId && !String(platformAdSetId).startsWith("PMAX_DEFERRED_")) {
        try {
          await addKeywordsToAdGroup(ctx, platformAdSetId, keywords, 1, cleanTargetUrl);
        } catch (kwErr: any) {
          console.warn(`[Bing Ads] Keyword sync in createAdFromPost: ${kwErr?.message || kwErr}`);
        }
      }
    }

    return { platformAdId: String(adId), platformPostId: String(adId) };
  },

  async pauseCampaign(ctx: BingAdsCtx, platformCampaignId: string | number): Promise<void> {
    bing.validate(ctx);
    const accountId = String(ctx.adAccountId).replace(/[^0-9]/g, "");
    const bodyXml = `
      <UpdateCampaignsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
        <AccountId>${accountId}</AccountId>
        <Campaigns>
          <Campaign>
            <Id>${platformCampaignId}</Id>
            <Status>Paused</Status>
          </Campaign>
        </Campaigns>
      </UpdateCampaignsRequest>
    `;
    await makeSoapRequest(ctx, "UpdateCampaigns", bodyXml);
  },

  async resumeCampaign(ctx: BingAdsCtx, platformCampaignId: string | number): Promise<void> {
    bing.validate(ctx);
    const accountId = String(ctx.adAccountId).replace(/[^0-9]/g, "");
    const bodyXml = `
      <UpdateCampaignsRequest xmlns="https://bingads.microsoft.com/CampaignManagement/v13">
        <AccountId>${accountId}</AccountId>
        <Campaigns>
          <Campaign>
            <Id>${platformCampaignId}</Id>
            <Status>Active</Status>
          </Campaign>
        </Campaigns>
      </UpdateCampaignsRequest>
    `;
    await makeSoapRequest(ctx, "UpdateCampaigns", bodyXml);
  },

  async getCampaignStats(
    ctx: BingAdsCtx,
    platformCampaignId: string | number,
    { since, until }: { since?: string; until?: string } = {}
  ): Promise<{
    daily: unknown[];
    status: { live: boolean };
    currency: string;
    impressions: number;
    clicks: number;
    spend: number;
  }> {
    bing.validate(ctx);
    void platformCampaignId;
    void since;
    void until;
    return {
      daily: [],
      status: { live: true },
      currency: ctx.currency || "USD",
      impressions: 0,
      clicks: 0,
      spend: 0,
    };
  },
};

export default bing;
