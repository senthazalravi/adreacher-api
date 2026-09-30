// Phase 5: AI studio — Gemini JSON parsing, fal.ai queue flow, brand scraping,
// and pure prompt builders. fetch is stubbed; no network or keys needed.
import { describe, expect, it, vi, afterEach } from "vitest";
import { generateJson, creativeTitle, IMPROVE_FIELDS } from "../src/lib/ai-text.js";
import { runImageJob, slotPrompt, buildGoogleAdImageFullPrompt, logoInstruction, SLOT_SPECS } from "../src/lib/ai-images.js";
import { buildScrapeContext, normalizeUrl, extractBrand } from "../src/lib/brand-scrape.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// Minimal fake Db: ai_settings lookup returns no rows.
const fakeDb = { select: () => ({ from: () => ({ limit: () => Promise.resolve([]) }) }) } as any;
const env = { GEMINI_API_KEY: "test-key" } as any;

function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function geminiResponse(text: string) {
  return jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });
}

describe("generateJson", () => {
  it("parses a valid JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(geminiResponse('{"a":1}')) as any;
    const out = await generateJson(env, fakeDb, "prompt");
    expect(out).toEqual({ a: 1 });
  });

  it("strips markdown fences", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(geminiResponse('```json\n{"b":2}\n```')) as any;
    expect(await generateJson(env, fakeDb, "prompt")).toEqual({ b: 2 });
  });

  it("falls back to the fallback model when the primary returns malformed JSON", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve(geminiResponse(calls.length === 1 ? "not json" : '{"ok":true}'));
    }) as any;
    const out = await generateJson({ ...env, AI_TEXT_MODEL: "model-a", AI_FALLBACK_MODEL: "model-b" }, fakeDb, "prompt");
    expect(out).toEqual({ ok: true });
    expect(calls[0]).toContain("model-a");
    expect(calls[1]).toContain("model-b");
  });

  it("throws when both models fail", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(geminiResponse("definitely not json")) as any;
    await expect(generateJson(env, fakeDb, "prompt")).rejects.toThrow();
  });

  it("throws 503 AI_UNCONFIGURED without a key", async () => {
    await expect(generateJson({} as any, fakeDb, "prompt")).rejects.toMatchObject({ status: 503, code: "AI_UNCONFIGURED" });
  });
});

describe("creativeTitle", () => {
  it("returns a heuristic title when Gemini fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("nope")) as any;
    const out = await creativeTitle(env, fakeDb, "Summer sale on handmade ceramics. Shop now!");
    expect(out.name.length).toBeGreaterThan(0);
    expect(out.headline.length).toBeLessThanOrEqual(30);
  });

  it("returns the default for empty briefs", async () => {
    expect(await creativeTitle(env, fakeDb, "")).toEqual({ name: "AI Creative", headline: "Discover More" });
  });
});

describe("IMPROVE_FIELDS", () => {
  it("covers the six post fields", () => {
    expect(IMPROVE_FIELDS).toEqual(expect.arrayContaining(["headline", "description", "longHeadline", "content", "name", "callToAction"]));
  });
});

describe("runImageJob (fal queue)", () => {
  it("submits, polls, and returns the image URL", async () => {
    let polls = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/requests/") && url.endsWith("/status")) {
        polls++;
        return Promise.resolve(jsonResponse({ status: polls < 2 ? "IN_PROGRESS" : "COMPLETED" }));
      }
      if (url.includes("/requests/")) return Promise.resolve(jsonResponse({ images: [{ url: "https://fal.media/img.png" }] }));
      return Promise.resolve(jsonResponse({ request_id: "req_123" }));
    }) as any;
    const out = await runImageJob("fal-ai/test-model", { prompt: "x" }, "key", { pollIntervalMs: 1, timeoutMs: 5000 });
    expect(out).toBe("https://fal.media/img.png");
    expect(polls).toBe(2);
  });

  it("throws when the job fails", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/status")) return Promise.resolve(jsonResponse({ status: "FAILED" }));
      return Promise.resolve(jsonResponse({ request_id: "req_1" }));
    }) as any;
    await expect(runImageJob("fal-ai/test-model", {}, "key", { pollIntervalMs: 1 })).rejects.toThrow(/failed/i);
  });
});

describe("prompt builders", () => {
  it("slotPrompt includes slot dims and quality rules", () => {
    const p = slotPrompt("A red bicycle", "portrait", { hasLogo: true });
    expect(p).toContain("A red bicycle");
    expect(p).toContain("4:5");
    expect(p).toContain("960");
    expect(p).toContain("brand logo");
  });

  it("buildGoogleAdImageFullPrompt puts the user prompt first", () => {
    const p = buildGoogleAdImageFullPrompt("Cozy cafe interior", "landscape", {});
    expect(p.startsWith("Cozy cafe interior")).toBe(true);
    expect(p).toContain("1.91:1");
  });

  it("logoInstruction is empty without a logo", () => {
    expect(logoInstruction(false)).toBe("");
    expect(logoInstruction(true)).toContain("bottom-left");
  });

  it("SLOT_SPECS covers the three ad slots", () => {
    expect(Object.keys(SLOT_SPECS).sort()).toEqual(["landscape", "portrait", "square"]);
  });
});

const FIXTURE_HTML = `<!DOCTYPE html><html lang="sv"><head>
<title>Testbolaget AB | Hantverk i Stockholm</title>
<meta name="description" content="Vi säljer hantverk av högsta kvalitet.">
<meta property="og:site_name" content="Testbolaget">
<meta property="og:image" content="/og.jpg">
<meta name="theme-color" content="#123456">
<link rel="icon" href="/icon.png">
<style>:root { --brand-primary: #123456; } body { font-family: "Inter", sans-serif; color: #445566; }</style>
</head><body>
<header><a href="/"><img src="/logo.png" alt="Testbolaget logo" class="logo"></a>
<nav><a href="/produkter">Produkter</a></nav></header>
<h1>Välkommen till Testbolaget</h1>
<h2>Våra produkter</h2>
<button class="cta">Köp nu</button>
<img src="/hero.jpg" alt="Handmade vase" width="800" height="600">
<img src="/thumb.gif" alt="thumb">
<a href="https://instagram.com/testbolaget">IG</a>
<script type="application/ld+json">{"@type":"LocalBusiness","name":"Testbolaget"}</script>
<footer><address>Storgatan 1, Stockholm</address></footer>
<script>var x = 1;</script>
</body></html>`;

describe("normalizeUrl", () => {
  it("adds https and validates", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(() => normalizeUrl("")).toThrow();
    expect(() => normalizeUrl("not a url")).toThrow();
  });
});

describe("buildScrapeContext", () => {
  it("extracts meta, headings, images, logo, colors, json-ld", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(FIXTURE_HTML, { headers: { "Content-Type": "text/html" } })) as any;
    const c = await buildScrapeContext("https://example.com");
    expect(c.meta.title).toContain("Testbolaget");
    expect(c.meta.description).toContain("hantverk");
    expect(c.meta.siteName).toBe("Testbolaget");
    expect(c.meta.lang).toBe("sv");
    expect(c.meta.logo).toBe("https://example.com/logo.png");
    expect(c.headings).toContain("Välkommen till Testbolaget");
    expect(c.ctaButtons).toContain("Köp nu");
    expect(c.socialLinks.instagram).toContain("instagram.com");
    expect(c.imageCandidates.map((i) => i.src)).toContain("https://example.com/hero.jpg");
    expect(c.imageCandidates.map((i) => i.src)).not.toContain("https://example.com/thumb.gif");
    expect(c.jsonLdData[0]["@type"]).toBe("LocalBusiness");
    expect(c.cssColors).toContain("#445566");
    expect(c.cssFonts).toContain("Inter");
    expect(c.footerText).toContain("Storgatan 1");
    expect(c.bodyText).not.toContain("var x = 1");
  });

  it("throws on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 404 })) as any;
    await expect(buildScrapeContext("https://example.com")).rejects.toThrow(/404/);
  });
});

describe("extractBrand", () => {
  it("falls back to heuristic without a key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(FIXTURE_HTML, { headers: { "Content-Type": "text/html" } })) as any;
    const c = await buildScrapeContext("https://example.com");
    const out = await extractBrand({} as any, fakeDb, c);
    expect(out._source).toBe("heuristic");
    expect(out.business.name).toContain("Testbolaget");
    expect(out.branding.logoUrl).toBe("https://example.com/logo.png");
  });

  it("normalizes Gemini output", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage")) {
        return Promise.resolve(
          geminiResponse(JSON.stringify({ business: { name: "Testbolaget AB" }, branding: {}, keywords: ["a", "b"], suggestedCampaigns: [{ name: "X", objective: "bogus" }] })),
        );
      }
      return Promise.resolve(new Response(FIXTURE_HTML, { headers: { "Content-Type": "text/html" } }));
    }) as any;
    const c = await buildScrapeContext("https://example.com");
    const out = await extractBrand(env, fakeDb, c);
    expect(out._source).toBe("gemini");
    expect(out.business.name).toBe("Testbolaget AB");
    // invalid objective falls back to website_visitors
    expect(out.suggestedCampaigns[0].objective).toBe("website_visitors");
  });
});
