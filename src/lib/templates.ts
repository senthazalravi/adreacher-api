// AI campaign templates — one per Google format, written for the workspace's brand.
//
// Port of the old lib/templates.js. The shape the frontend reads is v1's: a
// `campaign_templates` row whose `definition` carries `source: "auto_generated"`,
// `generationStatus`, `platformConfig` (with `catalogId`), `targetingConfig` and `adConfig`.
//
// Template generation is AI-driven and arrives in Phase 5. This module carries the
// catalog, the row-shape builders, and the workspace generation lock so Phase 5
// can drop the generation loop in without changing the routes.
import { campaignTemplates } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";
import type { BrandView } from "./creatives.js";

/** The Google formats a brand gets a template for. Mirrors reach_be's template-platforms catalogue. */
export const GOOGLE_TEMPLATE_CATALOG = [
  { id: "google-pmax", campaignType: "PERFORMANCE_MAX", adFormat: "pmax_asset_group", previewAspect: "collage", objective: "sales", label: "Performance Max", bestFor: "Conversions across Search, YouTube, Display & Maps" },
  { id: "google-search", campaignType: "SEARCH", adFormat: "search_rsa", previewAspect: "text", objective: "leads", label: "Search (RSA)", bestFor: "High-intent keyword traffic and lead gen" },
  { id: "google-demand-gen", campaignType: "DEMAND_GEN", adFormat: "demand_gen_image", previewAspect: "1:1", objective: "traffic", label: "Demand Gen", bestFor: "Visual discovery on YouTube, Discover & Gmail" },
  { id: "google-demand-gen-carousel", campaignType: "DEMAND_GEN", adFormat: "demand_gen_carousel", previewAspect: "1:1", objective: "engagement", label: "Demand Gen Carousel", bestFor: "Multi-image storytelling in visual feeds" },
  { id: "google-display", campaignType: "DISPLAY", adFormat: "display_banner", previewAspect: "1.91:1", objective: "awareness", label: "Display", bestFor: "Banner reach across the Google Display Network" },
  { id: "google-video", campaignType: "VIDEO", adFormat: "video_youtube", previewAspect: "16:9", objective: "awareness", label: "YouTube Video", bestFor: "Brand reach and recall on YouTube" },
];

/**
 * The objective as stored on `campaigns.objective`. The frontend maps these back
 * to its own vocabulary (`objectiveToUi`): there is no "engagement" or "app_promotion" key —
 * engagement is `messages`, and app promotion has no Google format, so it falls to traffic.
 */
const OBJECTIVE_KEY: Record<string, string> = {
  sales: "online_sales", leads: "leads", traffic: "website_visitors",
  engagement: "messages", app_promotion: "website_visitors", awareness: "awareness",
};

// One generation at a time per workspace — a second click must not double the AI spend.
const active = new Map<string, unknown>();
export const isGenerating = (workspaceId: string) => active.has(workspaceId);
/** In-flight generation promise for waitUntil (undefined when idle). */
export const templateRunFor = (workspaceId: string): Promise<void> | undefined => active.get(workspaceId) as Promise<void> | undefined;

function needsImage(entry: { previewAspect: string; adFormat: string }) {
  return entry.previewAspect !== "text" && entry.adFormat !== "video_youtube";
}

/** Row shape for an auto-generated template, written up-front as `generating`. */
export function baseRow(
  workspaceId: string,
  accountId: string,
  brand: BrandView,
  entry: { id: string; campaignType: string; adFormat: string; previewAspect: string; objective: string; label: string; bestFor: string },
  extra: Record<string, any> = {},
) {
  return {
    workspace_id: workspaceId,
    account_id: accountId,
    name: `${brand.name} — ${entry.label}`,
    description: entry.bestFor,
    objective: OBJECTIVE_KEY[entry.objective] || entry.objective,
    isGallery: false,
    formats: [entry.adFormat],
    usageCount: 0,
    definition: {
      budgetType: "daily",
      budgetAmount: null,
      platform: "google",
      source: "auto_generated",
      brandSourceUrl: brand.sourceUrl || null,
      campaignType: entry.campaignType,
      adFormat: entry.adFormat,
      previewAspect: entry.previewAspect,
      platformConfig: { platform: "google", googleCampaignType: entry.campaignType, label: entry.label, bestFor: entry.bestFor, catalogId: entry.id },
      targetingConfig: {},
      adConfig: { logoUrl: brand.logoUrl || "", imageStatus: needsImage(entry) ? "pending" : "ready" },
      generationStatus: "generating",
      generatedAt: null,
      ...extra,
    },
  };
}

import type { R2Bucket } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { generateJson, type AiEnv } from "./ai-text.js";
import { generateMultiRatioSet } from "./ai-images.js";
import { brandFor } from "./creatives.js";
import { checkAndIncrement } from "./usage.js";

const OBJECTIVE_LABEL: Record<string, string> = { sales: "Sales", leads: "Leads", traffic: "Traffic", engagement: "Engagement", app_promotion: "App promotion", awareness: "Awareness" };
const OBJECTIVE_GUIDANCE: Record<string, string> = {
  sales: "Drive purchases: concrete offers, urgency, product benefits, strong transactional CTAs.",
  leads: "Capture sign-ups and enquiries: clear value exchange, low-friction CTAs, trust signals.",
  traffic: "Bring people to the site: curiosity, specific reasons to visit, direct CTAs.",
  engagement: "Spark interaction: conversational, visual, community-oriented language.",
  app_promotion: "Drive installs: what the app does in one line, why now, install CTA.",
  awareness: "Build recall: brand story, distinctive tone, memorable single idea.",
};

async function existingFor(db: Db, workspaceId: string, catalogId: string): Promise<Record<string, any> | null> {
  const rows = await db.select().from(campaignTemplates).where(eq(campaignTemplates.workspace_id, workspaceId)).limit(200);
  return (
    (rows as unknown as Record<string, any>[]).find((r) => r.definition?.source === "auto_generated" && r.definition?.platformConfig?.catalogId === catalogId) || null
  );
}

async function upsert(db: Db, existing: Record<string, any> | null, row: Record<string, any>): Promise<string> {
  if (existing?.id) {
    await db.update(campaignTemplates).set({ ...row, usageCount: existing.usageCount || 0, updatedAt: new Date() }).where(eq(campaignTemplates.id, existing.id));
    return existing.id;
  }
  const ins = await db
    .insert(campaignTemplates)
    .values({ ...row, usageCount: 0, createdAt: new Date(), updatedAt: new Date() } as typeof campaignTemplates.$inferInsert)
    .returning({ id: campaignTemplates.id });
  return ins[0]!.id;
}

async function templateCopy(env: AiEnv, db: Db, brand: BrandView, entry: { objective: string; label: string; bestFor: string }): Promise<Record<string, any>> {
  const label = OBJECTIVE_LABEL[entry.objective] || entry.objective;
  const prompt = `You are a world-class digital advertising expert creating a Google Ads campaign template.

CAMPAIGN OBJECTIVE: ${label} (${entry.objective})
OBJECTIVE GUIDANCE: ${OBJECTIVE_GUIDANCE[entry.objective] || ""}
FORMAT: ${entry.label} — ${entry.bestFor}

BRAND CONTEXT:
- Business name: ${brand.name}
- Industry: ${brand.industry || "General"}
- Tagline: ${brand.tagline || ""}
- Description: ${brand.description || ""}
- Target audience: ${brand.audience || ""}
- Products/services: ${(brand.products || []).join(", ")}
- Website: ${brand.sourceUrl || ""}
- Brand primary color: ${brand.primaryColor || ""}

Detect the natural language of the brand content above and write ALL output in that language.

Return ONLY valid JSON:
{
  "name": "template campaign name including business name and objective",
  "description": "1-2 sentence template summary for marketers",
  "headlines": ["10-15 distinct headlines, each 30 characters or fewer"],
  "longHeadlines": ["3-5 distinct long headlines, each 90 characters or fewer"],
  "descriptions": ["4-5 distinct descriptions, each 90 characters or fewer"],
  "content": "2-4 sentence ad body copy",
  "callToAction": "CTA phrase appropriate for the language",
  "businessName": "${brand.name}",
  "keywords": ["8-12 relevant keywords"],
  "targetLocations": ["location names if inferable"],
  "targetAgeRange": { "ageMin": 18, "ageMax": 65 },
  "targetLanguage": "iso language code e.g. en or sv",
  "imagePrompt": "Detailed photographer-style creative brief for Google Ads images (portrait 4:5, landscape 1:1, square 1:1) aligned with the ${label} objective"
}

Rules:
- All copy must align with the ${label} objective.
- Headlines, long headlines and descriptions must be mutually distinct and high-converting.
- imagePrompt must describe a realistic, clean commercial photo scene relevant to the brand, and forbid text overlays, watermarks and captions.
- ${brand.logoUrl ? "A brand logo exists: mention bottom-left logo placement from image_urls[0]." : "No brand logo exists: do not invent one."}
- Do not wrap JSON in markdown.`;
  const p = await generateJson(env, db, prompt);
  const arr = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, n) : []);
  return {
    name: String(p.name || `${brand.name} — ${label}`).trim(),
    description: String(p.description || brand.description || brand.tagline || "").trim(),
    headlines: arr(p.headlines, 15),
    longHeadlines: arr(p.longHeadlines, 5),
    descriptions: arr(p.descriptions, 5),
    content: String(p.content || brand.description || "").trim(),
    callToAction: String(p.callToAction || "Learn more").trim(),
    businessName: String(p.businessName || brand.name).trim(),
    keywords: arr(p.keywords, 12),
    targetLocations: arr(p.targetLocations, 10),
    targetAgeRange: { ageMin: Number(p.targetAgeRange?.ageMin) || 18, ageMax: Number(p.targetAgeRange?.ageMax) || 65 },
    targetLanguage: String(p.targetLanguage || "en").trim().slice(0, 5),
    imagePrompt: String(p.imagePrompt || `Professional advertising photo for ${brand.name}, ${label} campaign, modern commercial style`).trim(),
  };
}

async function generateOneTemplate(
  db: Db,
  r2: R2Bucket,
  env: AiEnv,
  { ws, uid, brand, entry }: { ws: { id: string; accountId: string }; uid?: string | null; brand: BrandView; entry: (typeof GOOGLE_TEMPLATE_CATALOG)[number] },
): Promise<{ id: string; status: string; error?: string }> {
  const existing = await existingFor(db, ws.id, entry.id);
  const id = await upsert(db, existing, baseRow(ws.id, ws.accountId, brand, entry, existing?.definition?.adConfig?.mediaAssetIds?.length ? { adConfig: existing.definition.adConfig } : {}));
  try {
    await checkAndIncrement(db, { accountId: ws.accountId, workspaceId: ws.id, metricKey: "ai_generations", n: 1 });
    const copy = await templateCopy(env, db, brand, entry);
    const wantsImage = needsImage(entry);
    const adConfig = {
      title: copy.headlines[0] || copy.name,
      content: copy.content,
      headlines: copy.headlines,
      descriptions: copy.descriptions,
      longHeadline: copy.longHeadlines[0],
      longHeadlines: copy.longHeadlines,
      callToAction: copy.callToAction,
      imagePrompt: wantsImage ? copy.imagePrompt : undefined,
      mediaAssetIds: [],
      businessName: copy.businessName,
      logoUrl: brand.logoUrl || "",
      imageStatus: wantsImage ? "pending" : "ready",
    };
    const targetingConfig = { keywords: copy.keywords, targetLocations: copy.targetLocations, targetAgeRange: copy.targetAgeRange, targetLanguage: copy.targetLanguage, targetAudience: brand.audience || "", industry: brand.industry || "" };
    await db
      .update(campaignTemplates)
      .set({
        name: `${brand.name} — ${entry.label}`,
        description: entry.bestFor,
        definition: { ...baseRow(ws.id, ws.accountId, brand, entry).definition, targetingConfig, adConfig, generationStatus: "ready", generatedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(campaignTemplates.id, id));
    if (wantsImage) {
      try {
        await checkAndIncrement(db, { accountId: ws.accountId, workspaceId: ws.id, metricKey: "ai_generations", n: 3 });
        const img = await generateMultiRatioSet({ env, db, r2, ws, uid }, { prompt: copy.imagePrompt, refs: brand.logoUrl ? [brand.logoUrl] : [], campaignId: null });
        const assets = [img.portraitMediaAsset, img.landscapeMediaAsset, img.squareMediaAsset].filter(Boolean);
        const row = (await db.select().from(campaignTemplates).where(eq(campaignTemplates.id, id)).limit(1))[0] as unknown as Record<string, any> | undefined;
        await db
          .update(campaignTemplates)
          .set({
            definition: {
              ...(row?.definition || {}),
              thumbnailUrl: img.squareMediaAsset?.url || img.portraitMediaAsset?.url,
              adConfig: {
                ...(row?.definition?.adConfig || {}),
                mediaAssetIds: assets.map((a) => a.id),
                mediaUrls: assets.map((a) => a.url),
                imageSet: { portrait: img.portraitMediaAsset?.url, landscape: img.landscapeMediaAsset?.url, square: img.squareMediaAsset?.url },
                imageStatus: "ready",
              },
            },
            updatedAt: new Date(),
          })
          .where(eq(campaignTemplates.id, id));
      } catch (e: any) {
        const row = (await db.select().from(campaignTemplates).where(eq(campaignTemplates.id, id)).limit(1))[0] as unknown as Record<string, any> | undefined;
        await db
          .update(campaignTemplates)
          .set({
            definition: { ...(row?.definition || {}), adConfig: { ...(row?.definition?.adConfig || {}), imageStatus: "failed", imageError: e.message } },
            updatedAt: new Date(),
          })
          .where(eq(campaignTemplates.id, id))
          .catch(() => {});
      }
    }
    return { id, status: "ready" };
  } catch (e: any) {
    const row = (await db.select().from(campaignTemplates).where(eq(campaignTemplates.id, id)).limit(1))[0] as unknown as Record<string, any> | undefined;
    await db
      .update(campaignTemplates)
      .set({ definition: { ...(row?.definition || {}), generationStatus: "failed", generationError: e.message }, updatedAt: new Date() })
      .where(eq(campaignTemplates.id, id))
      .catch(() => {});
    return { id, status: "failed", error: e.message };
  }
}

/**
 * Start generating the Google template set for a workspace. Returns
 * immediately; rows are marked `generating` so the page can poll
 * `campaign_templates` for progress. Port of startGoogleTemplateGeneration.
 */
export async function startGoogleTemplateGeneration(
  db: Db,
  r2: R2Bucket,
  env: AiEnv,
  { ws, uid }: { ws: { id: string; accountId: string }; uid?: string | null },
): Promise<{ started: boolean; message: string }> {
  if (active.has(ws.id)) return { started: false, message: "Template generation is already running for this workspace" };
  const brand = await brandFor(db, ws.id);
  if (!brand.name || brand.name === "Your Brand") {
    const e = new HttpError(400, "Complete the brand profile (business name) before generating templates", "BRAND_INCOMPLETE");
    throw e;
  }
  for (const entry of GOOGLE_TEMPLATE_CATALOG) await upsert(db, await existingFor(db, ws.id, entry.id), baseRow(ws.id, ws.accountId, brand, entry));
  const run = (async () => {
    try {
      for (const entry of GOOGLE_TEMPLATE_CATALOG) await generateOneTemplate(db, r2, env, { ws, uid, brand, entry });
    } finally {
      active.delete(ws.id);
    }
  })();
  active.set(ws.id, run);
  void run.catch(() => {});
  return { started: true, message: `Generating ${GOOGLE_TEMPLATE_CATALOG.length} Google templates for ${brand.name}` };
}

/**
 * Generate the six format templates for a workspace's brand.
 * Kept for API compatibility with the Phase 4 stub signature.
 */
export async function generateTemplatesForBrand(
  db: Db,
  r2: R2Bucket,
  env: AiEnv,
  workspaceId: string,
  accountId: string,
  uid?: string | null,
): Promise<{ started: boolean; message: string }> {
  return startGoogleTemplateGeneration(db, r2, env, { ws: { id: workspaceId, accountId }, uid });
}

/** Counts the frontend also derives client-side; offered for parity with the v1 API. */
export async function templateGenerationStatus(db: Db, workspaceId: string): Promise<Record<string, any>> {
  const rows = (await db.select().from(campaignTemplates).where(eq(campaignTemplates.workspace_id, workspaceId)).limit(200)) as unknown as Record<string, any>[];
  const auto = rows.filter((r) => r.definition?.source === "auto_generated" && r.definition?.platform === "google");
  const n = (s: string) => auto.filter((r) => (r.definition?.generationStatus || "ready") === s).length;
  return {
    google: { ready: n("ready"), pending: n("pending") + n("generating"), failed: n("failed"), generating: active.has(workspaceId), total: auto.length },
    meta: "coming_soon",
    x: "coming_soon",
    reddit: "coming_soon",
    tiktok: "coming_soon",
  };
}

// Re-exported so the future Phase 5 generation loop can upsert rows through this module.
export { campaignTemplates };
