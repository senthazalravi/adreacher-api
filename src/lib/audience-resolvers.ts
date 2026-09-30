/**
 * Fan a free-text audience query out to every selected platform's own suggest
 * API and merge the answers into ONE canonical entry per real-world place.
 *
 * Port of the old lib/audience-resolvers.js, backed by Drizzle/D1. Meta's
 * location/interest search is inlined here (ported from lib/meta-campaigns.js)
 * since the Automated Ads draft wizard itself is out of scope for this phase.
 */
import { FALLBACK_LOCATIONS, searchGeoTargets, type LookupDeps } from "./google-lookups.js";
import { getConnectionConfig } from "./connections.js";
import { GRAPH, request } from "./providers/meta-ads.js";

const norm = (s: unknown) => String(s || "").trim().toLowerCase();

/** "Stockholm" + "SE" -> "se::stockholm". The key two platforms must agree on. */
export const placeKey = (name: string, countryCode?: string) => `${norm(countryCode)}::${norm(name)}`;

/** Google's "City" and Meta's "city" must land on the same canonical type. */
const normType = (t: unknown) => {
  const v = norm(t);
  if (v.includes("city") || v.includes("municipal")) return "city";
  if (v.includes("region") || v.includes("state") || v.includes("province")) return "region";
  if (v.includes("country") || v.includes("nation")) return "country";
  return v || "location";
};

/** Meta access token for a workspace (throws when Meta is not connected). */
async function metaToken(deps: LookupDeps, workspaceId: string): Promise<string> {
  const { connection } = await getConnectionConfig(deps.db, deps.env, deps.secretKey, workspaceId, "meta");
  const token = (connection as Record<string, any> | null)?.accessToken;
  if (!token) throw new Error("Meta is not connected for this workspace");
  return String(token);
}

async function metaSearchLocations(deps: LookupDeps, workspaceId: string, q: string) {
  if (!String(q || "").trim()) return [];
  const accessToken = await metaToken(deps, workspaceId);
  const d: any = await request("GET", `${GRAPH}/search`, accessToken, {
    type: "adgeolocation", location_types: ["region", "city", "country"], q: String(q).trim(), limit: 15,
  });
  return (d.data || []).map((l: any) => ({ id: String(l.key ?? ""), name: String(l.name ?? ""), type: String(l.type ?? ""), countryCode: String(l.country_code ?? "") }));
}

async function metaSearchInterests(deps: LookupDeps, workspaceId: string, q: string) {
  if (!String(q || "").trim()) return [];
  const accessToken = await metaToken(deps, workspaceId);
  const d: any = await request("GET", `${GRAPH}/search`, accessToken, { type: "adinterest", q: String(q).trim(), limit: 15 });
  return (d.data || [])
    .map((i: any) => ({
      id: String(i.id ?? ""),
      name: String(i.name || "").trim(),
      category: i.topic || (i.audience_size_lower_bound ? "interest" : undefined),
    }))
    .filter((i: any) => /^\d+$/.test(i.id) && i.name);
}

interface FlatHit { id: string; name: string; countryCode: string; type: string; }

const resolveBingLocations = async (deps: LookupDeps, workspaceId: string, q: string): Promise<FlatHit[]> => {
  const qLower = norm(q);
  // 1. Try Google Ads suggest if available for real-world geo suggestions
  try {
    const targets = await searchGeoTargets(deps, workspaceId, q);
    if (targets && targets.length > 0) {
      return targets.map((r: any) => ({
        id: r.countryCode || String(r.id),
        name: r.name,
        countryCode: r.countryCode || "",
        type: normType(r.targetType),
      }));
    }
  } catch { /* fall through */ }

  // 2. Fallback specifically for Bing with proper country codes (matches old project)
  const matched = qLower
    ? FALLBACK_LOCATIONS.filter((l) => norm(l.name).includes(qLower) || norm(l.countryCode).includes(qLower))
    : FALLBACK_LOCATIONS;

  return matched.map((l) => ({
    id: l.countryCode,
    name: l.name,
    countryCode: l.countryCode,
    type: "country",
  }));
};

const resolveXLocations = async (deps: LookupDeps, workspaceId: string, q: string): Promise<FlatHit[]> => {
  const qLower = norm(q);
  try {
    const targets = await searchGeoTargets(deps, workspaceId, q);
    if (targets && targets.length > 0) {
      return targets.map((r: any) => ({
        id: r.countryCode || String(r.id),
        name: r.name,
        countryCode: r.countryCode || "",
        type: normType(r.targetType),
      }));
    }
  } catch { /* fall through */ }

  const matched = qLower
    ? FALLBACK_LOCATIONS.filter((l) => norm(l.name).includes(qLower) || norm(l.countryCode).includes(qLower))
    : FALLBACK_LOCATIONS;

  return matched.map((l) => ({
    id: l.countryCode,
    name: l.name,
    countryCode: l.countryCode,
    type: "country",
  }));
};

type LocationResolver = (deps: LookupDeps, workspaceId: string, q: string) => Promise<FlatHit[]>;

/**
 * Each resolver returns a flat list of
 * `{ id, name, countryCode, type }` in that platform's own vocabulary.
 * Failure is never fatal — a platform that throws contributes nothing.
 */
const LOCATION_RESOLVERS: Record<string, LocationResolver> = {
  google: async (deps, workspaceId, q) =>
    (await searchGeoTargets(deps, workspaceId, q)).map((r: any) => ({
      id: String(r.id), name: r.name, countryCode: r.countryCode || "", type: normType(r.targetType),
    })),
  meta: async (deps, workspaceId, q) =>
    ((await metaSearchLocations(deps, workspaceId, q)) || []).map((r: any) => ({
      id: String(r.id), name: r.name, countryCode: r.countryCode || "", type: normType(r.type),
    })),
  bing: resolveBingLocations,
  bing_ads: resolveBingLocations,
  "bing-ads": resolveBingLocations,
  microsoft: resolveBingLocations,
  microsoft_ads: resolveBingLocations,
  "microsoft-ads": resolveBingLocations,
  x: resolveXLocations,
  twitter: resolveXLocations,
};

/** Meta has a real interest taxonomy; Google and TikTok do not (spec: degrade to keywords). */
const INTEREST_RESOLVERS: Record<string, LocationResolver> = {
  meta: async (deps, workspaceId, q) =>
    ((await metaSearchInterests(deps, workspaceId, q)) || []).map((r: any) => ({
      id: String(r.id), name: r.name, countryCode: "", type: "interest",
    })),
};

/**
 * `perPlatform` is `{ slug: [{id,name,countryCode,type}, …] }`.
 * Merge on placeKey so one real place becomes one entry carrying every
 * platform's id. A platform that found nothing for a place gets `null`.
 */
export function mergeByPlace(perPlatform: Record<string, FlatHit[]>, unavailable: string[] = []) {
  const slugs = Object.keys(perPlatform);
  const byKey = new Map<string, any>();
  for (const slug of slugs) {
    for (const hit of perPlatform[slug] || []) {
      if (!hit?.name) continue;
      const key = placeKey(hit.name, hit.countryCode);
      if (!byKey.has(key)) {
        byKey.set(key, { key, name: hit.name, countryCode: hit.countryCode || "", type: hit.type, resolved: {} });
      }
      const entry = byKey.get(key);
      // First writer wins on display fields; later platforms only add their id.
      if (!entry.resolved[slug]) entry.resolved[slug] = { id: hit.id, name: hit.name };
      if (slug.startsWith("bing") || slug.startsWith("microsoft")) {
        if (!entry.resolved.bing) entry.resolved.bing = { id: hit.id, name: hit.name };
        if (!entry.resolved.bing_ads) entry.resolved.bing_ads = { id: hit.id, name: hit.name };
      }
      if (slug === "x" || slug === "twitter") {
        if (!entry.resolved.x) entry.resolved.x = { id: hit.id, name: hit.name };
        if (!entry.resolved.twitter) entry.resolved.twitter = { id: hit.id, name: hit.name };
      }
    }
  }
  // Every requested platform appears in every entry, so `null` is explicit
  // rather than "key missing" — the UI needs to show which platforms missed.
  //
  // `unavailable` names the platforms whose search could not run at all (not
  // connected, expired token, API down). Those are NOT "this place does not
  // exist there": collapsing the two is how a transient auth failure got
  // written into a saved campaign as a permanent "not on Meta".
  for (const entry of byKey.values()) {
    for (const slug of slugs) {
      if (!entry.resolved[slug]) {
        if ((slug.startsWith("bing") || slug.startsWith("microsoft")) && entry.resolved.bing) {
          entry.resolved[slug] = entry.resolved.bing;
        } else if ((slug === "x" || slug === "twitter") && entry.resolved.x) {
          entry.resolved[slug] = entry.resolved.x;
        } else {
          entry.resolved[slug] = null;
        }
      }
    }
  }
  const rows = [...byKey.values()];
  if (unavailable?.length) for (const entry of rows) entry.unavailable = [...unavailable];
  return rows;
}

const fanOut = async (
  resolvers: Record<string, LocationResolver>,
  deps: LookupDeps,
  workspaceId: string,
  query: string,
  slugs: string[],
) => {
  const active = slugs.filter((s) => resolvers[s]);
  const settled = await Promise.allSettled(active.map((s) => resolvers[s]!(deps, workspaceId, query)));
  const perPlatform: Record<string, FlatHit[]> = {};
  const unavailable: string[] = [];
  active.forEach((slug, i) => {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      perPlatform[slug] = r.value;
      return;
    }
    // The platform could not be searched — report that separately so the
    // caller never records "not on <platform>" for a place it never got to ask about.
    perPlatform[slug] = [];
    unavailable.push(slug);
  });
  return mergeByPlace(perPlatform, unavailable);
};

export const resolveLocations = (deps: LookupDeps, workspaceId: string, query: string, slugs: string[]) =>
  fanOut(LOCATION_RESOLVERS, deps, workspaceId, query, slugs);

export const resolveInterests = (deps: LookupDeps, workspaceId: string, query: string, slugs: string[]) =>
  fanOut(INTEREST_RESOLVERS, deps, workspaceId, query, slugs);
