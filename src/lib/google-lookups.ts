// Reference data the campaign builder needs: Google campaign types, geo targets,
// languages, Merchant Center products, and a landing-page reachability check.
// Port of the old lib/google-lookups.js, backed by Drizzle/D1 instead of Baasix.
// The shared rule is kept deliberately: a workspace with no Google Ads connection
// still gets a usable static list rather than an error, because the wizard is also
// used for Meta-only workspaces.
import { and, eq } from "drizzle-orm";
import { adPlatforms, platformConnections } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { getConnectionConfig } from "./connections.js";
import { googleAdsVersion } from "./platform-providers.js";
import { linkMerchantCenterAccount } from "./providers/google-ads.js";

export interface LookupDeps {
  db: Db;
  env: Record<string, string | undefined>;
  secretKey: string;
}

/** Campaign types Reach can actually build, and which objectives may use each. */
const SUPPORTED_TYPES = ["PERFORMANCE_MAX", "SEARCH", "DEMAND_GEN", "VIDEO", "DISPLAY", "SHOPPING"];
const OBJECTIVE_TYPES: Record<string, string[]> = {
  sales: ["PERFORMANCE_MAX", "SEARCH", "DEMAND_GEN", "DISPLAY", "SHOPPING", "VIDEO"],
  leads: ["PERFORMANCE_MAX", "SEARCH", "DEMAND_GEN", "DISPLAY", "SHOPPING", "VIDEO"],
  traffic: ["PERFORMANCE_MAX", "SEARCH", "DEMAND_GEN", "DISPLAY", "SHOPPING", "VIDEO"],
  app_promotion: ["DEMAND_GEN", "DISPLAY"],
  awareness: ["DEMAND_GEN", "VIDEO", "DISPLAY"],
  engagement: ["DEMAND_GEN", "VIDEO", "DISPLAY"],
  local: ["PERFORMANCE_MAX", "SEARCH", "DEMAND_GEN", "DISPLAY"],
  local_visits: ["PERFORMANCE_MAX", "SEARCH", "DEMAND_GEN", "DISPLAY"],
};

export const FALLBACK_LOCATIONS = [
  ["2840", "United States", "US"], ["2826", "United Kingdom", "GB"], ["2124", "Canada", "CA"],
  ["2036", "Australia", "AU"], ["2356", "India", "IN"], ["2276", "Germany", "DE"],
  ["2250", "France", "FR"], ["2076", "Brazil", "BR"], ["2484", "Mexico", "MX"],
  ["2380", "Italy", "IT"], ["2724", "Spain", "ES"], ["2392", "Japan", "JP"],
  ["2710", "South Africa", "ZA"], ["2752", "Sweden", "SE"], ["2528", "Netherlands", "NL"],
  ["2578", "Norway", "NO"], ["2208", "Denmark", "DK"], ["2246", "Finland", "FI"],
  ["2756", "Switzerland", "CH"], ["2040", "Austria", "AT"], ["2056", "Belgium", "BE"],
  ["2372", "Ireland", "IE"], ["2620", "Portugal", "PT"], ["2554", "New Zealand", "NZ"],
  ["2616", "Poland", "PL"], ["2702", "Singapore", "SG"], ["2784", "United Arab Emirates", "AE"],
  ["2682", "Saudi Arabia", "SA"], ["2792", "Turkey", "TR"],
].map(([id, name, countryCode]: string[]) => ({
  id: id!, resourceName: `geoTargetConstants/${id}`, name: name!, canonicalName: name!,
  targetType: "Country", countryCode: countryCode!, status: "ENABLED", reach: 0,
}));

const FALLBACK_LANGUAGES = [
  ["en", "English", 1000], ["de", "German", 1001], ["fr", "French", 1002], ["es", "Spanish", 1003],
  ["it", "Italian", 1004], ["ja", "Japanese", 1005], ["da", "Danish", 1009], ["nl", "Dutch", 1010],
  ["pt", "Portuguese", 1014], ["sv", "Swedish", 1015], ["zh_CN", "Chinese (Simplified)", 1017],
  ["zh_TW", "Chinese (Traditional)", 1018], ["ar", "Arabic", 1019], ["pl", "Polish", 1030],
].map(([code, name, constantId]: (string | number)[]) => ({ id: code as string, code: code as string, name: name as string, constantId: constantId as number }));

const digits = (v: unknown) => String(v || "").replace(/\D/g, "");

interface GoogleCtx {
  version: string;
  accessToken: string;
  developerToken: string;
  customerId: string;
  loginCustomerId: string;
  connection: Record<string, any>;
  meta: Record<string, any>;
}

/**
 * The Google credentials for a workspace, or null when it has no usable connection.
 * Never throws: every caller here is expected to fall back to static data.
 */
async function googleCtx(deps: LookupDeps, workspaceId: string): Promise<GoogleCtx | null> {
  if (!workspaceId) return null;
  try {
    const { connection, config } = await getConnectionConfig(deps.db, deps.env, deps.secretKey, workspaceId, "google_ads");
    const conn = connection as Record<string, any> | null;
    if (!conn?.accessToken) return null;
    const meta = (conn.meta || {}) as Record<string, any>;
    const accessToken = String(conn.accessToken);
    // getConnectionConfig already refreshed the token when needed.
    const customerId = digits(meta.selectedAdAccountId || conn.externalAccountId);
    if (!customerId) return null;
    const targetCust = (meta.customers || []).find((c: any) => digits(c.id) === customerId);
    const cfgManager = digits(meta.managerCustomerId || "");
    const cfgManagerListed = cfgManager && (meta.customers || []).some((c: any) => digits(c.id) === cfgManager);
    const loginCustomerId = digits(targetCust?.managedBy || (cfgManagerListed ? cfgManager : "") || conn.externalAccountId);
    const developerToken = config.developerToken || deps.env.ADS_GOOGLE_ADS_DEVELOPER_TOKEN || "";
    if (!developerToken) return null;
    return {
      version: googleAdsVersion(config),
      accessToken,
      developerToken,
      customerId,
      loginCustomerId,
      connection: conn,
      meta,
    };
  } catch {
    return null;
  }
}

async function googleFetch(ctx: GoogleCtx, path: string, body: unknown): Promise<any> {
  const r = await fetch(`https://googleads.googleapis.com/${ctx.version}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      "developer-token": ctx.developerToken,
      "login-customer-id": ctx.loginCustomerId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text.trim().startsWith("<") ? `Google Ads API ${ctx.version} unavailable` : text.slice(0, 200));
  return JSON.parse(text || "{}");
}

const searchStream = async (ctx: GoogleCtx, query: string): Promise<any[]> => {
  const chunks = await googleFetch(ctx, `customers/${ctx.customerId}/googleAds:searchStream`, { query });
  return (Array.isArray(chunks) ? chunks : [chunks]).flatMap((c: any) => c?.results || []);
};

/**
 * Types Reach supports for this objective, plus the types already in use in the connected
 * account — the wizard highlights the latter so users recognise their own setup.
 */
export async function googleCampaignTypes(deps: LookupDeps, workspaceId: string, objective?: string) {
  const allowed = OBJECTIVE_TYPES[String(objective || "")] || SUPPORTED_TYPES;
  const supportedTypes = SUPPORTED_TYPES.filter((t) => allowed.includes(t));
  const ctx = await googleCtx(deps, workspaceId);
  if (!ctx) return { supportedTypes, accountTypes: [] };
  try {
    const rows = await searchStream(ctx, "SELECT campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED'");
    const seen = new Set(rows.map((r: any) => r.campaign?.advertisingChannelType).filter(Boolean));
    return { supportedTypes, accountTypes: supportedTypes.filter((t) => seen.has(t)) };
  } catch {
    return { supportedTypes, accountTypes: [] };
  }
}

/** Geo targets matching a free-text query, via Google's suggest endpoint. */
export async function searchGeoTargets(
  deps: LookupDeps, workspaceId: string, query: string, countryCode?: string, locale?: string,
) {
  const ctx = await googleCtx(deps, workspaceId);
  if (!ctx) {
    const q = String(query || "").toLowerCase();
    return q
      ? FALLBACK_LOCATIONS.filter((l) => l.name.toLowerCase().includes(q) || l.countryCode.toLowerCase().includes(q))
      : FALLBACK_LOCATIONS;
  }
  try {
    const body: Record<string, any> = { locale: locale || "en", locationNames: { names: [query] } };
    if (countryCode) body.countryCode = String(countryCode).trim().toUpperCase();
    const data = await googleFetch(ctx, "geoTargetConstants:suggest", body);
    return (data.geoTargetConstantSuggestions || [])
      .map((item: any) => {
        const g = item.geoTargetConstant || {};
        const id = g.id || String(g.resourceName || "").split("/").pop() || "";
        return {
          id, resourceName: g.resourceName || `geoTargetConstants/${id}`, name: g.name || "",
          canonicalName: g.canonicalName || g.name || "", targetType: g.targetType || "Location",
          countryCode: g.countryCode || "", status: g.status || "ENABLED", reach: item.reach || null,
        };
      })
      .filter((s: any) => s.status === "ENABLED" || s.status === "UNKNOWN");
  } catch {
    const q = String(query || "").toLowerCase().trim();
    return q
      ? FALLBACK_LOCATIONS.filter((l) => l.name.toLowerCase().includes(q) || l.countryCode.toLowerCase().includes(q))
      : FALLBACK_LOCATIONS;
  }
}

/** Targetable languages, optionally filtered by name. */
export async function searchLanguages(deps: LookupDeps, workspaceId: string, query?: string) {
  const q = String(query || "").trim();
  const ctx = await googleCtx(deps, workspaceId);
  if (!ctx) return q ? FALLBACK_LANGUAGES.filter((l) => l.name.toLowerCase().includes(q.toLowerCase())) : FALLBACK_LANGUAGES;
  try {
    // Escaping matters: the query is interpolated into GAQL, so quotes must not break out.
    const safe = q.replace(/['\\]/g, "");
    let gaql = "SELECT language_constant.id, language_constant.code, language_constant.name FROM language_constant WHERE language_constant.targetable = TRUE";
    if (safe) gaql += ` AND language_constant.name LIKE '%${safe}%'`;
    const rows = await searchStream(ctx, gaql);
    return rows.map((r: any) => {
      const l = r.languageConstant || {};
      return { id: l.code, code: l.code, name: l.name, constantId: Number(l.id) };
    });
  } catch {
    return FALLBACK_LANGUAGES;
  }
}

/** Merchant Center products linked to the account, for Shopping campaigns. */
export async function merchantProducts(deps: LookupDeps, workspaceId: string) {
  const ctx = await googleCtx(deps, workspaceId);
  if (!ctx) return [];

  let merchantId = String(
    ctx.meta?.merchantCenterId ||
    (ctx.connection?.meta as any)?.merchantCenterId ||
    deps.env.GOOGLE_MERCHANT_CENTER_ID ||
    ""
  ).trim();

  const rememberMerchantId = async (mId: string) => {
    if (ctx.connection?.id) {
      await deps.db
        .update(platformConnections)
        .set({ meta: { ...(ctx.meta || {}), merchantCenterId: mId }, updatedAt: new Date() })
        .where(eq(platformConnections.id, ctx.connection.id))
        .catch(() => null);
    }
  };

  // 1. Auto-discover Merchant Center account via Google Merchant API v1 or Content API authinfo on-the-fly
  if (!merchantId) {
    try {
      const mRes = await fetch("https://merchantapi.googleapis.com/accounts/v1beta/accounts", {
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (mRes.ok) {
        const mData: any = await mRes.json();
        const first = (mData.accounts || [])[0];
        const mId = first?.accountId || (first?.name ? first.name.split("/").pop() : null);
        if (mId) {
          merchantId = String(mId);
          await rememberMerchantId(merchantId);
        }
      }
    } catch { /* ignore */ }
  }

  if (!merchantId) {
    try {
      const authRes = await fetch("https://shoppingcontent.googleapis.com/content/v2.1/accounts/authinfo", {
        headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (authRes.ok) {
        const authData: any = await authRes.json();
        const first = (authData.accountIdentifiers || [])[0];
        const mId = String(first?.merchantId || first?.accountId || "").trim();
        if (mId) {
          merchantId = mId;
          await rememberMerchantId(merchantId);
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Check Google Ads product_link on customer account
  if (!merchantId) {
    try {
      const rows = await searchStream(ctx, "SELECT product_link.product_link_id, product_link.merchant_center.merchant_center_id FROM product_link WHERE product_link.type = 'MERCHANT_CENTER' LIMIT 1");
      merchantId = rows[0]?.productLink?.merchantCenter?.merchantCenterId || "";
    } catch { /* ignore */ }
  }

  if (!merchantId) {
    try {
      const rows = await searchStream(ctx, "SELECT product_link_invitation.product_link_invitation_id, product_link_invitation.merchant_center.merchant_center_id FROM product_link_invitation WHERE product_link_invitation.type = 'MERCHANT_CENTER' LIMIT 1");
      merchantId = rows[0]?.productLinkInvitation?.merchantCenter?.merchantCenterId || "";
    } catch { /* ignore */ }
  }

  if (merchantId) {
    // Auto-link Google Ads customer account and Merchant Center account (ported from ReachGit)
    await linkMerchantCenterAccount(ctx as any, merchantId).catch(() => null);

    try {
      const contentUrl = `https://shoppingcontent.googleapis.com/content/v2.1/${merchantId}/products`;
      const contentRes = await fetch(contentUrl, {
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
      if (contentRes.ok) {
        const contentData: any = await contentRes.json();
        const resources = contentData?.resources || [];
        if (resources.length > 0) {
          return resources.map((item: any) => ({
            id: item.offerId || item.id?.split(":").pop() || String(item.id),
            title: item.title || "Merchant Product",
            brand: item.brand || null,
            price: item.price ? `${item.price.currency || "SEK"} ${item.price.value || "1.00"}` : (item.price?.value ? Number(item.price.value) : null),
            currency: item.price?.currency || "SEK",
            status: item.availability === "in stock" ? "In stock" : (item.availability || "Active"),
            availability: item.availability || "In stock",
            url: item.link || "",
            imageUrl: item.imageLink || item.additionalImageLinks?.[0] || "",
          }));
        }
      }
    } catch { /* ignore */ }
  }

  try {
    const rows = await searchStream(ctx, "SELECT shopping_product.item_id, shopping_product.title, shopping_product.brand, shopping_product.price_micros, shopping_product.currency_code FROM shopping_product LIMIT 200");
    return rows.map((r: any) => {
      const p = r.shoppingProduct || {};
      return {
        id: p.itemId,
        title: p.title || "Product",
        brand: p.brand || null,
        price: p.priceMicros ? Number(p.priceMicros) / 1e6 : null,
        currency: p.currencyCode || null,
        status: "Active",
        availability: "In stock",
        url: "",
        imageUrl: "",
      };
    });
  } catch {
    return [];
  }
}

/**
 * Is the landing page actually reachable, and what does it look like? Returned rather than
 * thrown even on failure — the wizard shows this as a warning, it never blocks saving.
 */
export async function previewLandingPage(url: string) {
  const target = String(url || "").trim();
  if (!target) return { url: "", reachable: false, error: "No landing page URL provided" };
  if (!/^https?:\/\/[^\s]+$/i.test(target)) return { url: target, reachable: false, error: "Invalid landing page URL" };
  try {
    const r = await fetch(target, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ReachBot/1.0; +https://reach.app) AppleWebKit/537.36 (KHTML, like Gecko)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = (await r.text()).slice(0, 500_000);
    return {
      url: target,
      finalUrl: r.url || target,
      statusCode: r.status,
      title: /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim(),
      ogImage: /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1],
      reachable: r.ok,
      error: r.ok ? undefined : `HTTP ${r.status}`,
    };
  } catch (e: any) {
    return { url: target, reachable: false, error: e?.message || String(e) };
  }
}
