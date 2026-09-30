// Website → brand draft. Port of the old lib/brand-scrape.js.
// cheerio can't run on Workers, so HTML parsing is done with targeted
// regexes (meta/headings/images/JSON-LD/footer/CSS). Gemini extraction and
// the heuristic fallback are faithful ports.
import { brandProfiles, websiteScrapedAssets, workspaces } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { eq } from "drizzle-orm";
import { generateJson, type AiEnv } from "./ai-text.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const OBJECTIVES = ["local_visits", "website_visitors", "online_sales", "leads", "messages", "awareness"];

export const STEPS = [
  { key: "fetch", label: "Fetching your site" },
  { key: "read", label: "Reading pages & copy" },
  { key: "extract", label: "Extracting brand & visuals" },
  { key: "draft", label: "Drafting your profile" },
];

export function normalizeUrl(input: string): string {
  let u = String(input || "").trim();
  if (!u) throw new Error("URL required");
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (!/\./.test(parsed.hostname)) throw new Error("That doesn't look like a website address");
  return parsed.toString();
}

const abs = (v: string | undefined | null, base: string): string => {
  if (!v) return "";
  try {
    return new URL(v, base).toString();
  } catch {
    return "";
  }
};

async function fetchText(url: string, { timeoutMs = 15000, maxBytes = 1_500_000 } = {}): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/css;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Failed to fetch website content: ${r.status} ${r.statusText}`);
  const ab = await r.arrayBuffer();
  const slice = ab.byteLength > maxBytes ? ab.slice(0, maxBytes) : ab;
  return new TextDecoder("utf-8").decode(slice);
}

/* ---------- lightweight HTML parsing (no DOM on Workers) ---------- */

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim();
}

/** All <meta> tags as {key, value} where key is property/name (lowercased). */
function metaTags(html: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    const value = attr(tag, "content");
    if (key && value) out.push({ key, value: decodeEntities(value) });
  }
  return out;
}

const metaGet = (tags: { key: string; value: string }[], ...keys: string[]): string => {
  for (const k of keys) {
    const hit = tags.find((t) => t.key === k.toLowerCase());
    if (hit) return hit.value;
  }
  return "";
};

function linkHrefs(html: string, rel: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rels = attr(tag, "rel").toLowerCase().split(/\s+/);
    if (rels.includes(rel.toLowerCase())) {
      const h = abs(attr(tag, "href"), base);
      if (h) out.push(h);
    }
  }
  return out;
}

export interface ScrapeContext {
  url: string;
  meta: {
    title: string;
    description: string;
    keywords: string[];
    siteName: string;
    themeColor: string;
    ogImage: string;
    favicon: string;
    logo: string;
    lang: string;
    inlineLogoSvg?: string | null;
  };
  headings: string[];
  ctaButtons: string[];
  socialLinks: Record<string, string>;
  imageCandidates: { src: string; alt: string; width: number | null; height: number | null }[];
  headHtml: string;
  bodyText: string;
  footerText: string;
  jsonLdData: any[];
  cssVariables: Record<string, string>;
  cssColors: string[];
  cssFonts: string[];
}

export async function buildScrapeContext(inputUrl: string, onStep: (key: string, status: string) => Promise<void> | void = async () => {}): Promise<ScrapeContext> {
  const url = normalizeUrl(inputUrl);
  await onStep("fetch", "running");
  const html = await fetchText(url);
  await onStep("fetch", "done");
  await onStep("read", "running");

  const tags = metaTags(html);
  const title = metaGet(tags, "og:title") || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim()) || "";
  const htmlLang = html.match(/<html\b[^>]*>/i)?.[0] || "";
  const meta = {
    title,
    description: metaGet(tags, "description", "og:description"),
    keywords: (metaGet(tags, "keywords") || "").split(",").map((s) => s.trim()).filter(Boolean),
    siteName: metaGet(tags, "og:site_name"),
    themeColor: metaGet(tags, "theme-color"),
    ogImage: abs(metaGet(tags, "og:image"), url),
    favicon:
      linkHrefs(html, "apple-touch-icon", url)[0] ||
      linkHrefs(html, "icon", url)[0] ||
      linkHrefs(html, "shortcut icon", url)[0] ||
      abs("/favicon.ico", url),
    logo: "",
    lang: attr(htmlLang, "lang") || "",
  };
  meta.logo = abs(metaGet(tags, "og:logo", "logo"), url) || linkHrefs(html, "logo", url)[0] || "";

  // Header/nav blocks (for logo proximity scoring).
  const headerBlocks: string[] = [];
  for (const m of html.matchAll(/<(header|nav)\b[\s\S]*?<\/\1>/gi)) headerBlocks.push(m[0]);
  const headerHtml = headerBlocks.join("\n");

  if (!meta.logo) {
    let best = "", score = -1;
    for (const m of html.matchAll(/<(img|svg)\b[^>]*>/gi)) {
      const tag = m[0];
      const src = attr(tag, "src") || attr(tag, "srcset").split(/[\s,]+/)[0] || attr(tag, "data-src") || attr(tag, "href") || "";
      const hay = `${src} ${attr(tag, "alt")} ${attr(tag, "class")} ${attr(tag, "id")}`.toLowerCase();
      let s = 0;
      if (hay.includes("logo")) s += 6;
      if (hay.includes("brand")) s += 3;
      if (src && headerHtml.includes(tag.slice(0, 60))) s += 4;
      if (/\.svg(\?|$)/i.test(src)) s += 2;
      if (s > score && src) {
        score = s;
        best = src;
      }
    }
    if (score > 0 && best) meta.logo = abs(best, url);
  }
  // Inline SVG logo inside header/nav/logo links.
  let inlineLogoSvg: string | null = null;
  if (!meta.logo) {
    for (const m of headerHtml.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
      const svg = m[0];
      if (svg.length > 50 && svg.length < 100000) {
        inlineLogoSvg = svg;
        break;
      }
    }
  }
  if (!meta.logo && !inlineLogoSvg) {
    meta.logo = linkHrefs(html, "apple-touch-icon", url)[0] || meta.favicon || meta.ogImage || "";
  }

  const headings: string[] = [];
  for (const m of html.matchAll(/<h[123]\b[^>]*>([\s\S]*?)<\/h[123]>/gi)) {
    const t = stripTags(decodeEntities(m[1] ?? ""));
    if (t.length > 2 && t.length < 200 && headings.length < 40) headings.push(t);
  }
  const ctaButtons: string[] = [];
  for (const m of html.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[0];
    const cls = attr(tag.split(">")[0] + ">", "class") + " " + attr(tag.split(">")[0] + ">", "role");
    if (m[1] === "button" || /btn|button|cta/i.test(cls)) {
      const t = stripTags(decodeEntities(m[2] ?? ""));
      if (t && t.length < 40 && !ctaButtons.includes(t) && ctaButtons.length < 12) ctaButtons.push(t);
    }
  }
  const socialLinks: Record<string, string> = {};
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)) {
    const h = (m[2] ?? m[3] ?? m[4] ?? "").toLowerCase();
    for (const k of ["instagram", "facebook", "linkedin", "tiktok", "reddit", "youtube", "pinterest"]) if (h.includes(`${k}.com`)) socialLinks[k] ||= h;
    if (/twitter\.com|x\.com\//.test(h)) socialLinks.twitter ||= h;
  }
  const imageCandidates: ScrapeContext["imageCandidates"] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = abs(attr(tag, "src") || attr(tag, "data-src"), url);
    if (src && !/\.(svg|gif)$/i.test(src) && imageCandidates.length < 25) {
      imageCandidates.push({ src, alt: attr(tag, "alt").slice(0, 120), width: Number(attr(tag, "width")) || null, height: Number(attr(tag, "height")) || null });
    }
  }
  const jsonLdData: any[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1] ?? "null");
      if (parsed) jsonLdData.push(parsed);
    } catch {
      /* ignore */
    }
  }
  // Footer / contact text before stripping.
  let footerText = "";
  for (const m of html.matchAll(/<(footer|address)\b[^>]*>([\s\S]*?)<\/\1>/gi)) footerText += " " + m[2];
  for (const m of html.matchAll(/<(div|section)\b[^>]*class\s*=\s*["'][^"']*(footer|contact)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi)) footerText += " " + m[3];
  footerText = stripTags(decodeEntities(footerText)).slice(0, 3000);

  const headHtml = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] || "";
  let body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
  body = body.replace(/<(script|style|noscript|svg|iframe|nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ");
  const bodyText = stripTags(decodeEntities(body)).slice(0, 20000);

  // CSS: inline <style> + up to 3 same-origin stylesheets.
  let css = "";
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css += m[1] + "\n";
  const links: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (/stylesheet/i.test(attr(tag, "rel"))) {
      const h = abs(attr(tag, "href"), url);
      if (h) {
        try {
          if (new URL(h).origin === new URL(url).origin && links.length < 3) links.push(h);
        } catch {
          /* ignore */
        }
      }
    }
  }
  for (const l of links) {
    try {
      css += "\n" + (await fetchText(l, { timeoutMs: 8000, maxBytes: 250_000 }));
    } catch {
      /* ignore */
    }
  }
  const cssVariables: Record<string, string> = {};
  for (const m of css.matchAll(/(--[a-z0-9-]*(?:color|primary|secondary|accent|brand|bg|background)[a-z0-9-]*)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi)) {
    const vk = m[1], vv = m[2]; if (vk && vv && Object.keys(cssVariables).length < 20) cssVariables[vk] = vv;
  }
  const colorCount = new Map<string, number>();
  for (const m of css.matchAll(/#[0-9a-f]{6}\b/gi)) {
    const c = (m[0] || "").toLowerCase();
    if (!/^#(fff|000|ffffff|000000)/.test(c)) colorCount.set(c, (colorCount.get(c) || 0) + 1);
  }
  const cssColors = [...colorCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) => c);
  const fontCount = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const f = ((m[1] || "").split(",")[0] || "").replace(/['"]/g, "").trim();
    if (f && !/inherit|sans-serif|serif|monospace|system-ui|-apple-system/i.test(f)) fontCount.set(f, (fontCount.get(f) || 0) + 1);
  }
  const cssFonts = [...fontCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f]) => f);

  await onStep("read", "done");
  return { url, meta: { ...meta, inlineLogoSvg }, headings, ctaButtons, socialLinks, imageCandidates, headHtml, bodyText, footerText, jsonLdData, cssVariables, cssColors, cssFonts };
}

/* ---------- Gemini extraction + heuristic fallback ---------- */

const PROMPT = (c: ScrapeContext) => `You are a brand intelligence extractor for an ads platform. Analyze the website data and return ONLY valid JSON matching this exact schema:
{
  "business": { "name": "string", "descriptor": "short line like 'Specialty coffee roastery · Stockholm'", "industry": "string", "location": "city, country", "tagline": "string", "description": "2-3 sentences", "targetAudience": "string", "keyProductsServices": ["string"] },
  "branding": { "logoUrl": "string", "faviconUrl": "string", "colors": { "primary": "hex", "secondary": "hex", "accent": "hex", "background": "hex" }, "fonts": { "heading": "string", "body": "string" }, "socialLinks": { "instagram": "", "facebook": "", "linkedin": "", "twitter": "", "tiktok": "", "reddit": "", "youtube": "", "pinterest": "" } },
  "toneOfVoice": ["2-4 short traits, e.g. 'Warm & craft-focused', 'Direct, no jargon'"],
  "audience": { "ageRange": "e.g. 25-45", "interests": ["string"], "location": "string", "summary": "one line like 'Urban 25–45 · coffee enthusiasts'" },
  "keywords": ["6-10 short keywords"],
  "suggestedCampaigns": [ { "name": "string", "objective": "one of ${OBJECTIVES.join("|")}", "platforms": ["meta","google_ads","tiktok"], "angle": "one line" } ]
}
Rules: absolute URLs for logo/favicon; infer when not explicit; prefer CSS variables and theme-color for colors; unknown → empty string/array; 2-3 suggested campaigns; write in the site's language for copy fields but keep keys as-is; no markdown.

Website URL: ${c.url}
Meta title: ${c.meta.title}
Meta description: ${c.meta.description}
Site name: ${c.meta.siteName}
Language: ${c.meta.lang}
Theme color: ${c.meta.themeColor}
Detected logo: ${c.meta.logo}
Detected favicon: ${c.meta.favicon}
OG image: ${c.meta.ogImage}
Headings: ${JSON.stringify(c.headings.slice(0, 25))}
CTA buttons: ${JSON.stringify(c.ctaButtons)}
Image candidates: ${JSON.stringify(c.imageCandidates.slice(0, 15))}
CSS variables: ${JSON.stringify(c.cssVariables)}
CSS colors: ${JSON.stringify(c.cssColors)}
CSS fonts: ${JSON.stringify(c.cssFonts)}
Social links: ${JSON.stringify(c.socialLinks)}

HEAD HTML:
${c.headHtml.slice(0, 3000)}

MAIN CONTENT:
${c.bodyText.slice(0, 9000)}`;

function heuristic(c: ScrapeContext): Record<string, any> {
  const host = new URL(c.url).hostname.replace(/^www\./, "");
  const name = c.meta.siteName || ((c.meta.title || host).split(/[|–-]/)[0] || "").trim() || host;
  return {
    business: { name, descriptor: "", industry: "", location: "", tagline: c.headings[0] || "", description: c.meta.description || "", targetAudience: "", keyProductsServices: c.headings.slice(1, 5) },
    branding: {
      logoUrl: c.meta.logo,
      faviconUrl: c.meta.favicon,
      colors: { primary: c.meta.themeColor || c.cssColors[0] || "#2563EB", secondary: c.cssColors[1] || "#64748B", accent: c.cssColors[2] || "#F59E0B", background: "#FFFFFF" },
      fonts: { heading: c.cssFonts[0] || "", body: c.cssFonts[1] || c.cssFonts[0] || "" },
      socialLinks: c.socialLinks,
    },
    toneOfVoice: [],
    audience: { ageRange: "", interests: [], location: "", summary: "" },
    keywords: c.meta.keywords.slice(0, 10),
    suggestedCampaigns: [],
    _heuristic: true,
  };
}

function normalize(r: Record<string, any>, c: ScrapeContext): Record<string, any> {
  const h = heuristic(c);
  const b = r.business || {};
  const br = r.branding || {};
  return {
    business: { ...h.business, ...b, name: b.name || h.business.name },
    branding: {
      ...h.branding,
      ...br,
      logoUrl: br.logoUrl || h.branding.logoUrl,
      faviconUrl: br.faviconUrl || h.branding.faviconUrl,
      colors: { ...h.branding.colors, ...(br.colors || {}) },
      fonts: { ...h.branding.fonts, ...(br.fonts || {}) },
      socialLinks: { ...h.branding.socialLinks, ...(br.socialLinks || {}) },
    },
    toneOfVoice: Array.isArray(r.toneOfVoice) ? r.toneOfVoice.slice(0, 4) : [],
    audience: { ...h.audience, ...(r.audience || {}) },
    keywords: Array.isArray(r.keywords) && r.keywords.length ? r.keywords.slice(0, 10) : h.keywords,
    suggestedCampaigns: (Array.isArray(r.suggestedCampaigns) ? r.suggestedCampaigns : [])
      .filter((s: any) => s?.name)
      .slice(0, 3)
      .map((s: any) => ({ ...s, objective: OBJECTIVES.includes(s.objective) ? s.objective : "website_visitors" })),
  };
}

export async function extractBrand(
  env: AiEnv,
  db: Db,
  c: ScrapeContext,
  onStep: (key: string, status: string) => Promise<void> | void = async () => {},
): Promise<Record<string, any>> {
  await onStep("extract", "running");
  let result: Record<string, any> | null = null;
  let source = "heuristic";
  try {
    const parsed = await generateJson(env, db, PROMPT(c));
    result = normalize(parsed, c);
    source = "gemini";
  } catch (e: any) {
    // No API key (503 AI_UNCONFIGURED) or a generation failure → heuristic draft.
    console.warn(`[brand-scrape] extraction failed, heuristic fallback: ${e?.message}`);
  }
  await onStep("extract", "done");
  await onStep("draft", "running");
  if (!result) result = heuristic(c);
  await onStep("draft", "done");
  return { ...result, _source: source };
}

/** Persist crawl details for later media/creative generation. */
export async function storeScrapedAssets(db: Db, c: ScrapeContext, { workspaceId = null as string | null } = {}): Promise<string> {
  const inserted = await db
    .insert(websiteScrapedAssets)
    .values({
      workspace_id: workspaceId,
      url: c.url,
      title: c.meta.title || null,
      metaDescription: c.meta.description || null,
      metaKeywords: c.meta.keywords || [],
      headings: c.headings || [],
      bodyText: c.bodyText.slice(0, 20000),
      ctaButtons: c.ctaButtons || [],
      images: c.imageCandidates || [],
      brandColors: c.cssColors || [],
      brandName: c.meta.siteName || "",
      fonts: c.cssFonts || [],
      extractedAt: new Date(),
    })
    .returning({ id: websiteScrapedAssets.id });
  return inserted[0]!.id;
}

/** Apply a finished draft result to a workspace: upsert brand profile, update workspace summary. */
export async function applyBrandToWorkspace(
  db: Db,
  { result, sourceUrl, workspaceId, accountId }: { result: Record<string, any>; sourceUrl: string; workspaceId: string; accountId: string },
): Promise<string> {
  const existing = await db.select().from(brandProfiles).where(eq(brandProfiles.workspace_id, workspaceId)).limit(1);
  const bp = (existing[0] as unknown as Record<string, any> | undefined) ?? null;
  const data = {
    workspace_id: workspaceId,
    account_id: accountId,
    sourceUrl,
    business: result.business,
    branding: result.branding,
    toneOfVoice: result.toneOfVoice,
    audience: result.audience,
    keywords: result.keywords,
    suggestedCampaigns: result.suggestedCampaigns,
    scrapeStatus: "ready" as const,
    scrapeError: null,
    lastScrapedAt: new Date(),
  };
  let id: string;
  if (bp) {
    await db.update(brandProfiles).set({ ...data, updatedAt: new Date() }).where(eq(brandProfiles.id, bp.id));
    id = bp.id;
  } else {
    const ins = await db.insert(brandProfiles).values(data as typeof brandProfiles.$inferInsert).returning({ id: brandProfiles.id });
    id = ins[0]!.id;
  }
  const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const ws = (wsRows[0] as unknown as Record<string, any> | undefined) ?? null;
  await db
    .update(workspaces)
    .set({
      websiteUrl: sourceUrl,
      industry: result.business?.industry || ws?.industry || null,
      descriptor: result.business?.descriptor || ws?.descriptor || null,
      ...(ws?.onboardingState === "pending" ? { onboardingState: "brand_ready" } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
  return id;
}
