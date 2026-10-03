// Phase 8 onboarding: normalizeUrl, public draft shape mapper, claim name resolution.
import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/lib/brand-scrape.js";
import { resolveClaimName, toPublicDraft } from "../src/routes/onboarding.js";

describe("normalizeUrl", () => {
  it("keeps a valid https URL, trimming whitespace", () => {
    expect(normalizeUrl("  https://example.com/page  ")).toBe("https://example.com/page");
  });

  it("adds https:// when the scheme is missing", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
  });

  it("rejects empty input", () => {
    expect(() => normalizeUrl("")).toThrow();
    expect(() => normalizeUrl("   ")).toThrow();
  });

  it("rejects hostnames without a dot", () => {
    expect(() => normalizeUrl("localhost")).toThrow();
    expect(() => normalizeUrl("notawebsite")).toThrow();
  });
});

describe("toPublicDraft", () => {
  const base = {
    token: "abc123",
    sourceUrl: "https://example.com/",
    steps: [{ key: "fetch", label: "Fetching your site", status: "done" }],
    error: null,
    claimedAt: null,
  };

  it("hides the result until the draft is ready", () => {
    const shape = toPublicDraft({ ...base, status: "drafting", result: { business: { name: "X" } } });
    expect(shape.status).toBe("drafting");
    expect(shape.result).toBeNull();
    expect(shape.error).toBeNull();
    expect(shape.claimed).toBe(false);
  });

  it("exposes the result once ready", () => {
    const result = { business: { name: "Acme" } };
    const shape = toPublicDraft({ ...base, status: "ready", result });
    expect(shape.status).toBe("ready");
    expect(shape.result).toEqual(result);
  });

  it("marks claimed drafts", () => {
    const shape = toPublicDraft({ ...base, status: "ready", result: {}, claimedAt: new Date() });
    expect(shape.claimed).toBe(true);
  });
});

describe("resolveClaimName", () => {
  const base = {
    sourceUrl: "https://www.example.com/",
    result: { business: { name: "From Draft" } },
    manual: { name: "From Manual" },
    workspaceName: "From Workspace",
    accountName: "From Account",
  };

  it("prefers accountName first", () => {
    expect(resolveClaimName(base)).toBe("From Account");
  });

  it("falls back to workspaceName, then manual.name, then result.business.name", () => {
    expect(resolveClaimName({ ...base, accountName: undefined })).toBe("From Workspace");
    expect(resolveClaimName({ ...base, accountName: undefined, workspaceName: undefined })).toBe("From Manual");
    expect(
      resolveClaimName({ ...base, accountName: undefined, workspaceName: undefined, manual: undefined }),
    ).toBe("From Draft");
  });

  it("falls back to the URL hostname (www stripped)", () => {
    expect(
      resolveClaimName({ sourceUrl: "https://www.example.com/shop", result: null, manual: null }),
    ).toBe("example.com");
  });

  it("returns null when nothing is available", () => {
    expect(resolveClaimName({})).toBeNull();
    expect(resolveClaimName({ sourceUrl: "not a url", result: null })).toBeNull();
  });
});
