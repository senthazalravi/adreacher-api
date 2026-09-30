// Creative helpers: brand view, prompt building, rejection lessons, and the
// approve → post-draft materialization. Port of the old lib/creatives.js.
// AI generation itself (generateOne/startBatch) arrives in Phase 5 — the
// non-AI assembly paths are fully working here.
import { and, desc, eq, inArray } from "drizzle-orm";
import { brandProfiles, creatives, mediaAssets, postMedia, posts, workspaces } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";

export const THEMES = [
  "Bold product-focused hero shot with clean background and strong visual hierarchy",
  "Lifestyle scene showing the brand value proposition in an aspirational setting",
  "Modern minimalist design with typography accents and brand color highlights",
  "Dynamic action-oriented composition with energetic mood and clear focal point",
  "Premium editorial style with sophisticated lighting and refined aesthetic",
  "Social-native vertical creative with bold headline space and vibrant contrast",
];
export const MAX_BATCH = 6;
/** Workspaces with a generation loop running (one batch at a time per workspace). */
export const active = new Set<string>();

const REASONS: Record<string, string> = {
  wrong_tone: "the tone was wrong for the brand",
  wrong_product: "it showed the wrong product or service",
  bad_image: "the image quality or composition was poor",
  off_brand: "it looked off-brand (colors, style, mood)",
  other: "it was rejected by the reviewer",
};

const CTA_LABELS: Record<string, string> = {
  learn_more: "Learn more",
  shop_now: "Shop now",
  sign_up: "Sign up",
  get_offer: "Get offer",
  contact_us: "Contact us",
  book_now: "Book now",
  download: "Download",
};

export interface BrandView {
  name: string;
  tagline: string;
  description: string;
  industry: string;
  location: string;
  primaryColor: string;
  accentColor: string;
  fonts: Record<string, any>;
  logoUrl: string;
  sourceUrl: string;
  toneOfVoice: string[];
  audience: string;
  keywords: string[];
  products: string[];
  objectives: string[];
  themes: string[];
  references: string[];
}

/** Flat brand view used by prompts, from the workspace's brand profile. */
export async function brandFor(db: Db, workspaceId: string): Promise<BrandView> {
  const bpRows = await db.select().from(brandProfiles).where(eq(brandProfiles.workspace_id, workspaceId)).limit(1);
  const bp = (bpRows[0] as unknown as Record<string, any> | undefined) ?? null;
  let ws: Record<string, any> | null = null;
  if (!bp?.sourceUrl) {
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    ws = (wsRows[0] as unknown as Record<string, any> | undefined) ?? null;
  }
  const b = bp?.business || {};
  const br = bp?.branding || {};
  return {
    name: b.name || ws?.name || "Your Brand",
    tagline: b.tagline || b.description || "",
    description: b.description || "",
    industry: b.industry || "business",
    location: b.location || "",
    primaryColor: br.colors?.primary || br.colors?.accent || "",
    accentColor: br.colors?.accent || "",
    fonts: br.fonts || {},
    logoUrl: br.logoUrl || "",
    sourceUrl: bp?.sourceUrl || ws?.websiteUrl || "",
    toneOfVoice: bp?.toneOfVoice || [],
    audience: bp?.audience?.summary || b.targetAudience || "",
    keywords: bp?.keywords || b.keywords || [],
    products: b.keyProductsServices || [],
    objectives: b.advertisementObjectives || [],
    themes: br.brandThemes || [],
    references: (Array.isArray(br.referenceCreatives) ? br.referenceCreatives : []).map((c: any) => c?.url).filter(Boolean).slice(0, 3),
  };
}

export const refsFor = (brand: BrandView) =>
  [...new Set([...brand.references, ...(brand.logoUrl ? [brand.logoUrl] : [])])].slice(0, 3);

/** "Rejected ones teach the AI": the reviewer's recent rejections, as a directive for the next prompts. */
export async function rejectionLessons(db: Db, workspaceId: string, limit = 12) {
  const rows = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.workspace_id, workspaceId), inArray(creatives.status, ["rejected", "redo_requested"])))
    .orderBy(desc(creatives.reviewedAt))
    .limit(limit);
  const real = rows.filter((r: any) => !/^Generation failed/.test(r.rejectNote || ""));
  if (!real.length) return { image: "", copy: "" };
  const counts: Record<string, number> = {};
  for (const r of real as any[]) counts[r.rejectReason || "other"] = (counts[r.rejectReason || "other"] || 0) + 1;
  const reasons = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => REASONS[k] || REASONS.other);
  const notes = (real as any[]).map((r) => (r.rejectNote || "").trim()).filter(Boolean).slice(0, 4).map((n) => `"${n.slice(0, 140)}"`);
  const image = `Previous creatives were rejected because ${reasons.slice(0, 3).join("; ")}.${notes.length ? ` Reviewer notes: ${notes.join(" ")}.` : ""} Do not repeat those mistakes.`;
  const copy = `Previously rejected creatives for this brand: ${(real as any[]).map((r) => `${(r.subject || "").slice(0, 60)} (${REASONS[r.rejectReason] || REASONS.other}${r.rejectNote ? `: ${r.rejectNote.slice(0, 120)}` : ""})`).join(" | ")}. Avoid repeating those mistakes.`;
  return { image, copy };
}

export const buildPrompt = (b: BrandView, theme: string, hasRefs: boolean, lessons = "") =>
  [
    `Professional advertising creative for ${b.name}, a ${b.industry} brand.`,
    b.tagline ? ` Brand message: "${b.tagline.slice(0, 120)}".` : "",
    `${theme}.`,
    hasRefs ? " Keep the theme as is from the master reference images and create new creatives — preserve visual style, mood, color palette, and brand look." : "",
    "High-quality commercial photography or graphic design suitable for digital ads.",
    "Portrait 4:5 format, clean uncluttered composition, no text overlays, no watermarks, no random or unwanted text.",
    b.primaryColor ? ` Use brand accent color ${b.primaryColor} subtly.` : "",
    lessons,
  ].filter(Boolean).join(" ");

/** AI image/copy generation — Phase 5. */
export async function generateOne(): Promise<never> {
  throw new HttpError(501, "AI creative generation arrives in Phase 5", "NOT_IMPLEMENTED");
}

/** AI batch generation — Phase 5. */
export async function startBatch(): Promise<never> {
  throw new HttpError(501, "AI creative generation arrives in Phase 5", "NOT_IMPLEMENTED");
}

/**
 * Promote an approved creative to a post draft. Non-AI: fully working.
 * Returns the new post id (idempotent — returns the existing one when already materialized).
 */
export async function materializeApproved(db: Db, creativeId: string, byUserId: string | null = null) {
  const rows = await db.select().from(creatives).where(eq(creatives.id, creativeId)).limit(1);
  const row = rows[0] as unknown as Record<string, any> | undefined;
  if (!row || row.status !== "approved" || row.generationMeta?.post_id) return row?.generationMeta?.post_id || null;
  const meta = row.generationMeta || {};
  const fv = {
    headline: row.headline || "",
    description: row.body || "",
    imagePrompt: row.prompt || "",
    source: "creative",
    creativeId: row.id,
    placements: row.placements || [],
  };
  const inserted = await db
    .insert(posts)
    .values({
      workspace_id: row.workspace_id,
      account_id: row.account_id,
      createdBy_id: byUserId || row.reviewedBy_id || meta.requestedBy || null,
      title: row.headline || row.subject?.slice(0, 80) || "Approved creative",
      headline: row.headline || null,
      body: row.body || null,
      description: row.body || null,
      postType: "promoted",
      contentType: "image",
      status: "draft",
      format: `${row.shotType || "creative"} · ${(row.aspectRatios || ["4:5"])[0]}`,
      callToAction: CTA_LABELS[meta.cta] || meta.cta || null,
      imagePrompt: row.prompt || null,
      fieldValues: fv,
      notes: `Generated by Reach AI and approved on the Approve screen (${row.subject || "creative"}).`,
    })
    .returning({ id: posts.id });
  const postId = inserted[0]!.id;
  if (row.mediaAsset_id) {
    await db
      .insert(postMedia)
      .values({ post_id: postId, media_id: row.mediaAsset_id })
      .catch(() => {});
    // Also record the URL on the post itself. `post_media` is a join table whose
    // `media_assets` relation has no alias, so `post.media[].url` never hydrates —
    // publishing reads `fieldValues.mediaUrls`, and without this the generated image
    // is silently dropped.
    const assetRows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, row.mediaAsset_id)).limit(1);
    const asset = assetRows[0] as unknown as Record<string, any> | undefined;
    if (asset?.url) {
      await db
        .update(posts)
        .set({ fieldValues: { ...fv, mediaUrls: [asset.url] }, updatedAt: new Date() })
        .where(eq(posts.id, postId))
        .catch(() => {});
    }
  }
  await db
    .update(creatives)
    .set({ generationMeta: { ...meta, post_id: postId }, updatedAt: new Date() })
    .where(eq(creatives.id, row.id));
  return postId;
}
