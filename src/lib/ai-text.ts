// Gemini text helpers (JSON-constrained, optionally multimodal).
// Port of the old lib/ai-text.js. The @google/genai Node SDK can't run on
// Workers, so this calls the Gemini REST API directly via fetch.
//
// Config resolution mirrors the old backend: the `ai_settings` row (decrypted
// textApiKey) wins, otherwise the GEMINI_API_KEY env var. Model from
// AI_TEXT_MODEL env → row → default, with AI_FALLBACK_MODEL as fallback.
import { aiSettings } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";
import { decryptSecret, isEncrypted } from "./secrets.js";

export interface AiEnv {
  GEMINI_API_KEY?: string;
  FAL_API_KEY?: string;
  FAL_KEY?: string;
  AI_TEXT_MODEL?: string;
  AI_FALLBACK_MODEL?: string;
  SECRET_KEY?: string;
  API_PUBLIC_URL?: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  fallback: string;
}

const DEFAULT_MODEL = "gemini-2.5-flash";

// Short-lived in-isolate cache (same idea as the old 60s client cache).
let cfgCache: { at: number; key: string; cfg: GeminiConfig } | null = null;

export async function geminiConfig(env: AiEnv, db: Db): Promise<GeminiConfig> {
  const cacheKey = `${env.GEMINI_API_KEY || ""}|${env.AI_TEXT_MODEL || ""}|${env.AI_FALLBACK_MODEL || ""}`;
  if (cfgCache && Date.now() - cfgCache.at < 60000 && cfgCache.key === cacheKey) return cfgCache.cfg;

  let row: Record<string, any> | null = null;
  try {
    const rows = await db.select().from(aiSettings).limit(1);
    row = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  } catch {
    row = null;
  }
  let apiKey: string | null = null;
  if (row?.textApiKey && env.SECRET_KEY) {
    try {
      apiKey = isEncrypted(row.textApiKey) ? await decryptSecret(row.textApiKey, env.SECRET_KEY) : row.textApiKey;
    } catch {
      apiKey = null;
    }
  }
  apiKey = apiKey || env.GEMINI_API_KEY || null;
  if (!apiKey) throw new HttpError(503, "GEMINI_API_KEY is not configured", "AI_UNCONFIGURED");

  const model = env.AI_TEXT_MODEL || row?.textModel || DEFAULT_MODEL;
  const fallback = env.AI_FALLBACK_MODEL || row?.fallbackModel || model;
  const cfg = { apiKey, model, fallback };
  cfgCache = { at: Date.now(), key: cacheKey, cfg };
  return cfg;
}

function stripFences(t: string): string {
  return t.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
}

interface GeminiPart {
  text?: string;
  inlineData?: { data: string; mimeType: string };
}

/** Ask for JSON (text prompt + optional inlineData image parts); tries the configured model then the fallback. */
export async function generateJson(env: AiEnv, db: Db, prompt: string, parts: GeminiPart[] = []): Promise<any> {
  const g = await geminiConfig(env, db);
  let lastErr: any = null;
  for (const model of [...new Set([g.model, g.fallback])]) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": g.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      const txt = stripFences(String(data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || ""));
      if (!txt) throw new Error(`Gemini ${model} returned no text`);
      return JSON.parse(txt);
    } catch (e: any) {
      console.warn(`[Gemini generateJson] ${model} failed:`, e?.message);
      lastErr = e;
    }
  }
  throw lastErr || new Error("Gemini returned no usable JSON");
}

/** ArrayBuffer → base64 without Node's Buffer. */
export function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Download an image as a Gemini inlineData part (null when unusable: data URIs, SVG, >4 MB, unreachable). */
export async function imagePart(url: string, { maxBytes = 4 * 1024 * 1024 } = {}): Promise<GeminiPart | null> {
  if (!url || typeof url !== "string" || !/^https?:/i.test(url)) return null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const mimeType = ((r.headers.get("content-type") || "image/jpeg").split(";")[0] || "image/jpeg").trim().toLowerCase();
    if (!IMAGE_MIMES.has(mimeType)) return null;
    const ab = await r.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return { inlineData: { data: b64encode(ab), mimeType } };
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number): string => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
const arr = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v) ? v.map((s) => str(s, each)).filter(Boolean).slice(0, max) : [];

export async function creativeTitle(env: AiEnv, db: Db, brief: string): Promise<{ name: string; headline: string }> {
  const b = String(brief || "").trim();
  if (!b) return { name: "AI Creative", headline: "Discover More" };
  try {
    const p = await generateJson(
      env,
      db,
      `You write short ad naming copy. Based on this creative brief, return ONLY valid JSON:\n{\n  "name": "Internal post title, max 80 chars, catchy but professional, NOT the full brief",\n  "headline": "Short ad headline, max 30 chars, high-converting"\n}\nCreative brief:\n${b.slice(0, 1200)}`,
    );
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : b.slice(0, 80);
    return { name, headline: typeof p.headline === "string" && p.headline.trim() ? p.headline.trim().slice(0, 30) : name.slice(0, 30) };
  } catch {
    const f = (b.replace(/\s+/g, " ").split(/[.!?]/)[0] || "").slice(0, 80) || "AI Creative";
    return { name: f, headline: f.slice(0, 30) };
  }
}

export interface BrandLike {
  name?: string;
  industry?: string;
  location?: string;
  tagline?: string;
  description?: string;
  audience?: string;
  keywords?: string[];
  products?: string[];
  objectives?: string[];
  themes?: string[];
  toneOfVoice?: string[];
  sourceUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  fonts?: { primary?: string; heading?: string };
}

/** Headline + body for a creative, in the brand's voice. `avoid` = lessons from rejected creatives. */
export async function creativeCopy(
  env: AiEnv,
  db: Db,
  { brand, theme, objective, language, avoid }: { brand: BrandLike; theme: string; objective?: string; language?: string | null; avoid?: string },
): Promise<{ headline: string; body: string; cta: string }> {
  const b = brand || {};
  try {
    const p = await generateJson(
      env,
      db,
      `You write ad copy for ${b.name || "a business"} (${b.industry || "business"}${b.location ? `, ${b.location}` : ""}). Tone of voice: ${(b.toneOfVoice || []).join(", ") || "clear and friendly"}. Audience: ${b.audience || "local customers"}. Keywords: ${(b.keywords || []).slice(0, 8).join(", ")}.\nCreative angle: ${theme}. Campaign goal: ${objective || "website visitors"}. Language: ${language || "the brand's website language"}.${avoid ? `\n${avoid}` : ""}\nReturn ONLY valid JSON: {"headline": "max 40 chars, no quotes, no exclamation spam", "body": "1–2 sentences, max 150 chars", "cta": "one of learn_more|shop_now|sign_up|book_now|contact_us|get_offer"}`,
    );
    return { headline: String(p.headline || "").slice(0, 40), body: String(p.body || "").slice(0, 150), cta: String(p.cta || "learn_more") };
  } catch {
    return { headline: b.tagline?.slice(0, 40) || `Discover ${b.name || "us"}`, body: b.description?.slice(0, 150) || "", cta: "learn_more" };
  }
}

/* ---------- ported from reach_be AIGeneratorService ---------- */
const LIMITS: Record<string, number> = { headline: 30, description: 90, longHeadline: 90, content: 5000, name: 200, callToAction: 50 };
const LABELS: Record<string, string> = {
  headline: "ad headline",
  description: "ad description",
  longHeadline: "Performance Max long headline",
  content: "post body copy",
  name: "internal post name/title",
  callToAction: "call-to-action phrase",
};
export const IMPROVE_FIELDS = Object.keys(LIMITS);

/** Inline "improve" for one field, in the brand's language and voice. */
export async function improveText(
  env: AiEnv,
  db: Db,
  { field, currentText, brand, context }: { field: string; currentText: string; brand: BrandLike; context?: Record<string, any> },
): Promise<{ improvedText: string }> {
  const b = brand || {};
  const maxLen = LIMITS[field] ?? 5000;
  const text = String(currentText || "").trim();
  const prompt = `You are an expert copywriter improving ${LABELS[field]} for a social media or advertising post.

BRAND CONTEXT:
- Business name: ${b.name || "Your Brand"}
- Industry: ${b.industry || "General"}
- Tagline: ${b.tagline || ""}
- Description: ${b.description || ""}
- Target audience: ${b.audience || ""}
- Products/services: ${(b.products || []).join(", ")}
- Keywords: ${(b.keywords || []).join(", ")}
- Advertisement objectives: ${(b.objectives || []).join(", ")}
- Brand themes: ${(b.themes || []).join(", ")}
- Tone of voice: ${(b.toneOfVoice || []).join(", ")}
- Website: ${b.sourceUrl || ""}
- Brand colors (tone hints): primary ${b.primaryColor || ""}, accent ${b.accentColor || ""}
- Brand fonts: ${b.fonts?.primary || ""} / ${b.fonts?.heading || ""}

FIELD TO IMPROVE: ${field}
MAX LENGTH: ${maxLen} characters
CURRENT TEXT: ${text || "(empty — write fresh on-brand copy)"}
${context?.platform ? `Platform: ${context.platform}` : ""}
${context?.objective ? `Campaign objective: ${context.objective}` : ""}
${context?.contentType ? `Content type: ${context.contentType}` : ""}

Detect the natural language of the brand content above and write output in that language.

Return ONLY valid JSON:
{
  "improvedText": "improved copy for this field"
}

Rules:
- Align with brand voice, target audience, and business objectives
- Stay at or under ${maxLen} characters
- If current text exists, improve clarity and conversion while preserving core intent
- For headlines and CTA, be punchy and action-oriented
${field === "longHeadline" ? "- Long headlines MUST be at least 30 characters (Google Ad Strength prefers 30–90)" : ""}
- Do not wrap JSON in markdown`;
  const p = await generateJson(env, db, prompt);
  return { improvedText: str(p.improvedText, maxLen) || text.slice(0, maxLen) };
}

const isCleanUrl = (u: unknown, alt = "") =>
  typeof u === "string" && /^https?:/i.test(u) && !u.includes("base64,") && !/flag|english|swedish|language/i.test(alt);

export interface ScrapeContextLike {
  url: string;
  meta: {
    siteName?: string;
    title?: string;
    description?: string;
    keywords?: string[];
    logo?: string;
    lang?: string;
  };
  headings?: string[];
  bodyText?: string;
  footerText?: string;
  jsonLdData?: any[];
  ctaButtons?: string[];
  imageCandidates?: { src: string; alt?: string }[];
}

/** Full ad package (15 headlines, 5 descriptions, 5 long headlines, content, CTA, targeting, image prompt) from a scraped site. */
export async function adAssetsFromScrape(
  env: AiEnv,
  db: Db,
  c: ScrapeContextLike,
  { past = { headlines: [], prompts: [] } }: { past?: { headlines: string[]; prompts: string[] } } = {},
): Promise<Record<string, any>> {
  const brandName = c.meta.siteName || c.meta.title || "Brand";
  const siteTitle = c.meta.title || "";
  const metaDesc = c.meta.description || "";
  const keywords = (c.meta.keywords || []).join(", ");
  const headings = (c.headings || []).join(" | ");
  const bodySnippet = (c.bodyText || "").slice(0, 15000);
  const footerSnippet = (c.footerText || "").slice(0, 2000);
  const jsonLdSnippet = c.jsonLdData?.length ? JSON.stringify(c.jsonLdData).slice(0, 2500) : "";
  const ctaOptions = (c.ctaButtons || []).join(", ");
  const images = c.imageCandidates || [];
  const logoUrl = isCleanUrl(c.meta.logo) ? (c.meta.logo as string) : "";
  const refUrls = [...new Set([logoUrl, ...images.filter((i) => isCleanUrl(i.src, i.alt)).map((i) => i.src)].filter(Boolean))].slice(0, 4);
  const imageAltTexts = images.map((i) => i.alt).filter((a) => a && a.length > 2).join(" | ");

  const parts = (await Promise.all(refUrls.map((u) => imagePart(u)))).filter(Boolean) as GeminiPart[];
  const logoContextInstruction = logoUrl
    ? `NOTE: The official brand logo is provided as the FIRST reference image (image_urls[0]). In the "imagePrompt" field, ALWAYS include this exact logo instruction: "Place the exact brand logo from image_urls[0] in the bottom-left corner at modest size, transparent background, no white box or frame, matching scene lighting." The hero subject stays clean and uncluttered; do not add any other text or logos in the scene.`
    : `NOTE: No official logo URL was detected. Focus purely on hero product presentation and clean composition without inserting fake logos or any text overlays.`;
  let novelty = "";
  if (past.headlines.length || past.prompts.length) {
    const cleanPast = (p: string) =>
      p
        .replace(/^A\s+(?:top-down\s+|eye-level\s+|45-degree\s+|wide\s+|close-up\s+)?(?:flatlay\s+|photograph\s+|photo\s+|shot\s+|macro\s+)?(?:of\s+|with\s+)?/i, "")
        .replace(/^(?:a|an)\s+/i, "")
        .slice(0, 180)
        .trim();
    const cards = past.prompts.slice(-25).map(cleanPast).filter(Boolean).map((s, i) => `Card #${i + 1}: "${s}"`).join(" || ");
    novelty = `\nCRITICAL NOVELTY & HERO SUBJECT DIVERSITY MANDATE: You have ALREADY generated previous ad concept(s) for this brand.
1. HEADLINE & COPY NOVELTY: Do NOT repeat any of these previous headlines, descriptions, or copy angles: "${past.headlines.slice(-25).join(" | ")}". Generate 15 completely NEW, distinct headlines and fresh copy.
2. HERO SUBJECT & SCENE DIVERSITY (STRICT MANDATE - ZERO REPETITION): the following hero subjects, scenes, focal items, and environments were ALREADY featured in previous concept cards for this brand: [ ${cards} ]. You are ABSOLUTELY FORBIDDEN from repeating any of those focal subjects, items, materials, or core scenes — even in different positions, lighting, or angles. Independently create a completely fresh, unrepresented real-world scenario directly relevant to this brand (for digital services/SaaS: different authentic customer moments, personas, settings; for physical products, venues, or food: different catalog items, environments, preparation steps, or use cases).
3. CAMERA PERSPECTIVE & COMPOSITION ROTATION: rotate camera angles and compositions across concept generations (eye-level close-up, top-down flatlay, wide environmental scene, 45-degree side profile). NEVER use the same composition twice in a row!`;
  }
  const prompt = `You are a world-class digital advertising expert specializing in Google Ads, Meta Ads, and High-Converting Copywriting.

STEP 1 – LANGUAGE DETECTION (MANDATORY FIRST STEP, DO THIS BEFORE GENERATING ANYTHING):
Carefully read ALL of the scraped website text below and determine: what is the natural human language of this website?
- Website Title: "${siteTitle}"
- Meta Description: "${metaDesc}"
- Key Headings: "${headings}"
- Body Content: "${bodySnippet}"
- Footer & Contact: "${footerSnippet}"
Once you identify the language (e.g. Swedish, Finnish, German, French, Norwegian, English), LOCK that language for the entire output. EVERY SINGLE text field you generate MUST be 100% in that locked language ("headlines", "descriptions", "longHeadline", "longHeadlines", "content", "callToAction"). NEVER fall back to English unless the website itself is natively written in English.

STEP 2 – HERO CONCEPT SELECTION: choose ONE single primary hero topic/product/service scene for this ad concept. ALL 15 headlines, 5 descriptions, 5 longHeadlines, content, and imagePrompt MUST revolve around this SAME hero.

Analyze the following website context and attached visual reference images for the brand "${brandName}":
- Website Title: "${siteTitle}"
- Meta Description: "${metaDesc}"
- Meta Keywords: "${keywords}"
- Key Headings/Services: "${headings}"
- Banner Image Context: "${imageAltTexts}"
- Body Content: "${bodySnippet}"
- Footer & Contact Address Information: "${footerSnippet}"
${jsonLdSnippet ? `- Structured Data (JSON-LD): ${jsonLdSnippet}\n` : ""}- Site CTAs: "${ctaOptions}"
- ${logoContextInstruction}${novelty}

CRITICAL COPY DIVERSITY MANDATE: the "content" field MUST NOT start with "Immerse" or any of these banned opening words: Discover, Experience, Explore, Welcome, Step into, Embark, Delight. Start with a bold fact, a question, the product/service name itself, a benefit statement, or a location hook.

CRITICAL SINGLE-CONCEPT CONTEXT ALIGNMENT: every element in this JSON output MUST tell a unified, cohesive story around the exact same hero topic.

Generate a complete ad package in JSON format containing:
1. "name": The clean, official brand name ONLY (e.g. "${brandName}"). Do NOT append domain extensions like .com or "- Ad Campaign".
2. "headlines": Array of EXACTLY 15 punchy, high-converting Google Ads headlines in the website's primary language (each MUST be <= 30 characters, ALL unique, include at least one with 15 characters or less).
3. "descriptions": Array of EXACTLY 5 persuasive ad descriptions (each MUST be <= 90 characters; at least one MUST be <= 60 characters).
4. "longHeadlines": Array of EXACTLY 5 unique long headlines (each MUST be 30–90 characters), completely distinct from all descriptions and short headlines.
5. "content": A well-structured primary ad body text (2-3 short paragraphs with key benefits & offer aligned with the hero topic).
6. "callToAction": MUST strictly select ONE official Google Ads supported Call To Action phrase in the website's primary language.
   - If website is in Swedish, select strictly from: "Läs mer", "Köp nu", "Boka nu", "Få offert", "Ansök nu", "Registrera dig", "Kontakta oss", "Prenumerera", "Ladda ner", "Besök webbplatsen".
   - If website is in English (or other language), select strictly from: "Learn More", "Shop Now", "Book Now", "Get Quote", "Apply Now", "Sign Up", "Contact Us", "Subscribe", "Download", "Visit Site".
7. "businessName": The clean, official brand/business name ONLY.
8. "keywords": Array of 25 to 35 high-intent, high-conversion commercial search keywords and phrases (each 2-5 words). MANDATORY:
   - Derivation: Directly derive from the specific products, services, solutions, features, pricing/offer terms, and geographic areas found on the scraped website above.
   - Mix: Include exact-intent search queries, commercial "buy/hire/book/cost/best" transactional phrases, problem-solving queries, and brand/service combinations.
   - Absolutely NO generic single-word or filler keywords (NO plain "store", "services", "cheap", "good"). Every keyword must represent an active high-value searcher with clear purchase or action intent.
9. "targetLocations": Array of 1 to 3 primary recommended target locations/cities/countries. MANDATORY: Ground locations strictly in the physical address, city, country code, or geographic service areas cited on the website and footer (e.g. ["Stockholm, Sweden"] or ["Gothenburg, Sweden"] if located there, or specific countries/regions explicitly cited).
10. "targetAgeRange": An object with recommended minimum and maximum age range (e.g. {"ageMin": 18, "ageMax": 65}).
11. "targetLanguage": The 2-letter ISO language code of the detected primary language (e.g. "sv", "en", "de", "fr", "es").
12. "imagePrompt": Write this EXACTLY like a professional food/product/commercial photographer briefing a camera, not like an art director writing marketing copy:
STEP A - PICK ONE HERO SUBJECT ONLY. One dish, one product, or one distinct hero item/scene relevant to this brand.
STEP B - DESCRIBE THE HERO SUBJECT'S PHYSICAL REALITY: exact visible textures and physical facts (e.g. "glistening oil pooling at the edge," "condensation beading on glass," "scratched wood grain"), real imperfections a camera would catch, realistic portion size, scale, and placement.
STEP C - NAME THE EXACT LIGHTING SETUP (pick one that matches this brand's real setting; never generic words like "warm lighting"): e.g. "soft window light from camera-left, visible falloff creating natural shadow on the right side" / "single overhead pendant light directly above, warm 3000K tone, slight vignette at the frame edges" / "late-afternoon golden hour light through a window, long soft shadows across the surface".
STEP D - NAME THE EXACT CAMERA/LENS/ANGLE (rotate across generations): "shot at a 45-degree angle with an 85mm lens, shallow depth of field, background softly blurred" / "top-down flatlay shot with a 35mm lens, everything in sharp focus" / "eye-level close-up shot with a 50mm lens, shallow focus on the front third of the hero subject".
STEP E - SURFACE AND BACKGROUND: ONE real, plausible surface or setting matching the authentic environment of the brand. For food, use authentic tableware appropriate to that cuisine (avoiding black slate plates or dark stone trays).
STEP F - NEGATIVE CONSTRAINTS (include verbatim): "This must look like an unedited photograph taken on a real camera in an authentic real-world location - not a 3D render, not a CGI scene, not an overly symmetrical staged composition, not glossy or plastic-looking objects, not studio-perfect artificial lighting, not more than one primary hero subject in frame. No text overlays, no captions, no watermarks, no price tags, and no random or misspelled text anywhere in the image."
${logoUrl ? 'STEP G - LOGO (required when logo reference exists): add this sentence verbatim to the imagePrompt: "Place the exact brand logo from image_urls[0] in the bottom-left corner at modest size, with a transparent background and no white box, card, or frame, matching the scene lighting and perspective. Do not place the logo anywhere else."' : "STEP G - NO LOGO: do not invent or draw any logo, badge, or text overlay in the image."}

Respond STRICTLY with valid raw JSON format without markdown code blocks or wrapping.`;

  const p = await generateJson(env, db, prompt, parts);
  const longs = [...new Map([...arr(p.longHeadlines, 5, 90), str(p.longHeadline, 90)].filter(Boolean).map((s) => [s.toLowerCase(), s])).values()].slice(0, 5);
  if (!longs.length && siteTitle) longs.push(siteTitle.slice(0, 90));
  const age =
    p.targetAgeRange && typeof p.targetAgeRange === "object"
      ? { ageMin: Number(p.targetAgeRange.ageMin) || 18, ageMax: Number(p.targetAgeRange.ageMax) || 65 }
      : { ageMin: 18, ageMax: 65 };
  return {
    name: str(p.name, 120) || brandName,
    businessName: str(p.businessName, 120) || brandName,
    headlines: arr(p.headlines, 15, 30).length ? arr(p.headlines, 15, 30) : [siteTitle.slice(0, 30)],
    descriptions: arr(p.descriptions, 5, 90).length ? arr(p.descriptions, 5, 90) : [metaDesc.slice(0, 90)],
    longHeadline: longs[0] || siteTitle.slice(0, 90),
    longHeadlines: longs,
    content: str(p.content, 5000) || metaDesc || bodySnippet.slice(0, 600),
    callToAction: str(p.callToAction, 50) || "Learn More",
    keywords: arr(p.keywords, 35, 80),
    targetLocations: arr(p.targetLocations, 3, 80),
    targetAgeRange: age,
    targetLanguage: (str(p.targetLanguage, 5) || ((c.meta.lang || "en").split("-")[0] || "en")).toLowerCase(),
    imagePrompt: str(p.imagePrompt, 4000) || `A sleek, high-converting digital ad image for ${brandName} featuring products in vibrant modern lighting with brand colors.`,
    logoUrl: logoUrl || undefined,
    sourceUrl: c.url,
  };
}

/** Google Shopping targeting for a merchant product (multimodal when a product image is given). */
export async function productTargeting(
  env: AiEnv,
  db: Db,
  { title, brand, price, currency, imageUrl, destinationUrl, productId }: Record<string, any>,
): Promise<Record<string, any>> {
  const parts = [await imagePart(imageUrl, { maxBytes: 4 * 1024 * 1024 })].filter(Boolean) as GeminiPart[];
  const p = await generateJson(
    env,
    db,
    `You are an expert Google Shopping Ads campaign strategist. Analyze the provided product image and metadata to generate optimal Google Ads targeting settings.

PRODUCT METADATA:
- Product Title: "${title}"
- Brand: "${brand || "Unknown Store"}"
- Price / Currency: "${price || "N/A"}" (${currency || "USD"})
- Product ID: "${productId || "N/A"}"
- Landing Page URL: "${destinationUrl || "N/A"}"

INSTRUCTIONS:
1. Visually inspect the product photo (if attached) and analyze product metadata.
2. Determine 10-15 high-converting, high-intent Google search keywords for buyers actively looking for this exact item.
3. Recommend 1-2 target countries and matching Google Ads Criteria Location IDs (e.g. "2840" for United States, "2752" for Sweden, "2826" for United Kingdom, "2276" for Germany, "2250" for France, "2036" for Australia, "2124" for Canada).
4. Recommend target languages (e.g. "en" for English, "sv" for Swedish, "de" for German).
5. Recommend target age ranges from: "18-24", "25-34", "35-44", "45-54", "55-64", "65+".

Return STRICTLY a JSON object with this exact schema (no markdown, no preamble):
{
  "keywords": ["keyword 1", "keyword 2", "keyword 3"],
  "countries": ["United States", "Sweden"],
  "locationIds": ["2840", "2752"],
  "locationDetails": [ { "id": "2840", "canonicalName": "United States", "targetType": "Country" } ],
  "languages": ["en", "sv"],
  "ageRanges": ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"],
  "genders": ["all"],
  "suggestedHeadlines": ["Headlines 1", "Headlines 2"],
  "suggestedDescriptions": ["Description 1", "Description 2"]
}`,
    parts,
  );
  const locationIds = arr(p.locationIds, 5, 20).length ? arr(p.locationIds, 5, 20) : ["2840"];
  return {
    keywords: arr(p.keywords, 15, 80).length ? arr(p.keywords, 15, 80) : [title, brand, `buy ${title}`, "online store"].filter(Boolean),
    countries: arr(p.countries, 5, 60).length ? arr(p.countries, 5, 60) : ["United States"],
    locationIds,
    locationDetails:
      Array.isArray(p.locationDetails) && p.locationDetails.length
        ? p.locationDetails.slice(0, 5).map((l: any) => ({ id: String(l.id || ""), canonicalName: str(l.canonicalName, 80), targetType: str(l.targetType, 30) || "Country" }))
        : locationIds.map((id) => ({ id, canonicalName: id === "2840" ? "United States" : id, targetType: "Country" })),
    languages: arr(p.languages, 5, 5).length ? arr(p.languages, 5, 5) : ["en"],
    ageRanges: arr(p.ageRanges, 6, 6).length ? arr(p.ageRanges, 6, 6) : ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"],
    genders: arr(p.genders, 3, 10).length ? arr(p.genders, 3, 10) : ["all"],
    suggestedHeadlines: arr(p.suggestedHeadlines, 15, 30),
    suggestedDescriptions: arr(p.suggestedDescriptions, 5, 90),
  };
}
