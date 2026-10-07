// AI studio: Gemini copy + fal.ai image generation + website brand scraping.
// Port of the old baasix-endpoint-ai-copy, baasix-endpoint-creatives and
// baasix-endpoint-templates extensions (same method+path for every route).
//
//   POST /posts/improve-text
//   POST /scraper/extract | /generate-ad-assets | /generate-product-targeting
//        /generate-multi-ratio-images | /expand-from-portrait | /generate-ad-image-slot
//        /auto-crop-ad-image | /maximize-creative-assets | /generate-creative-title
//        /generate-preview-ad-image | /edit-ad-image | /persist-creative-image
//   GET  /scraper/proxy-image?url=
//   POST /campaigns/auto-crop-ad-image   (alias the campaign builder posts to)
//   POST /branding/extract
//   POST /creatives/generate | /creatives/:id/redo | /creatives/:id/approve
//   GET  /creatives/status?workspaceId=
//   POST /campaign-templates/generate
//   GET  /campaign-templates/status?workspaceId=
import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import {
  brandProfiles,
  campaigns,
  creatives,
  posts,
  workspaces,
} from "../db/schema/index.js";
import { allowedWorkspaceIds, authMiddleware, sessionOf, tenantStatusGuard } from "../lib/auth.js";
import { HttpError } from "../lib/filter.js";
import { checkAndIncrement } from "../lib/usage.js";
import {
  IMPROVE_FIELDS,
  adAssetsFromScrape,
  creativeTitle,
  generateJson,
  improveText,
  productTargeting,
  type AiEnv,
} from "../lib/ai-text.js";
import {
  SLOT_SPECS,
  downloadImageBytes,
  editAdImage,
  expandFromPortrait,
  generateAdImage,
  generateDistinctMaximizedImageSet,
  generateMultiRatioSet,
  generatePortraitOnly,
  logoInstruction,
  previewPrompt,
  saveGeneratedImage,
  saveSlotImage,
  slotPrompt,
  specOf,
  type AiCtx,
} from "../lib/ai-images.js";
import {
  buildScrapeContext,
  extractBrand,
  isBlockedHost,
  storeScrapedAssets,
  type ScrapeContext,
} from "../lib/brand-scrape.js";
import {
  MAX_BATCH,
  active as creativeActive,
  brandFor,
  generateOne,
  materializeApproved,
  refsFor,
  rejectionLessons,
  startBatch,
  type BrandView,
} from "../lib/creatives.js";
import { startGoogleTemplateGeneration, templateGenerationStatus, templateRunFor } from "../lib/templates.js";
import type { Env } from "../index.js";

type AppContext = Context<{ Bindings: Env }>;

const aiRouter = new Hono<{ Bindings: Env }>();
aiRouter.use(authMiddleware);
aiRouter.use(tenantStatusGuard);

function aiEnv(c: AppContext): AiEnv {
  const e = c.env;
  return {
    GEMINI_API_KEY: e.GEMINI_API_KEY,
    FAL_API_KEY: e.FAL_API_KEY,
    FAL_KEY: e.FAL_KEY,
    AI_TEXT_MODEL: e.AI_TEXT_MODEL,
    AI_FALLBACK_MODEL: e.AI_FALLBACK_MODEL,
    SECRET_KEY: e.SECRET_KEY,
    API_PUBLIC_URL: e.API_PUBLIC_URL,
  };
}

interface WsContext {
  uid: string;
  ws: Record<string, any> | null;
}

/** Session + optional/required workspace access check (mirrors the old wsOf/ctx). */
async function wsContext(c: AppContext, workspaceId?: string | null, required = true): Promise<WsContext> {
  const session = sessionOf(c);
  const uid = session.userId;
  if (!uid) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const targetWsId = workspaceId || c.req.query("workspaceId") || c.req.header("x-workspace-id") || c.req.header("x-workspace");
  if (!targetWsId) {
    if (required) throw new HttpError(400, "workspaceId required", "WORKSPACE_REQUIRED");
    return { uid, ws: null };
  }
  const allowed = await allowedWorkspaceIds(getDb(c.env.DB), session);
  if (allowed !== null && !allowed.includes(targetWsId)) {
    throw new HttpError(403, "You do not have access to this workspace", "WORKSPACE_FORBIDDEN");
  }
  const rows = await getDb(c.env.DB)
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, targetWsId), eq(workspaces.account_id, session.tenantId), isNull(workspaces.deletedAt)));
  const ws = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!ws) throw new HttpError(404, "Workspace not found", "WORKSPACE_NOT_FOUND");
  return { uid, ws };
}

const aiCtxFor = (c: AppContext, ws: Record<string, any>, uid: string | null): AiCtx => ({
  env: aiEnv(c),
  db: getDb(c.env.DB),
  r2: c.env.R2,
  ws: { id: ws.id as string, accountId: ws.account_id as string },
  uid,
});

/** Usage metering: charge n ai_generations (no-op without a workspace, like the old meter()). */
const meter = (db: Db, ws: Record<string, any> | null, n = 1) =>
  ws ? checkAndIncrement(db, { accountId: ws.account_id as string, workspaceId: ws.id as string, metricKey: "ai_generations", n }) : Promise.resolve({ count: 0, limit: null });

const usable = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u) && !/\.svg(\?|$)/i.test(u);
const refList = (imageUrls: unknown, logoUrl: unknown): string[] =>
  [...new Set([logoUrl as string, ...(Array.isArray(imageUrls) ? imageUrls : [])].filter(usable))].slice(0, 3);

/* ---------------- copy ---------------- */

aiRouter.post("/posts/improve-text", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws } = await wsContext(c, body.workspaceId, false);
  const field = String(body.field || "");
  if (!IMPROVE_FIELDS.includes(field)) throw new HttpError(400, `field must be one of ${IMPROVE_FIELDS.join(", ")}`, "INVALID_FIELD");
  await meter(db, ws);
  const brand = ws ? await brandFor(db, ws.id as string) : null;
  const data = await improveText(aiEnv(c), db, {
    field,
    currentText: String(body.currentText || ""),
    brand: (brand || {}) as BrandView,
    context: body.context || {},
  });
  return c.json({ data });
});

/* ---------------- scrape → brand ---------------- */

/** Run the scrape pipeline: fetch → parse → Gemini extract → store assets. */
async function runScrapePipeline(c: AppContext, url: string, workspaceId: string | null): Promise<{ context: ScrapeContext; brand: Record<string, any> }> {
  const db = getDb(c.env.DB);
  const context = await buildScrapeContext(url);
  const brand = await extractBrand(aiEnv(c), db, context);
  await storeScrapedAssets(db, context, { workspaceId }).catch(() => {});
  return { context, brand };
}

aiRouter.post("/scraper/extract", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws } = await wsContext(c, body.workspaceId, false);
  const url = String(body.url || "").trim();
  if (!url) throw new HttpError(400, "url is required", "URL_REQUIRED");
  const { context, brand } = await runScrapePipeline(c, url, (ws?.id as string) || null);
  return c.json({
    data: {
      url: context.url,
      meta: context.meta,
      headings: context.headings,
      ctaButtons: context.ctaButtons,
      socialLinks: context.socialLinks,
      imageCandidates: context.imageCandidates,
      bodyText: context.bodyText,
      footerText: context.footerText,
      jsonLdData: context.jsonLdData,
      cssColors: context.cssColors,
      cssFonts: context.cssFonts,
      brand,
    },
  });
});

aiRouter.post("/branding/extract", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws } = await wsContext(c, body.workspaceId, false);
  let url = String(body.url || "").trim();
  if (!url && ws) {
    const bp = (await db.select().from(brandProfiles).where(eq(brandProfiles.workspace_id, ws.id as string)).limit(1))[0] as unknown as Record<string, any> | undefined;
    url = String(bp?.sourceUrl || (ws as Record<string, any>).websiteUrl || "").trim();
  }
  if (!url) throw new HttpError(400, "url is required", "URL_REQUIRED");
  const { brand } = await runScrapePipeline(c, url, (ws?.id as string) || null);
  return c.json({ data: brand });
});

/* ---------------- scraper: ad assets ---------------- */

aiRouter.post("/scraper/generate-ad-assets", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, false);
  const brand = ws ? await brandFor(db, ws.id as string) : null;
  const url = String(body.url || (brand as any)?.sourceUrl || "").trim();
  if (!url) throw new HttpError(400, "url is required", "URL_REQUIRED");
  await meter(db, ws);
  const sc = await buildScrapeContext(url);
  // Novelty: don't repeat headlines / hero scenes already used by this workspace's posts.
  const past = { headlines: [] as string[], prompts: [] as string[] };
  if (ws) {
    const postRows = (await db
      .select()
      .from(posts)
      .where(eq(posts.workspace_id, ws.id as string))
      .orderBy(desc(posts.createdAt))
      .limit(15)) as unknown as Record<string, any>[];
    for (const p of postRows) {
      if (p.headline) past.headlines.push(p.headline);
      if (Array.isArray(p.fieldValues?.headlines)) past.headlines.push(...p.fieldValues.headlines);
      const ip = p.imagePrompt || p.fieldValues?.imagePrompt;
      if (typeof ip === "string" && ip) past.prompts.push(ip);
    }
  }
  const assets: Record<string, any> = await adAssetsFromScrape(aiEnv(c), db, sc, { past });

  // Convert and persist the website logo for Google Ads (1:1). No sharp on
  // Workers: the logo is stored as-is (SVG stays SVG).
  const rawLogo = assets.logoUrl || sc.meta?.logo || (brand as any)?.logoUrl || sc.meta?.favicon || null;
  const inlineLogoSvg = (sc.meta as any)?.inlineLogoSvg || null;
  let logoMediaAsset: Record<string, any> | null = null;
  if ((rawLogo || inlineLogoSvg) && ws && uid) {
    try {
      let rawBuf: ArrayBuffer | null = null;
      let mime = "image/png";
      if (inlineLogoSvg && (!rawLogo || /\.svg(\?|$)/i.test(rawLogo))) {
        rawBuf = new TextEncoder().encode(inlineLogoSvg).buffer as ArrayBuffer;
        mime = "image/svg+xml";
      } else if (rawLogo && /^https?:\/\//i.test(rawLogo)) {
        const r = await fetch(rawLogo, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ReachBot/1.0)" }, signal: AbortSignal.timeout(20000) });
        if (r.ok) {
          rawBuf = await r.arrayBuffer();
          mime = r.headers.get("content-type")?.split(";")[0] || mime;
        }
      }
      if (rawBuf && rawBuf.byteLength > 0) {
        const saved = await saveGeneratedImage({
          db,
          r2: c.env.R2,
          publicBaseUrl: aiEnv(c).API_PUBLIC_URL,
          workspaceId: ws.id as string,
          accountId: ws.account_id as string,
          uid,
          buffer: rawBuf,
          fileName: "brand-logo.png",
          mimeType: mime,
          tags: ["brand-logo", "google-logo", "google-derived", "ai-scraped-logo"],
          metadata: { sourceUrl: rawLogo || "inline-svg", role: "logo", campaignId: body.campaignId || null },
        });
        logoMediaAsset = { ...saved, role: "logo", googleReady: true };
        assets.logoUrl = saved.url;
        assets.logoMediaAsset = logoMediaAsset;
        assets.logoFileId = saved.fileId;
        assets.fileIds = [saved.fileId];
        assets.mediaAssetIds = [saved.id];
      }
    } catch (logoErr: any) {
      console.warn("[generate-ad-assets] Scraped logo save failed:", logoErr?.message || logoErr);
    }
  }

  // Portrait-first flow: generate ONLY the single portrait (4:5) slot first.
  if (assets.imagePrompt && ws && uid) {
    try {
      const actx = aiCtxFor(c, ws, uid);
      const refs = refList(sc.imageCandidates?.map((i) => i.src), assets.logoUrl);
      const single = await generatePortraitOnly(actx, { prompt: assets.imagePrompt, refs, campaignId: body.campaignId || null });
      assets.imageUrl = single.portraitUrl;
      assets.portraitUrl = single.portraitUrl;
      assets.landscapeUrl = null;
      assets.squareUrl = null;
      assets.portraitMediaAsset = single.mediaAsset;
      assets.landscapeMediaAsset = null;
      assets.squareMediaAsset = null;
      assets.mediaAsset = single.mediaAsset;
      assets.fileId = single.mediaAsset?.fileId || null;
      assets.mediaAssetId = single.mediaAsset?.id || null;
      assets.fileIds = [single.mediaAsset?.fileId, assets.logoFileId].filter(Boolean);
      assets.mediaAssetIds = [single.mediaAsset?.id, logoMediaAsset?.id].filter(Boolean);
      const s = specOf("portrait");
      assets.imageSet = {
        logo: logoMediaAsset ? { url: logoMediaAsset.url, role: "logo", mediaAssetId: (logoMediaAsset as any).id, googleReady: true } : null,
        landscape: null,
        square: null,
        portrait: single.mediaAsset ? { url: single.mediaAsset.url, role: "portrait", mediaAssetId: single.mediaAsset.id, width: s.targetWidth, height: s.targetHeight, googleReady: true } : null,
        source: "ai",
        completeness: "partial",
      };
    } catch (imgErr: any) {
      console.error("[generate-ad-assets] Portrait image generation failed:", imgErr?.message || imgErr);
    }
  }
  return c.json({ data: assets });
});

aiRouter.post("/scraper/generate-product-targeting", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws } = await wsContext(c, body.workspaceId, false);
  const title = String(body.title || "").trim();
  if (!title) throw new HttpError(400, "Product title is required for targeting generation", "TITLE_REQUIRED");
  await meter(db, ws);
  const { brand, price, currency, imageUrl, destinationUrl, productId } = body || {};
  return c.json({ data: await productTargeting(aiEnv(c), db, { title, brand, price, currency, imageUrl, destinationUrl, productId }) });
});

aiRouter.post("/scraper/generate-multi-ratio-images", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, true);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new HttpError(400, "prompt required", "PROMPT_REQUIRED");
  const refs = refList(body.imageUrls, body.logoUrl);
  const existing = usable(body.existingPortraitUrl) ? body.existingPortraitUrl : null;
  await meter(db, ws, existing ? 2 : 3);
  const data = await generateMultiRatioSet(aiCtxFor(c, ws!, uid), { prompt, refs, existingPortraitUrl: existing, campaignId: body.campaignId || null });
  return c.json({ data });
});

aiRouter.post("/scraper/expand-from-portrait", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, true);
  const portraitUrl = String(body.portraitUrl || "").trim();
  if (!portraitUrl) throw new HttpError(400, "portraitUrl is required", "URL_REQUIRED");
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new HttpError(400, "prompt required", "PROMPT_REQUIRED");
  const refs = refList(body.imageUrls, body.logoUrl);
  await meter(db, ws, 2);
  const data = await expandFromPortrait(aiCtxFor(c, ws!, uid), { prompt, refs, portraitUrl, campaignId: body.campaignId || null });
  return c.json({ data });
});

aiRouter.post("/scraper/generate-ad-image-slot", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, true);
  const prompt = String(body.prompt || "").trim();
  const slot = String(body.slot || "");
  if (!prompt) throw new HttpError(400, "prompt required", "PROMPT_REQUIRED");
  if (!SLOT_SPECS[slot]) throw new HttpError(400, "slot must be portrait, landscape or square", "INVALID_SLOT");
  const refs = refList(body.imageUrls, body.logoUrl);
  const spec = specOf(slot);
  await meter(db, ws);
  const actx = aiCtxFor(c, ws!, uid);
  const img = usable(body.regenerateFromUrl)
    ? await editAdImage(actx, slotPrompt(prompt, slot, { hasLogo: refs.length > 0 }), body.regenerateFromUrl, spec.mappedAspectRatio)
    : await generateAdImage(actx, slotPrompt(prompt, slot, { hasLogo: refs.length > 0 }), spec.mappedAspectRatio, refs);
  const buf = await downloadImageBytes(img.imageUrl);
  const mediaAsset = await saveSlotImage(actx, { buffer: buf, slot, tags: [`ai-ad-${slot}`, `google-${slot}`], metadata: { prompt: img.prompt, model: img.model, campaignId: body.campaignId || null } });
  return c.json({ data: { url: mediaAsset.url, mediaAsset } });
});

const autoCropAdImage = async (c: AppContext) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, true);
  const imageUrl = String(body.imageUrl || "").trim();
  const slot = String(body.slot || "");
  if (!imageUrl) throw new HttpError(400, "Image URL is required for auto-crop", "URL_REQUIRED");
  if (slot !== "logo" && !SLOT_SPECS[slot]) throw new HttpError(400, "slot must be portrait, landscape, square or logo", "INVALID_SLOT");
  const buf = await downloadImageBytes(imageUrl);
  // No sharp on Workers: the image is stored as-is at the requested aspect
  // ratio; the slot's target dimensions are recorded as the intended size.
  const spec = slot === "logo" ? { targetWidth: 1200, targetHeight: 1200 } : specOf(slot);
  const mediaAsset = await saveGeneratedImage({
    db,
    r2: c.env.R2,
    publicBaseUrl: aiEnv(c).API_PUBLIC_URL,
    workspaceId: ws!.id as string,
    accountId: ws!.account_id as string,
    uid,
    buffer: buf,
    fileName: `${slot}-ad-image.png`,
    mimeType: "image/png",
    tags: slot === "logo" ? ["brand-logo", "google-logo", "google-derived", "ai-autocrop"] : [`google-${slot}`, "google-derived", "ai-autocrop"],
    metadata: { sourceUrl: imageUrl },
    width: spec.targetWidth,
    height: spec.targetHeight,
  });
  return c.json({ data: { url: mediaAsset.url, mediaAsset, width: spec.targetWidth, height: spec.targetHeight } });
};
// The campaign builder's creative editor posts to the /campaigns path; same handler.
aiRouter.post("/scraper/auto-crop-ad-image", autoCropAdImage);
aiRouter.post("/campaigns/auto-crop-ad-image", autoCropAdImage);

aiRouter.get("/scraper/proxy-image", async (c) => {
  await wsContext(c, undefined, false);
  const url = String(c.req.query("url") || "");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, "A valid http(s) url is required", "URL_REQUIRED");
  }
  if (!/^https?:$/.test(u.protocol) || isBlockedHost(u.hostname)) {
    throw new HttpError(400, "URL not allowed", "URL_FORBIDDEN");
  }
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ReachBot/1.0)" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new HttpError(400, `Upstream returned ${r.status}`, "UPSTREAM_ERROR");
  const type = (r.headers.get("content-type") || "").split(";")[0] || "image/jpeg";
  if (!type.startsWith("image/")) throw new HttpError(400, "Not an image", "NOT_AN_IMAGE");
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 15 * 1024 * 1024) throw new HttpError(400, "Image too large", "TOO_LARGE");
  return new Response(buf, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
});

aiRouter.post("/scraper/maximize-creative-assets", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, false);
  const campaignType = String(body.campaignType || "PERFORMANCE_MAX").toUpperCase();
  const existingHeadlines = Array.isArray(body.headlines) ? body.headlines.filter(Boolean) : [];
  const existingDescriptions = Array.isArray(body.descriptions) ? body.descriptions.filter(Boolean) : [];
  const longHeadline = body.longHeadline || "";
  const businessName = body.businessName || "";
  const promptContext = body.promptContext || body.content || body.theme || existingHeadlines[0] || "";
  const imagePrompt = body.imagePrompt || "";
  const brand = ws ? await brandFor(db, ws.id as string) : null;

  const LIMITS: Record<string, { headlines: number; descriptions: number; longHeadlines: number; slots: string[] }> = {
    PERFORMANCE_MAX: { headlines: 15, descriptions: 5, longHeadlines: 5, slots: ["landscape", "square", "portrait", "logo"] },
    SEARCH: { headlines: 15, descriptions: 4, longHeadlines: 0, slots: ["landscape", "logo"] },
    DEMAND_GEN: { headlines: 5, descriptions: 5, longHeadlines: 5, slots: ["landscape", "square", "portrait", "logo"] },
    DISPLAY: { headlines: 5, descriptions: 5, longHeadlines: 5, slots: ["landscape", "square", "portrait", "logo"] },
    VIDEO: { headlines: 5, descriptions: 5, longHeadlines: 0, slots: ["landscape", "square", "logo"] },
    SHOPPING: { headlines: 0, descriptions: 0, longHeadlines: 0, slots: [] },
  };
  const targets = LIMITS[campaignType] ?? LIMITS["PERFORMANCE_MAX"]!;
  await meter(db, ws);

  let imageSet: Record<string, any> = body.imageSet ? { ...body.imageSet } : {};
  const logoUrl = imageSet?.logo?.url || body.logoUrl || (brand as any)?.logoUrl || null;
  const existingPortrait = body.existingPortraitUrl || imageSet?.portrait?.url || body.imageUrl || null;

  const textPromise = (async () => {
    const aiPrompt = `You are a world-class Google Ads copywriter and SEM strategist maximizing creative assets and targeting for high Ad Strength and reach on a ${campaignType} campaign.
Theme / Subject of this specific post: "${promptContext}"
Business / Brand: "${businessName || (brand as any)?.name || "Our Brand"}"
Brand Tagline / Context: "${(brand as any)?.tagline || (brand as any)?.description || ""}"
Current Headlines (${existingHeadlines.length}): ${JSON.stringify(existingHeadlines)}
Current Descriptions (${existingDescriptions.length}): ${JSON.stringify(existingDescriptions)}

CRITICAL REQUIREMENT:
- Maintain the EXACT SAME THEME, HERO SUBJECT, AND BRAND VOICE as the existing post.
- Generate at least ${targets.headlines} unique, high-converting headlines (each strictly <= 30 characters). Include varied angles: action-oriented, product benefit, question, trust signal, and short 15-char punchy variants.
- Generate at least ${targets.descriptions} persuasive descriptions (each strictly <= 90 characters). Include value proposition, specific benefits, and clear calls to action.
${targets.longHeadlines > 0 ? `- Generate at least ${targets.longHeadlines} distinct long headlines (each between 30 and 90 characters) that provide compelling comprehensive hooks.` : ""}
- Generate 25 to 35 high-intent, high-conversion Google search keywords and phrases (2–5 words each). Derive directly from the specific products, services, and brand offerings in the post theme. Include high-value transactional queries (best, buy, book, price, near me) in the brand's language. Strictly NO generic single-word filler terms.
- Generate 5-10 Google Performance Max search themes (broader consumer search intent phrases).
- Generate 4-6 callout text assets (each strictly <= 25 characters, e.g. "Free 24/7 Support", "Verified Results", "Fast & Simple").

Return ONLY valid JSON without markdown:
{
  "headlines": ["array of unique headlines <= 30 chars"],
  "descriptions": ["array of unique descriptions <= 90 chars"],
  "longHeadlines": ["array of unique long headlines 30-90 chars"],
  "keywords": ["array of 25-35 high-intent keywords"],
  "searchThemes": ["array of 5-10 search themes"],
  "callouts": ["array of 4-6 callout snippets <= 25 chars"]
}`;
    try {
      const generated = await generateJson(aiEnv(c), db, aiPrompt);
      const s = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, n) : []);
      return {
        headlines: s(generated?.headlines, 60).map((x) => x.slice(0, 30)),
        descriptions: s(generated?.descriptions, 40).map((x) => x.slice(0, 90)),
        longHeadlines: s(generated?.longHeadlines, 20).map((x) => x.slice(0, 90)),
        keywords: s(generated?.keywords, 40),
        searchThemes: s(generated?.searchThemes, 15),
        callouts: s(generated?.callouts, 10).map((x) => x.slice(0, 25)),
      };
    } catch (err: any) {
      console.warn("[maximize-creative-assets] AI text generation error:", err?.message || err);
      return { headlines: [], descriptions: [], longHeadlines: [], keywords: [], searchThemes: [], callouts: [] };
    }
  })();

  const imagePromise = (async () => {
    if (!targets.slots.length || !ws || !uid) return null;
    const creativePrompt = imagePrompt.trim() || [businessName || (brand as any)?.name, promptContext].filter(Boolean).join(" — ") || "Professional commercial advertising photography";
    try {
      const refs = refList(body.imageUrls, logoUrl);
      return await generateDistinctMaximizedImageSet(aiCtxFor(c, ws, uid), { prompt: creativePrompt, refs, existingPortraitUrl: existingPortrait, campaignId: body.campaignId || null });
    } catch (imgErr: any) {
      console.warn("[maximize-creative-assets] Distinct generation failed:", imgErr?.message || imgErr);
      return null;
    }
  })();

  const [aiResult, multi] = await Promise.all([textPromise, imagePromise]);
  const addedSlots: string[] = [];
  if (multi) {
    if (!imageSet.portrait?.url && multi.portraitUrl) {
      imageSet.portrait = { url: multi.portraitUrl, mediaAssetId: multi.portraitMediaAsset?.id, file_Id: multi.portraitMediaAsset?.fileId, role: "portrait", width: 960, height: 1200, googleReady: true };
      addedSlots.push("portrait");
    }
    if (!imageSet.landscape?.url && multi.landscapeUrl) {
      imageSet.landscape = { url: multi.landscapeUrl, mediaAssetId: multi.landscapeMediaAsset?.id, file_Id: multi.landscapeMediaAsset?.fileId, role: "landscape", width: 1200, height: 628, googleReady: true };
      addedSlots.push("landscape");
    }
    if (!imageSet.square?.url && multi.squareUrl) {
      imageSet.square = { url: multi.squareMediaAsset?.url, mediaAssetId: multi.squareMediaAsset?.id, file_Id: multi.squareMediaAsset?.fileId, role: "square", width: 1200, height: 1200, googleReady: true };
      addedSlots.push("square");
    }
    imageSet.extras = {
      landscape: multi.landscapeUrl ? [{ url: multi.landscapeUrl, mediaAssetId: multi.landscapeMediaAsset?.id, file_Id: multi.landscapeMediaAsset?.fileId, role: "landscape", width: 1200, height: 628, googleReady: true, isMaximized: true }] : [],
      square: multi.squareUrl ? [{ url: multi.squareUrl, mediaAssetId: multi.squareMediaAsset?.id, file_Id: multi.squareMediaAsset?.fileId, role: "square", width: 1200, height: 1200, googleReady: true, isMaximized: true }] : [],
      portrait: multi.portraitUrl ? [{ url: multi.portraitUrl, mediaAssetId: multi.portraitMediaAsset?.id, file_Id: multi.portraitMediaAsset?.fileId, role: "portrait", width: 960, height: 1200, googleReady: true, isMaximized: true }] : [],
    };
  }
  if (logoUrl && !imageSet.logo?.url) {
    imageSet.logo = { url: logoUrl, role: "logo", width: 1200, height: 1200, googleReady: true };
  }
  imageSet.source = "ai";
  imageSet.completeness = "complete";

  const newHeadlines = (aiResult.headlines || []).filter((h: string) => !existingHeadlines.includes(h));
  const mergedHeadlines = [...existingHeadlines, ...newHeadlines].slice(0, targets.headlines);
  const newDescriptions = (aiResult.descriptions || []).filter((d: string) => !existingDescriptions.includes(d));
  const mergedDescriptions = [...existingDescriptions, ...newDescriptions].slice(0, targets.descriptions);
  const existingLongHeadlines = Array.isArray(body.longHeadlines) ? body.longHeadlines.filter(Boolean) : body.longHeadline ? [body.longHeadline] : [];
  const newLongHeadlines = (aiResult.longHeadlines || []).filter((lh: string) => !existingLongHeadlines.includes(lh));
  const mergedLongHeadlines = [...existingLongHeadlines, ...newLongHeadlines].slice(0, targets.longHeadlines || 5);
  const chosenLongHeadline = mergedLongHeadlines[0] || longHeadline || mergedHeadlines[0] || "";
  const existingKeywords = Array.isArray(body.keywords) ? body.keywords.filter(Boolean) : [];
  const newKeywords = (aiResult.keywords || []).filter((k: string) => !existingKeywords.includes(k));
  const mergedKeywords = Array.from(new Set([...existingKeywords, ...newKeywords])).slice(0, 40);
  const existingThemes = Array.isArray(body.searchThemes) ? body.searchThemes.filter(Boolean) : [];
  const newThemes = (aiResult.searchThemes || []).filter((st: string) => !existingThemes.includes(st));
  const mergedSearchThemes = Array.from(new Set([...existingThemes, ...newThemes])).slice(0, 10);
  const callouts = aiResult.callouts || [];

  return c.json({
    data: {
      headlines: mergedHeadlines,
      descriptions: mergedDescriptions,
      longHeadline: chosenLongHeadline,
      longHeadlines: mergedLongHeadlines,
      keywords: mergedKeywords,
      searchThemes: mergedSearchThemes,
      callouts,
      imageSet,
      campaignType,
      maxAssets: targets,
      maximizedAssets: {
        addedHeadlines: newHeadlines,
        addedDescriptions: newDescriptions,
        addedLongHeadlines: newLongHeadlines,
        addedKeywords: newKeywords,
        addedSearchThemes: newThemes,
        addedCallouts: callouts,
        addedSlots,
      },
    },
  });
});

/* ---------------- creative studio (v1 paths) ---------------- */

aiRouter.post("/scraper/generate-creative-title", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  await wsContext(c, body.workspaceId, false);
  return c.json({ data: await creativeTitle(aiEnv(c), db, body.prompt) });
});

aiRouter.post("/scraper/generate-preview-ad-image", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, false);
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();
  if (!title && !content) throw new HttpError(400, "Title or content is required to generate a preview image", "TITLE_REQUIRED");
  if (ws) await meter(db, ws);
  const brand = ws ? await brandFor(db, ws.id as string) : null;
  const refs = (brand as any)?.logoUrl ? [(brand as any).logoUrl] : [];
  const actx = ws ? aiCtxFor(c, ws, uid) : null;
  const prompt = `${previewPrompt(title, content)}${refs.length ? ` ${logoInstruction(true)}` : ""}`;
  const img = await generateAdImage(actx || ({ env: aiEnv(c), db, r2: c.env.R2, ws: { id: "", accountId: "" }, uid } as AiCtx), prompt, "16:9", refs);
  const mediaAsset =
    ws && body.saveToLibrary !== false
      ? await saveGeneratedImage({
          db,
          r2: c.env.R2,
          publicBaseUrl: aiEnv(c).API_PUBLIC_URL,
          workspaceId: ws.id as string,
          accountId: ws.account_id as string,
          uid,
          url: img.imageUrl,
          fileName: "preview-ad-image.png",
          mimeType: "image/png",
          tags: ["ai-ad-preview"],
          metadata: { prompt: img.prompt, model: img.model },
        })
      : null;
  return c.json({ data: { imageUrl: mediaAsset?.url || img.imageUrl, prompt: img.prompt, mediaAsset } });
});

aiRouter.post("/scraper/edit-ad-image", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, false);
  const prompt = String(body.prompt || "").trim();
  const imageUrl = String(body.imageUrl || "").trim();
  if (!prompt) throw new HttpError(400, "prompt required", "PROMPT_REQUIRED");
  if (!imageUrl) throw new HttpError(400, "imageUrl required", "URL_REQUIRED");
  if (ws) await meter(db, ws);
  const actx = ws ? aiCtxFor(c, ws, uid) : ({ env: aiEnv(c), db, r2: c.env.R2, ws: { id: "", accountId: "" }, uid } as AiCtx);
  const img = await editAdImage(actx, prompt, imageUrl);
  const mediaAsset =
    ws && body.saveToLibrary
      ? await saveGeneratedImage({
          db,
          r2: c.env.R2,
          publicBaseUrl: aiEnv(c).API_PUBLIC_URL,
          workspaceId: ws.id as string,
          accountId: ws.account_id as string,
          uid,
          url: img.imageUrl,
          fileName: "edited-ad-image.png",
          mimeType: "image/png",
          tags: ["ai-generated", "edited"],
          metadata: { prompt, model: img.model, referenceUrl: imageUrl },
        })
      : null;
  return c.json({ data: { imageUrl: mediaAsset?.url || img.imageUrl, prompt: img.prompt, mediaAsset } });
});

aiRouter.post("/scraper/persist-creative-image", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, true);
  const imageUrl = String(body.imageUrl || "").trim();
  if (!imageUrl) throw new HttpError(400, "imageUrl required", "URL_REQUIRED");
  const mediaAsset = await saveGeneratedImage({
    db,
    r2: c.env.R2,
    publicBaseUrl: aiEnv(c).API_PUBLIC_URL,
    workspaceId: ws!.id as string,
    accountId: ws!.account_id as string,
    uid,
    url: imageUrl,
    fileName: `creative-${Date.now()}.png`,
    mimeType: "image/png",
    tags: ["ai-generated"],
    metadata: { prompt: body.prompt || null },
  });
  return c.json({ data: { imageUrl: mediaAsset.url, mediaAsset } });
});

/* ---------------- approve-screen creatives ---------------- */

aiRouter.post("/creatives/generate", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId, true);
  const count = Math.min(MAX_BATCH, Math.max(1, Number(body.count) || 3));
  if (creativeActive.has(ws!.id as string)) throw new HttpError(409, "Creative generation is already in progress for this workspace", "GENERATION_IN_PROGRESS");
  const brand = await brandFor(db, ws!.id as string);
  const campaignRows = body.campaignId
    ? await db.select().from(campaigns).where(and(eq(campaigns.id, body.campaignId), eq(campaigns.workspace_id, ws!.id as string))).limit(1)
    : [];
  const campaign = (campaignRows[0] as unknown as Record<string, any> | undefined) ?? null;
  await checkAndIncrement(db, { accountId: ws!.account_id as string, workspaceId: ws!.id as string, metricKey: "ai_generations", n: count });
  const { ids, done } = await startBatch(db, c.env.R2, aiEnv(c), {
    ws: { id: ws!.id as string, accountId: ws!.account_id as string },
    uid,
    brand,
    count,
    campaign: campaign ? { id: campaign.id, objective: campaign.objective } : null,
    source: "manual",
  });
  c.executionCtx.waitUntil(done.catch(() => {}));
  return c.json({ data: { started: count, ids } }, 202);
});

aiRouter.post("/creatives/:id/redo", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const session = sessionOf(c);
  const uid = session.userId;
  if (!uid) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const row = ((await db.select().from(creatives).where(eq(creatives.id, c.req.param("id"))).limit(1))[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!row) throw new HttpError(404, "Creative not found", "NOT_FOUND");
  const { ws } = await wsContext(c, row.workspace_id as string, true);
  const brand = await brandFor(db, ws!.id as string);
  await checkAndIncrement(db, { accountId: ws!.account_id as string, workspaceId: ws!.id as string, metricKey: "ai_generations", n: 1 });
  const note = String(body.note || row.rejectNote || "").trim();
  const prompt = note ? `${row.prompt} Revision request: ${note.slice(0, 300)}.` : row.prompt;
  await db
    .update(creatives)
    .set({
      status: "generating",
      prompt,
      rejectNote: note || null,
      generationMeta: { ...(row.generationMeta || {}), redoOf: row.generationMeta?.redoOf ? row.generationMeta.redoOf + 1 : 1 },
      updatedAt: new Date(),
    })
    .where(eq(creatives.id, row.id));
  const lessons = await rejectionLessons(db, ws!.id as string);
  const done = generateOne(db, c.env.R2, aiEnv(c), row.id, {
    ws: { id: ws!.id as string, accountId: ws!.account_id as string },
    uid,
    brand,
    refs: refsFor(brand),
    campaign: null,
    lessons,
  });
  c.executionCtx.waitUntil(done.catch(() => {}));
  return c.json({ data: { id: row.id, status: "generating" } }, 202);
});

aiRouter.post("/creatives/:id/approve", async (c) => {
  const db = getDb(c.env.DB);
  const session = sessionOf(c);
  const uid = session.userId;
  if (!uid) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const row = ((await db.select().from(creatives).where(eq(creatives.id, c.req.param("id"))).limit(1))[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!row) throw new HttpError(404, "Creative not found", "NOT_FOUND");
  await wsContext(c, row.workspace_id as string, true);
  if (row.status !== "approved") {
    await db.update(creatives).set({ status: "approved", reviewedAt: new Date(), reviewedBy_id: uid, updatedAt: new Date() }).where(eq(creatives.id, row.id));
  }
  const post_id = await materializeApproved(db, row.id, uid);
  return c.json({ data: { id: row.id, status: "approved", post_id } });
});

aiRouter.get("/creatives/status", async (c) => {
  const db = getDb(c.env.DB);
  const { ws } = await wsContext(c, undefined, true);
  const count = async (statuses: string[]) =>
    (await db
      .select()
      .from(creatives)
      .where(and(eq(creatives.workspace_id, ws!.id as string), inArray(creatives.status, statuses as any))))?.length || 0;
  const [generating, pending] = await Promise.all([count(["generating"]), count(["pending", "redo_requested"])]);
  return c.json({ data: { generating, pending, total: generating + pending, inProgress: creativeActive.has(ws!.id as string) } });
});

/* ---------------- campaign templates ---------------- */

aiRouter.post("/campaign-templates/generate", async (c) => {
  const db = getDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId || c.req.query("workspaceId"), true);
  try {
    const r = await startGoogleTemplateGeneration(db, c.env.R2, aiEnv(c), {
      ws: { id: ws!.id as string, accountId: ws!.account_id as string },
      uid,
    });
    const done = templateRunFor(ws!.id as string);
    if (done) c.executionCtx.waitUntil(done.catch(() => {}));
    return c.json({ data: r }, r.started ? 202 : 200);
  } catch (e: any) {
    throw new HttpError(e.status || 400, e.message, e.code);
  }
});

aiRouter.get("/campaign-templates/status", async (c) => {
  const db = getDb(c.env.DB);
  const { ws } = await wsContext(c, undefined, true);
  return c.json({ data: await templateGenerationStatus(db, ws!.id as string) });
});

export default aiRouter;
