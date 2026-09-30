// Campaign landing pages: generate (AI — Phase 5), read, approve, public serve.
// Port of the old lib/landing-pages.js, backed by Drizzle/D1.
import { eq } from "drizzle-orm";
import { campaignLandingPages, campaignPosts, campaigns, posts } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";
import { brandFor, type BrandView } from "./creatives.js";

const MAX_TEXT = 2000;

export function sanitizeText(value: unknown, maxLength = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  return [...value]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || c === 13 || c >= 32;
    })
    .join("")
    .replace(/<[^>]*>/g, " ")
    .replace(/(?:javascript|data|vbscript)\s*:/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const safeUrl = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};
const safeColor = (v: unknown) =>
  typeof v === "string" && /^(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i.test(v.trim()) ? v.trim() : undefined;
const safeFont = (v: unknown) => {
  const s = sanitizeText(v, 80);
  return /^[a-z0-9 ,'_-]+$/i.test(s) ? s : undefined;
};
const RADII = ["none", "small", "medium", "large"];

/**
 * Coerce whatever the model returned into the stored shape. Anything unrecognised is dropped,
 * never passed through — `allowedAssets` is the whitelist of image URLs from the campaign.
 */
function normalise(raw: any, allowedAssets: string[]) {
  const allowed = new Set(allowedAssets.filter(Boolean));
  const img = (v: unknown) => {
    const u = safeUrl(v);
    return u && allowed.has(u) ? u : undefined;
  };
  const c = raw?.content || {};
  const hero = c.hero || {};
  return {
    content: {
      brandName: sanitizeText(c.brandName, 160) || undefined,
      logoUrl: img(c.logoUrl),
      hero: {
        eyebrow: sanitizeText(hero.eyebrow, 120) || undefined,
        headline: sanitizeText(hero.headline, 180),
        subheadline: sanitizeText(hero.subheadline, 300),
        body: sanitizeText(hero.body, 1200),
        ctaLabel: sanitizeText(hero.ctaLabel, 60) || "Learn more",
        imageUrl: img(hero.imageUrl),
      },
      benefits: (Array.isArray(c.benefits) ? c.benefits : [])
        .slice(0, 8)
        .map((b: any) => ({ title: sanitizeText(b?.title, 120), description: sanitizeText(b?.description, 500) }))
        .filter((b: any) => b.title),
      sections: (Array.isArray(c.sections) ? c.sections : [])
        .slice(0, 8)
        .map((sn: any) => ({ heading: sanitizeText(sn?.heading, 160), body: sanitizeText(sn?.body, 1600), imageUrl: img(sn?.imageUrl) }))
        .filter((sn: any) => sn.heading),
      footerText: sanitizeText(c.footerText, 300) || undefined,
    },
    theme: {
      primaryColor: safeColor(raw?.theme?.primaryColor),
      accentColor: safeColor(raw?.theme?.accentColor),
      backgroundColor: safeColor(raw?.theme?.backgroundColor),
      textColor: safeColor(raw?.theme?.textColor),
      fontFamily: safeFont(raw?.theme?.fontFamily),
      headingFontFamily: safeFont(raw?.theme?.headingFontFamily),
      borderRadius: RADII.includes(raw?.theme?.borderRadius) ? raw.theme.borderRadius : "medium",
    },
  };
}

/** A usable page built from what we already know, for when the model fails entirely. */
function fallbackPage(campaign: Record<string, any>, brand: BrandView, post: Record<string, any> | null, allowedAssets: string[]) {
  const fv = post?.fieldValues || {};
  const headlines = (fv.headlines || []).filter(Boolean);
  return normalise(
    {
      content: {
        brandName: brand.name,
        logoUrl: brand.logoUrl,
        hero: {
          eyebrow: brand.industry || undefined,
          headline: headlines[0] || post?.headline || campaign.name,
          subheadline: brand.tagline || (fv.descriptions || [])[0] || "",
          body: post?.body || brand.description || "",
          ctaLabel: post?.callToAction || "Learn more",
          imageUrl: (fv.mediaUrls || [])[0],
        },
        benefits: headlines.slice(1, 5).map((h: string) => ({ title: h, description: "" })),
        sections: [],
        footerText: brand.name,
      },
      theme: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, borderRadius: "medium" },
    },
    allowedAssets,
  );
}

/** Everything the model is allowed to draw on. Keeps generation grounded in real assets. */
async function buildSource(db: Db, campaign: Record<string, any>) {
  const brand = await brandFor(db, campaign.workspace_id);
  const links = await db.select().from(campaignPosts).where(eq(campaignPosts.campaign_id, campaign.id)).limit(10);
  const postRows: Record<string, any>[] = [];
  for (const l of links as any[]) {
    if (!l.post_id) continue;
    const pr = await db.select().from(posts).where(eq(posts.id, l.post_id)).limit(1);
    if (pr[0]) postRows.push({ ...(pr[0] as any), _linkTargeting: l.targeting });
  }
  const allPosts = postRows;
  const fv = allPosts[0]?.fieldValues || {};
  const assetUrls = [
    ...new Set(
      [
        brand.logoUrl,
        ...(brand.references || []),
        ...(fv.mediaUrls || []),
        ...["logo", "landscape", "square", "portrait"].map((k) =>
          typeof fv.imageSet?.[k] === "string" ? fv.imageSet[k] : fv.imageSet?.[k]?.url,
        ),
      ].filter(Boolean),
    ),
  ];
  return {
    campaignName: campaign.name,
    objective: campaign.objective,
    originalLandingPageUrl: campaign.landingPageUrl || null,
    creatives: allPosts.slice(0, 3).map((p) => ({
      headline: p.headline, body: p.body, description: p.description,
      headlines: p.fieldValues?.headlines, descriptions: p.fieldValues?.descriptions,
      callToAction: p.callToAction,
    })),
    brand: {
      name: brand.name, industry: brand.industry, tagline: brand.tagline, description: brand.description,
      targetAudience: brand.audience, products: brand.products, logoUrl: brand.logoUrl,
      colors: { primary: brand.primaryColor, accent: brand.accentColor }, fonts: brand.fonts, assetUrls,
    },
    posts: allPosts,
    brandObj: brand,
    assetUrls,
  };
}

const slugify = (name: string, id: string) =>
  `${String(name || "campaign").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 48) || "campaign"}-${String(id).slice(0, 8)}`;

/** The CTA target: the approved landing page, else the post's own destination. */
const ctaTarget = (campaign: Record<string, any>, postList: Record<string, any>[]) =>
  [campaign.trackingFinalUrl, campaign.landingPageUrl, postList[0]?.destinationUrl].map((u) => safeUrl(u)).find(Boolean) || null;

/**
 * Generate (or regenerate) a campaign's landing page. The copy generation is AI —
 * Phase 5. Throws 501 until then.
 */
export async function generateLandingPage(
  db: Db,
  campaignId: string,
  _opts: { uid?: string | null } = {},
): Promise<never> {
  // Verify the campaign exists so the 404 contract holds even before AI lands.
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!rows[0]) throw new HttpError(404, "Campaign not found", "NOT_FOUND");
  throw new HttpError(501, "AI landing-page generation arrives in Phase 5", "NOT_IMPLEMENTED");
}

export async function getLandingPage(db: Db, campaignId: string, appUrl: string) {
  const rows = await db.select().from(campaignLandingPages).where(eq(campaignLandingPages.campaign_id, campaignId)).limit(1);
  const row = rows[0] as unknown as Record<string, any> | undefined;
  return row ? { ...row, publicUrl: `${appUrl}/landing/${row.slug}` } : null;
}

/** Approving is what makes the public URL serve — nothing is public until a human says so. */
export async function approveLandingPage(db: Db, campaignId: string, appUrl: string) {
  const rows = await db.select().from(campaignLandingPages).where(eq(campaignLandingPages.campaign_id, campaignId)).limit(1);
  const row = rows[0] as unknown as Record<string, any> | undefined;
  if (!row) throw new HttpError(404, "Generate a landing page first", "NOT_FOUND");
  if (row.status === "generating") throw new HttpError(409, "The landing page is still generating", "CONFLICT");
  if (!row.content?.hero?.headline) throw new HttpError(400, "This landing page has no content to publish", "BAD_REQUEST");
  const publishedAt = new Date();
  await db
    .update(campaignLandingPages)
    .set({ status: "published", publishedAt, updatedAt: new Date() })
    .where(eq(campaignLandingPages.id, row.id));
  return { ...row, status: "published", publishedAt, publicUrl: `${appUrl}/landing/${row.slug}` };
}

/** Public read by slug — published rows only, and never the internal ids. */
export async function getPublicLandingPage(db: Db, slug: string) {
  const rows = await db
    .select()
    .from(campaignLandingPages)
    .where(eq(campaignLandingPages.slug, String(slug || "")))
    .limit(1);
  const row = rows[0] as unknown as Record<string, any> | undefined;
  if (!row || row.status !== "published") return null;
  return {
    slug: row.slug,
    content: row.content,
    theme: row.theme,
    ctaDestinationUrl: row.ctaDestinationUrl,
    publishedAt: row.publishedAt,
  };
}

// Re-exported for the Phase 5 AI worker (kept here so the helpers stay in one place).
export { fallbackPage, buildSource, normalise };
