// fal.ai image generation (port of the old lib/ai-images.js).
//
// Worker adaptations:
// - No @fal-ai/client and no sharp. fal is driven through its queue REST API
//   (submit → poll → result) via fetch; images are saved to R2 as returned.
// - The old `cropToSlot` used sharp to crop to exact pixel dimensions. On
//   Workers there is no image pipeline, so generated images are stored at the
//   aspect ratio fal produced (requested via `aspect_ratio`); the slot's
//   target dimensions are recorded in metadata as the intended size.
import type { R2Bucket } from "@cloudflare/workers-types";
import { files, mediaAssets, aiSettings } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";
import { decryptSecret, isEncrypted } from "./secrets.js";
import { b64encode, generateJson, imagePart, type AiEnv } from "./ai-text.js";
import { buildScrapeContext } from "./brand-scrape.js";

const MODEL_T2I = "fal-ai/gemini-3.1-flash-image-preview";
const MODEL_EDIT = "fal-ai/gemini-3.1-flash-image-preview/edit";

export const SLOT_SPECS: Record<string, { slot: string; label: string; imageType: string; aspectRatio: string; mappedAspectRatio: string; targetWidth: number; targetHeight: number; minWidth: number; minHeight: number; outputFormat: string }> = {
  portrait: { slot: "portrait", label: "Portrait", imageType: "portrait", aspectRatio: "4:5", mappedAspectRatio: "4:5", targetWidth: 960, targetHeight: 1200, minWidth: 480, minHeight: 600, outputFormat: "png" },
  landscape: { slot: "landscape", label: "Landscape", imageType: "landscape", aspectRatio: "1.91:1", mappedAspectRatio: "16:9", targetWidth: 1200, targetHeight: 628, minWidth: 600, minHeight: 314, outputFormat: "jpeg" },
  square: { slot: "square", label: "Square thumbnail", imageType: "square", aspectRatio: "1:1", mappedAspectRatio: "1:1", targetWidth: 1200, targetHeight: 1200, minWidth: 300, minHeight: 300, outputFormat: "png" },
};

const QUALITY = "Clean professional commercial advertisement photograph with natural lighting and an uncluttered composition. No text overlays, no captions, no watermarks, no price tags, no fake UI elements, and no random, misspelled, or unwanted text anywhere in the image.";

/** Slot spec or 400 on unknown slot. */
export const specOf = (slot: string) => {
  const s = SLOT_SPECS[slot];
  if (!s) throw new HttpError(400, `Unknown slot: ${slot}`, "INVALID_SLOT");
  return s;
};

export const logoInstruction = (hasLogo: boolean) =>
  hasLogo ? "Place the exact brand logo from image_urls[0] in the bottom-left corner at modest size, with a transparent background and no white box, card, or frame around the logo. The logo must match the scene lighting and perspective. Do not place the logo anywhere else." : "";

export const slotPrompt = (userPrompt: string, slot: string, { hasLogo }: { hasLogo?: boolean } = {}) => {
  const s = specOf(slot);
  return [userPrompt.trim(), `${s.label} ${s.imageType} ad image.`, `Required aspect ratio ${s.aspectRatio} (minimum ${s.minWidth}×${s.minHeight} px).`, `Target output ${s.targetWidth}×${s.targetHeight} px ${s.outputFormat.toUpperCase()}.`, QUALITY, logoInstruction(!!hasLogo), "Photorealistic commercial photography, natural colors, high detail."].filter(Boolean).join(" ");
};

/** Full fal prompt: user creative prompt first, then the slot suffix (dimensions, quality, logo). */
export function buildGoogleAdImageFullPrompt(userPrompt: string, slot: string, { hasLogo }: { hasLogo?: boolean } = {}) {
  const s = specOf(slot);
  const suffix = [
    `${s.label} ${s.imageType} ad image for Google Ads.`,
    `Required aspect ratio ${s.aspectRatio} (minimum ${s.minWidth}×${s.minHeight} px).`,
    `Target output ${s.targetWidth}×${s.targetHeight} px ${s.outputFormat.toUpperCase()}.`,
    QUALITY,
    logoInstruction(!!hasLogo),
    "Photorealistic commercial photography, natural colors, high detail.",
  ].filter(Boolean).join(" ");
  return [userPrompt.trim(), suffix].filter(Boolean).join(", ");
}

export const previewPrompt = (title: string, content: string) =>
  ["Create a high-quality, photorealistic mobile advertising hero image for a display ad.", title ? `Promotion title: "${title.trim().slice(0, 120)}".` : "", content ? `Promotion message: "${content.trim().slice(0, 600)}".` : "", `Requirements: ${QUALITY}`].filter(Boolean).join(" ");

export interface FalConfig { apiKey: string }

export async function falConfig(env: AiEnv, db: Db): Promise<FalConfig> {
  let apiKey: string | null = null;
  try {
    const rows = await db.select().from(aiSettings).limit(1);
    const row = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
    if (row?.imageApiKey && env.SECRET_KEY) {
      try {
        apiKey = isEncrypted(row.imageApiKey) ? await decryptSecret(row.imageApiKey, env.SECRET_KEY) : row.imageApiKey;
      } catch {
        apiKey = null;
      }
    }
  } catch {
    /* table may not exist yet */
  }
  apiKey = apiKey || env.FAL_API_KEY || env.FAL_KEY || null;
  if (!apiKey) throw new HttpError(503, "FAL_API_KEY is not configured", "AI_UNCONFIGURED");
  return { apiKey };
}

/** fal vision models need raster images; drop SVGs we can't serve. */
const usableRef = (u: unknown) => typeof u === "string" && /^(https?:\/\/|data:image\/)/i.test(u) && !/\.svg(\?|$)/i.test(u);
/** A URL fal's servers cannot reach: our own dev origin, or any private/loopback host. */
const isLocalUrl = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[::1\]$)/i.test(h) || h.endsWith(".local");
  } catch {
    return false;
  }
};

/** Inline unreachable reference images as data URIs (fal accepts them). */
async function toFalRef(u: string): Promise<string> {
  if (!usableRef(u) || /^data:/i.test(u) || !isLocalUrl(u)) return u;
  const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Could not read reference image (${r.status})`);
  const ab = await r.arrayBuffer();
  const type = r.headers.get("content-type")?.split(";")[0] || "image/png";
  return `data:${type};base64,${b64encode(ab)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface QueueOpts { pollIntervalMs?: number; timeoutMs?: number }

/**
 * Submit to the fal queue API and poll until completion. Returns the first
 * image URL. Mirrors the old fal.subscribe behavior (wait for the image).
 */
export async function runImageJob(model: string, payload: Record<string, any>, apiKey: string, opts: QueueOpts = {}): Promise<string> {
  const { pollIntervalMs = 3000, timeoutMs = 150000 } = opts;
  const slug = model.split("/").slice(-2).join("/");
  const t0 = Date.now();
  const sub = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!sub.ok) throw new Error(`fal.ai queue submit ${slug} HTTP ${sub.status}: ${(await sub.text()).slice(0, 400)}`);
  const { request_id } = (await sub.json()) as { request_id: string };
  if (!request_id) throw new Error(`fal.ai ${slug} returned no request_id`);

  while (Date.now() - t0 < timeoutMs) {
    const st = await fetch(`https://queue.fal.run/${model}/requests/${request_id}/status`, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!st.ok) throw new Error(`fal.ai status ${slug} HTTP ${st.status}`);
    const s = (await st.json()) as { status: string };
    if (s.status === "COMPLETED") {
      const rr = await fetch(`https://queue.fal.run/${model}/requests/${request_id}`, {
        headers: { Authorization: `Key ${apiKey}` },
        signal: AbortSignal.timeout(30000),
      });
      const d = (await rr.json()) as any;
      const u = d?.images?.[0]?.url || d?.image?.url;
      if (!u) throw new Error(`fal.ai ${slug} returned no image`);
      console.info(`[fal] ${slug} OK (${Date.now() - t0}ms)`);
      return u;
    }
    if (s.status === "FAILED") throw new Error(`fal.ai ${slug} job failed`);
    await sleep(pollIntervalMs);
  }
  throw new Error(`fal.ai ${slug} timed out waiting for image`);
}

export interface AiCtx {
  env: AiEnv;
  db: Db;
  r2: R2Bucket;
  ws: { id: string; accountId: string };
  uid?: string | null;
}

/** Text → image (optionally with reference images: logo / master creatives). Returns { imageUrl, prompt, model }. */
export async function generateAdImage(ctx: AiCtx, prompt: string, aspectRatio = "4:5", refUrls: string[] = []): Promise<{ imageUrl: string; prompt: string; model: string }> {
  const { apiKey } = await falConfig(ctx.env, ctx.db);
  const refs = await Promise.all(refUrls.filter(usableRef).slice(0, 3).map(toFalRef));
  const hasRefs = refs.length > 0;
  const model = hasRefs ? MODEL_EDIT : MODEL_T2I;
  const finalPrompt = hasRefs ? prompt : prompt.replace(/[^.]*image_urls\[\d+\][^.]*\./gi, "").trim();
  const payload = {
    prompt: finalPrompt,
    num_images: 1,
    aspect_ratio: aspectRatio === "1.91:1" ? "16:9" : aspectRatio,
    resolution: "1K",
    output_format: "png",
    safety_tolerance: "6",
    ...(hasRefs ? { image_urls: refs } : {}),
  };
  const imageUrl = await runImageJob(model, payload, apiKey);
  return { imageUrl, prompt: finalPrompt, model };
}

/** Edit/refine an existing image. Uses flash model for speed. */
export async function editAdImage(ctx: AiCtx, prompt: string, imageUrl: string, aspectRatio = "auto", extraRefs: string[] = []): Promise<{ imageUrl: string; prompt: string; model: string }> {
  const { apiKey } = await falConfig(ctx.env, ctx.db);
  if (!usableRef(imageUrl)) throw new Error("A raster reference image URL (PNG/JPG/WEBP) is required");
  const mainRef = await toFalRef(imageUrl);
  const extra = await Promise.all((extraRefs || []).filter(usableRef).slice(0, 2).map(toFalRef));
  const payload = {
    prompt: prompt.trim(),
    num_images: 1,
    aspect_ratio: aspectRatio,
    resolution: "1K",
    output_format: "png",
    safety_tolerance: "6",
    image_urls: [mainRef, ...extra],
  };
  const out = await runImageJob(MODEL_EDIT, payload, apiKey);
  return { imageUrl: out, prompt: prompt.trim(), model: MODEL_EDIT };
}

export interface SavedImage {
  id: string;
  fileId: string;
  url: string;
  width?: number;
  height?: number;
}

const sanitizeName = (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";

/**
 * Persist a generated image (buffer or remote URL) to R2 + the files table +
 * media_assets. Replaces the old saveImageToLibrary(media-store.js).
 */
export async function saveGeneratedImage(opts: {
  db: Db;
  r2: R2Bucket;
  publicBaseUrl?: string;
  workspaceId: string;
  accountId: string;
  uid?: string | null;
  buffer?: ArrayBuffer | Uint8Array;
  url?: string;
  fileName: string;
  mimeType?: string;
  tags?: string[];
  metadata?: Record<string, any>;
  width?: number;
  height?: number;
}): Promise<SavedImage> {
  let bytes: ArrayBuffer;
  let mime = opts.mimeType || "image/png";
  if (opts.buffer) {
    bytes = opts.buffer instanceof Uint8Array ? opts.buffer.buffer.slice(opts.buffer.byteOffset, opts.buffer.byteOffset + opts.buffer.byteLength) as ArrayBuffer : opts.buffer;
  } else if (opts.url) {
    const r = await fetch(opts.url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`Could not download image (${r.status})`);
    mime = opts.mimeType || r.headers.get("content-type")?.split(";")[0] || "image/png";
    bytes = await r.arrayBuffer();
  } else {
    throw new Error("saveGeneratedImage needs a buffer or url");
  }
  const fileId = crypto.randomUUID();
  const key = `ai-generated/${fileId}-${sanitizeName(opts.fileName)}`;
  await opts.r2.put(key, bytes, { httpMetadata: { contentType: mime } });
  await opts.db.insert(files).values({
    id: fileId,
    tenantId: opts.accountId,
    r2Key: key,
    filename: opts.fileName,
    mimeType: mime,
    sizeBytes: bytes.byteLength,
    title: opts.fileName,
    isPublic: true,
    folder: "ai-generated",
    createdAt: new Date(),
  });
  const url = opts.publicBaseUrl ? `${opts.publicBaseUrl.replace(/\/$/, "")}/assets/${fileId}` : `/assets/${fileId}`;
  const inserted = await opts.db
    .insert(mediaAssets)
    .values({
      file_Id: fileId,
      fileName: opts.fileName,
      fileType: "image",
      mimeType: mime,
      url,
      sizeBytes: bytes.byteLength,
      width: opts.width ?? null,
      height: opts.height ?? null,
      source: "ai_generated",
      tags: opts.tags || [],
      metadata: opts.metadata || {},
      workspace_id: opts.workspaceId,
      uploadedBy_id: opts.uid || null,
      account_id: opts.accountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: mediaAssets.id });
  return { id: inserted[0]!.id, fileId, url, width: opts.width, height: opts.height };
}

/** Persist one generated slot image to the workspace media library. */
export const saveSlotImage = async (ctx: AiCtx, { buffer, slot, tags = [], metadata = {} }: { buffer: ArrayBuffer; slot: string; tags?: string[]; metadata?: Record<string, any> }) => {
  const s = specOf(slot);
  return saveGeneratedImage({
    db: ctx.db,
    r2: ctx.r2,
    publicBaseUrl: ctx.env.API_PUBLIC_URL,
    workspaceId: ctx.ws.id,
    accountId: ctx.ws.accountId,
    uid: ctx.uid,
    buffer,
    fileName: `${slot}-ad-image.png`,
    mimeType: "image/png",
    tags: [`ai-ad-${slot}`, `google-${slot}`, ...tags],
    metadata,
    // Intended slot dimensions (fal generates at the requested aspect ratio;
    // exact pixels are not cropped on Workers — see module header).
    width: s?.targetWidth,
    height: s?.targetHeight,
  });
};

/** Download a remote image to bytes (no cropping on Workers). */
export async function downloadImageBytes(imageUrl: string): Promise<ArrayBuffer> {
  const r = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Could not download generated image (${r.status})`);
  return r.arrayBuffer();
}

/**
 * Scrape the brand's website, feed the content + images to Gemini, and return
 * an enriched photographer-style imagePrompt + ref image URLs.
 */
export async function buildEnrichedImagePrompt(ctx: AiCtx, websiteUrl: string, brand: Record<string, any> = {}, postContent: Record<string, any> = {}): Promise<{ imagePrompt: string | null; refImageUrls: string[] }> {
  let scraped;
  try {
    scraped = await buildScrapeContext(websiteUrl);
  } catch {
    return { imagePrompt: null, refImageUrls: [] };
  }
  const logoUrl = scraped.meta.logo || scraped.meta.ogImage || "";
  const contentImageUrls = (scraped.imageCandidates || []).map((img) => img.src).filter((u) => u && !/\.(svg|gif)(\?|$)/i.test(u) && u !== logoUrl);
  const allRefUrls = [...new Set([logoUrl, ...contentImageUrls].filter(Boolean))].slice(0, 4);

  const imageParts = [];
  for (const imgUrl of allRefUrls) {
    const part = await imagePart(imgUrl, { maxBytes: 4 * 1024 * 1024 }).catch(() => null);
    if (part) imageParts.push(part);
  }

  const brandName = brand.name || scraped.meta.siteName || scraped.meta.title || "the brand";
  const logoNote = logoUrl
    ? `NOTE: The brand logo is provided as the FIRST reference image (image_urls[0]). In "imagePrompt", always include: "Place the exact brand logo from image_urls[0] in the bottom-left corner at modest size, transparent background, no white box or frame, matching scene lighting."`
    : `NOTE: No logo detected. Do not add any fake logos or text overlays.`;
  const promptText = `You are a creative director writing a Google Ads image generation brief for fal.ai.

BRAND: ${brandName}
INDUSTRY: ${brand.industry || scraped.meta.description?.slice(0, 120) || "unknown"}
TAGLINE: ${brand.tagline || ""}
POST TITLE: ${postContent.title || ""}
POST BODY: ${(postContent.body || "").slice(0, 400)}

WEBSITE CONTEXT:
Headings: ${JSON.stringify((scraped.headings || []).slice(0, 12))}
Body snippet: ${(scraped.bodyText || "").slice(0, 1200)}
CTA buttons: ${JSON.stringify(scraped.ctaButtons || [])}

${logoNote}

Write a single "imagePrompt" string (max 300 chars) that describes a PHOTOREALISTIC commercial ad image scene relevant to this brand and post. The scene must:
- Show the brand's product, service, or lifestyle context clearly
- Be a real-world setting a photographer would shoot
- Forbid any text overlays, watermarks, captions, or unwanted text in the scene

Return ONLY valid JSON: { "imagePrompt": "..." }`;
  try {
    const parsed = await generateJson(ctx.env, ctx.db, promptText, imageParts);
    if (parsed?.imagePrompt) return { imagePrompt: parsed.imagePrompt, refImageUrls: allRefUrls };
  } catch (e: any) {
    console.warn(`[EnrichedPrompt] Gemini call failed: ${e?.message}`);
  }
  const fallback = `Professional advertising image for ${brandName}${brand.industry ? `, a ${brand.industry} brand` : ""}${brand.tagline ? `. ${brand.tagline}` : ""}. ${scraped.meta.description?.slice(0, 150) || ""}`.trim();
  return { imagePrompt: fallback || null, refImageUrls: allRefUrls };
}

/** Generate ONLY the portrait (4:5) slot using an enriched prompt (portrait-first flow). */
export async function generatePortraitOnly(ctx: AiCtx, { prompt, refs = [], campaignId = null }: { prompt: string; refs?: string[]; campaignId?: string | null }) {
  const hasLogo = refs.length > 0;
  const finalPrompt = buildGoogleAdImageFullPrompt(prompt, "portrait", { hasLogo });
  const gen = await generateAdImage(ctx, finalPrompt, specOf("portrait").mappedAspectRatio, refs);
  const buf = await downloadImageBytes(gen.imageUrl);
  const mediaAsset = await saveSlotImage(ctx, { buffer: buf, slot: "portrait", tags: ["ai-ad-portrait", "google-portrait"], metadata: { prompt: finalPrompt, model: gen.model, campaignId } });
  return { portraitUrl: mediaAsset.url, mediaAsset, model: gen.model, prompt: finalPrompt };
}

/** Given an accepted portrait URL, generate landscape + square in parallel. */
export async function expandFromPortrait(ctx: AiCtx, { prompt, refs = [], portraitUrl, campaignId = null }: { prompt: string; refs?: string[]; portraitUrl: string; campaignId?: string | null }) {
  const hasLogo = refs.length > 0;
  const landscapePrompt = buildGoogleAdImageFullPrompt(prompt, "landscape", { hasLogo });
  const squarePrompt = buildGoogleAdImageFullPrompt(prompt, "square", { hasLogo });
  const [landscape, square] = await Promise.all([generateAdImage(ctx, landscapePrompt, "1.91:1", refs), generateAdImage(ctx, squarePrompt, "1:1", refs)]);
  const [lBuf, sBuf] = await Promise.all([downloadImageBytes(landscape.imageUrl), downloadImageBytes(square.imageUrl)]);
  const [landscapeMediaAsset, squareMediaAsset] = await Promise.all([
    saveSlotImage(ctx, { buffer: lBuf, slot: "landscape", metadata: { prompt: landscapePrompt, model: landscape.model, campaignId } }),
    saveSlotImage(ctx, { buffer: sBuf, slot: "square", metadata: { prompt: squarePrompt, model: square.model, campaignId } }),
  ]);
  return {
    portraitUrl,
    landscapeUrl: landscapeMediaAsset.url,
    squareUrl: squareMediaAsset.url,
    portraitMediaAsset: { url: portraitUrl, role: "portrait", googleReady: true },
    landscapeMediaAsset,
    squareMediaAsset,
  };
}

/** All three Google Ad ratios generated in parallel, each with its own slot prompt. */
export async function generateMultiRatioSet(
  ctx: AiCtx,
  { prompt, refs = [], existingPortraitUrl = null, campaignId = null }: { prompt: string; refs?: string[]; existingPortraitUrl?: string | null; campaignId?: string | null },
) {
  const hasLogo = refs.length > 0;
  const portraitPrompt = buildGoogleAdImageFullPrompt(prompt, "portrait", { hasLogo });
  const landscapePrompt = buildGoogleAdImageFullPrompt(prompt, "landscape", { hasLogo });
  const squarePrompt = buildGoogleAdImageFullPrompt(prompt, "square", { hasLogo });
  const portraitPromise = existingPortraitUrl ? Promise.resolve({ imageUrl: existingPortraitUrl, model: "existing", prompt }) : generateAdImage(ctx, portraitPrompt, "4:5", refs);
  const [portrait, landscape, square] = await Promise.all([portraitPromise, generateAdImage(ctx, landscapePrompt, "1.91:1", refs), generateAdImage(ctx, squarePrompt, "1:1", refs)]);
  const [pBuf, lBuf, sBuf] = await Promise.all([downloadImageBytes(portrait.imageUrl), downloadImageBytes(landscape.imageUrl), downloadImageBytes(square.imageUrl)]);
  const meta = (m: { model: string }) => ({ prompt, model: m.model, campaignId });
  const [portraitMediaAsset, landscapeMediaAsset, squareMediaAsset] = await Promise.all([
    saveSlotImage(ctx, { buffer: pBuf, slot: "portrait", metadata: meta(portrait) }),
    saveSlotImage(ctx, { buffer: lBuf, slot: "landscape", metadata: meta(landscape) }),
    saveSlotImage(ctx, { buffer: sBuf, slot: "square", metadata: meta(square) }),
  ]);
  return { portraitUrl: portraitMediaAsset.url, landscapeUrl: landscapeMediaAsset.url, squareUrl: squareMediaAsset.url, portraitMediaAsset, landscapeMediaAsset, squareMediaAsset };
}

/** Generate a single master ad image slot (defaults to portrait 4:5). */
export async function generateSingleSlotSet(ctx: AiCtx, { prompt, refs = [], slot = "portrait", campaignId = null }: { prompt: string; refs?: string[]; slot?: string; campaignId?: string | null }) {
  const hasLogo = refs.length > 0;
  const spec = SLOT_SPECS[slot] ?? specOf("portrait");
  const gen = await generateAdImage(ctx, slotPrompt(prompt, slot, { hasLogo }), spec.mappedAspectRatio, refs);
  const buf = await downloadImageBytes(gen.imageUrl);
  const mediaAsset = await saveSlotImage(ctx, { buffer: buf, slot, tags: [`ai-ad-${slot}`, `google-${slot}`], metadata: { prompt, model: gen.model, campaignId } });
  return { url: mediaAsset.url, mediaAsset, model: gen.model, prompt: gen.prompt };
}

/** Distinct, diverse creative variations per aspect ratio (maximize pipeline). */
export async function generateDistinctMaximizedImageSet(ctx: AiCtx, { prompt, refs = [], existingPortraitUrl = null, campaignId = null }: { prompt: string; refs?: string[]; existingPortraitUrl?: string | null; campaignId?: string | null }) {
  const hasLogo = refs.length > 0;
  const cleanPrompt = (prompt || "Commercial advertising image").trim();
  const taskDefs = [
    { slot: "portrait", prompt: buildGoogleAdImageFullPrompt(`${cleanPrompt}. Lifestyle scene in natural real-world context, modern vertical composition, natural daylight, customer in authentic environment`, "portrait", { hasLogo }), tag: "google-portrait" },
    { slot: "landscape", prompt: buildGoogleAdImageFullPrompt(`${cleanPrompt}. Wide environmental cinematic scene, 45-degree angle, authentic ambient lighting, different setting and hero perspective for visual variety`, "landscape", { hasLogo }), tag: "google-landscape" },
    { slot: "square", prompt: buildGoogleAdImageFullPrompt(`${cleanPrompt}. Close-up dynamic human interaction with the product or service, eye-level 50mm framing, vibrant warm lighting, crisp focal depth`, "square", { hasLogo }), tag: "google-square" },
  ];
  if (existingPortraitUrl) {
    const keep = taskDefs.filter((t) => t.slot !== "portrait");
    taskDefs.length = 0;
    taskDefs.push(...keep);
  }
  const tasks = taskDefs.map(({ slot, prompt: pPrompt, tag }) => (async () => {
    const spec = specOf(slot);
    const gen = await generateAdImage(ctx, pPrompt, spec.mappedAspectRatio, refs);
    const buf = await downloadImageBytes(gen.imageUrl);
    const mediaAsset = await saveSlotImage(ctx, { buffer: buf, slot, tags: [tag, "maximized"], metadata: { prompt: pPrompt, model: gen.model, campaignId } });
    return { slot, url: mediaAsset.url, mediaAsset };
  })());
  const settled = await Promise.allSettled(tasks);
  const results = settled.filter((s): s is PromiseFulfilledResult<{ slot: string; url: string; mediaAsset: SavedImage }> => s.status === "fulfilled").map((s) => s.value);
  if (!results.length) {
    const firstFailure = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    throw firstFailure?.reason || new Error("All creative angle generations failed");
  }
  const bySlot = Object.fromEntries(results.map((r) => [r.slot, r]));
  return {
    portraitUrl: bySlot.portrait?.url || existingPortraitUrl || null,
    landscapeUrl: bySlot.landscape?.url || null,
    squareUrl: bySlot.square?.url || null,
    portraitMediaAsset: bySlot.portrait?.mediaAsset || null,
    landscapeMediaAsset: bySlot.landscape?.mediaAsset || null,
    squareMediaAsset: bySlot.square?.mediaAsset || null,
  };
}
