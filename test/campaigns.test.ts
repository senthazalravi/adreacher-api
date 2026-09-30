// Phase 4 tests: campaign publisher pure functions, import mapping,
// auto-optimize scoring, audience merging, landing-page sanitization.
import { describe, expect, it } from "vitest";
import {
  campaignTypeOf,
  deriveStatus,
  isPastEndDate,
  PUBLISHED_FIELDS,
  sameStoredValue,
} from "../src/lib/campaign-publisher.js";
import { mapGoogleStatus } from "../src/lib/campaign-import.js";
import { computeScore } from "../src/lib/auto-optimize.js";
import { mergeByPlace, placeKey } from "../src/lib/audience-resolvers.js";
import { sanitizeText } from "../src/lib/landing-pages.js";

describe("isPastEndDate", () => {
  it("returns false for null/undefined", () => {
    expect(isPastEndDate(null)).toBe(false);
    expect(isPastEndDate(undefined)).toBe(false);
  });
  it("returns false for future dates", () => {
    expect(isPastEndDate("2099-12-31")).toBe(false);
  });
  it("returns true for past dates", () => {
    expect(isPastEndDate("2020-01-01")).toBe(true);
  });
  it("treats YYYY-MM-DD as end of day", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(isPastEndDate(today)).toBe(false);
  });
});

describe("deriveStatus", () => {
  it("returns draft when no platforms", () => {
    expect(deriveStatus([])).toBe("draft");
  });
  it("returns draft when all pending", () => {
    expect(deriveStatus([{ status: "pending" }, { status: "pending" }])).toBe("draft");
  });
  it("returns active when all live", () => {
    expect(deriveStatus([{ status: "live" }, { status: "live" }])).toBe("active");
  });
  it("returns partial when live + failed", () => {
    expect(deriveStatus([{ status: "live" }, { status: "failed" }])).toBe("partial");
  });
  it("returns paused when all paused", () => {
    expect(deriveStatus([{ status: "paused" }])).toBe("paused");
  });
  it("returns completed when all completed", () => {
    expect(deriveStatus([{ status: "completed" }])).toBe("completed");
  });
  it("returns completed when campaign end date passed", () => {
    expect(deriveStatus([{ status: "live" }], { endDate: "2020-01-01", status: "active" })).toBe("completed");
  });
  it("returns failed when any failed and none live", () => {
    expect(deriveStatus([{ status: "failed" }])).toBe("failed");
  });
});

describe("campaignTypeOf", () => {
  it("returns null when no platforms", () => {
    expect(campaignTypeOf({ platforms: [] })).toBeNull();
  });
  it("returns social when platforms but no google type", () => {
    expect(campaignTypeOf({ platforms: [{ platform: { code: "meta" } }] })).toBe("social");
  });
  it("maps PERFORMANCE_MAX", () => {
    expect(
      campaignTypeOf({ platforms: [{ platform: { code: "google_ads" }, campaignType: "PERFORMANCE_MAX" }] })
    ).toBe("performance_max");
  });
  it("maps SEARCH", () => {
    expect(
      campaignTypeOf({ platforms: [{ platform: { code: "google_ads" }, campaignType: "SEARCH" }] })
    ).toBe("search");
  });
});

describe("sameStoredValue", () => {
  it("treats null/undefined as equal", () => {
    expect(sameStoredValue(null, undefined)).toBe(true);
    expect(sameStoredValue(null, null)).toBe(true);
  });
  it("treats numeric strings and numbers as equal", () => {
    expect(sameStoredValue("777", 777)).toBe(true);
    expect(sameStoredValue("777", 778)).toBe(false);
  });
  it("normalizes dates", () => {
    expect(sameStoredValue("2026-09-30T00:00:00.000Z", "2026-09-30")).toBe(true);
  });
});

describe("PUBLISHED_FIELDS", () => {
  it("contains the expected fields", () => {
    expect(PUBLISHED_FIELDS).toContain("name");
    expect(PUBLISHED_FIELDS).toContain("budgetAmount");
    expect(PUBLISHED_FIELDS).toContain("landingPageUrl");
  });
});

describe("mapGoogleStatus", () => {
  it("maps primary status ELIGIBLE to active", () => {
    expect(mapGoogleStatus("ELIGIBLE", "ENABLED")).toBe("active");
  });
  it("maps primary status PAUSED to paused", () => {
    expect(mapGoogleStatus("PAUSED", "PAUSED")).toBe("paused");
  });
  it("maps primary status ENDED to completed", () => {
    expect(mapGoogleStatus("ENDED", "ENABLED")).toBe("completed");
  });
  it("falls back to raw status when no primary", () => {
    expect(mapGoogleStatus(null, "ENABLED")).toBe("active");
    expect(mapGoogleStatus(null, "PAUSED")).toBe("paused");
  });
  it("returns draft for unknown", () => {
    expect(mapGoogleStatus("UNKNOWN", "UNKNOWN")).toBe("draft");
  });
});

describe("computeScore", () => {
  it("weights CTR heavily", () => {
    const high = computeScore({ ctr: 5, impressions: 1000 });
    const low = computeScore({ ctr: 1, impressions: 1000 });
    expect(high).toBeGreaterThan(low);
  });
  it("gives logarithmic impressions bonus", () => {
    const few = computeScore({ ctr: 2, impressions: 12 });
    const many = computeScore({ ctr: 2, impressions: 40000 });
    // Many impressions wins, but not by 3333x — the log compresses it
    expect(many).toBeGreaterThan(few);
    expect(many / few).toBeLessThan(10);
  });
});

describe("placeKey", () => {
  it("normalizes name and country", () => {
    expect(placeKey("Stockholm", "SE")).toBe("se::stockholm");
    expect(placeKey("  Stockholm  ", "se")).toBe("se::stockholm");
  });
});

describe("mergeByPlace", () => {
  it("merges same place from multiple platforms", () => {
    const perPlatform = {
      google: [{ id: "1", name: "Stockholm", countryCode: "SE", type: "city" }],
      meta: [{ id: "2", name: "Stockholm", countryCode: "SE", type: "city" }],
    };
    const merged = mergeByPlace(perPlatform);
    expect(merged).toHaveLength(1);
    expect(merged[0].resolved.google.id).toBe("1");
    expect(merged[0].resolved.meta.id).toBe("2");
  });
  it("marks missing platforms as null", () => {
    const perPlatform = {
      google: [{ id: "1", name: "Stockholm", countryCode: "SE", type: "city" }],
      meta: [],
    };
    const merged = mergeByPlace(perPlatform);
    expect(merged[0].resolved.meta).toBeNull();
  });
  it("tracks unavailable platforms separately", () => {
    const perPlatform = {
      google: [{ id: "1", name: "Stockholm", countryCode: "SE", type: "city" }],
      meta: [],
    };
    const merged = mergeByPlace(perPlatform, ["meta"]);
    expect(merged[0].unavailable).toContain("meta");
  });
});

describe("sanitizeText", () => {
  it("strips HTML tags", () => {
    expect(sanitizeText("<b>Hello</b>")).toBe("Hello");
  });
  it("strips javascript: URLs", () => {
    expect(sanitizeText("javascript:alert(1)")).not.toContain("javascript:");
  });
  it("truncates to maxLength", () => {
    expect(sanitizeText("a".repeat(3000), 100)).toHaveLength(100);
  });
  it("returns empty for non-strings", () => {
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(123)).toBe("");
  });
});
