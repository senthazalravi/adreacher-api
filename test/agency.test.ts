// Phase 8: agency route unit tests — pure helpers and guard logic.
// No D1 and no network: the guard is exercised through resolveAgencyContext
// with a minimal fake db exposing db.query.tenants.findFirst.
import { describe, expect, it } from "vitest";
import {
  assertOwner,
  buildInviteUrl,
  escapeLike,
  isValidEmail,
  mergeFeatures,
  parsePaging,
  resolveAgencyContext,
  summarizeHealth,
  summarizeRaw,
  type RawHealth,
} from "../src/routes/agency.js";
import { HttpError } from "../src/lib/filter.js";
import type { Db } from "../src/db/index.js";
import type { Session } from "../src/lib/auth.js";

function fakeDb(tenantRow: unknown): Db {
  return {
    query: { tenants: { findFirst: async () => tenantRow } },
  } as unknown as Db;
}

function fakeCtx(params: Record<string, string>) {
  return {
    req: { query: (k: string) => params[k] },
  } as unknown as Parameters<typeof parsePaging>[0];
}

const agencyTenant = { id: "t-agency", name: "Acme Agency", type: "agency", status: "active" };
const clientTenant = { id: "t-client", name: "Client Co", type: "client", status: "active" };

const ownerSession: Session = {
  userId: "u-owner",
  tenantId: "t-agency",
  email: "owner@agency.se",
  platformAdmin: false,
  isAccountOwner: true,
};
const staffSession: Session = { ...ownerSession, userId: "u-staff", isAccountOwner: false };
const adminOnClient: Session = {
  userId: "u-admin",
  tenantId: "t-client",
  email: "admin@platform.se",
  platformAdmin: true,
  isAccountOwner: false,
};

// --- email validation -------------------------------------------------------

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    expect(isValidEmail("anna@example.se")).toBe(true);
    expect(isValidEmail("a.b+tag@sub.domain.com")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("@b.se")).toBe(false);
    expect(isValidEmail("a b@c.se")).toBe(false);
    expect(isValidEmail("a@b .se")).toBe(false);
  });
});

// --- invite URL -------------------------------------------------------------

describe("buildInviteUrl", () => {
  it("builds the accept-invite link from APP_URL", () => {
    expect(buildInviteUrl({ APP_URL: "https://app.example.com" }, "tok123")).toBe(
      "https://app.example.com/accept-invite?token=tok123",
    );
  });
  it("trims a trailing slash on APP_URL", () => {
    expect(buildInviteUrl({ APP_URL: "https://app.example.com/" }, "tok123")).toBe(
      "https://app.example.com/accept-invite?token=tok123",
    );
  });
  it("falls back to a root-relative link without APP_URL", () => {
    expect(buildInviteUrl({}, "tok123")).toBe("/accept-invite?token=tok123");
  });
});

// --- LIKE escaping ----------------------------------------------------------

describe("escapeLike", () => {
  it("escapes %, _ and backslash", () => {
    expect(escapeLike("100%_x\\y")).toBe("100\\%\\_x\\\\y");
  });
  it("leaves plain text alone", () => {
    expect(escapeLike("Acme AB")).toBe("Acme AB");
  });
});

// --- feature merge ----------------------------------------------------------

describe("mergeFeatures", () => {
  it("merges new flags over the stored ones", () => {
    expect(mergeFeatures({ a: true, b: false }, { b: true, c: false })).toEqual({
      a: true,
      b: true,
      c: false,
    });
  });
  it("starts from empty when nothing stored", () => {
    expect(mergeFeatures(null, { x: true })).toEqual({ x: true });
    expect(mergeFeatures(undefined, {})).toEqual({});
  });
  it("rejects non-object patches", () => {
    for (const bad of [null, 42, "x", [true]]) {
      const err = (() => {
        try {
          mergeFeatures({}, bad);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });
  it("rejects non-boolean values", () => {
    const err = (() => {
      try {
        mergeFeatures({}, { a: "yes" });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  });
});

// --- pagination -------------------------------------------------------------

describe("parsePaging", () => {
  it("defaults to page 1, limit 20", () => {
    expect(parsePaging(fakeCtx({}))).toEqual({ page: 1, limit: 20, offset: 0 });
  });
  it("computes the offset", () => {
    expect(parsePaging(fakeCtx({ page: "3", limit: "5" }))).toEqual({ page: 3, limit: 5, offset: 10 });
  });
  it("clamps to sane bounds", () => {
    expect(parsePaging(fakeCtx({ page: "-2", limit: "9999" }))).toEqual({
      page: 1,
      limit: 100,
      offset: 0,
    });
  });
});

// --- health math ------------------------------------------------------------

const EMPTY = { live: 0, analytics: [], failures: [], connectionIssues: [] };

describe("summarizeHealth", () => {
  it("reports no_activity when there is nothing", () => {
    expect(summarizeHealth(EMPTY)).toEqual({
      live: 0,
      spend7d: 0,
      impressions7d: 0,
      ctr7d: 0,
      attention: [],
      health: "no_activity",
    });
  });
  it("sums spend/impressions and computes CTR", () => {
    const s = summarizeHealth({
      live: 2,
      analytics: [
        { spend: 10.555, impressions: 1000, clicks: 25 },
        { spend: 5, impressions: 500, clicks: 5 },
      ],
      failures: [],
      connectionIssues: [],
    });
    expect(s.spend7d).toBe(15.56);
    expect(s.impressions7d).toBe(1500);
    expect(s.ctr7d).toBe(2);
    expect(s.health).toBe("healthy");
  });
  it("yields ctr 0 with no impressions", () => {
    const s = summarizeHealth({ ...EMPTY, analytics: [{ spend: 3, impressions: 0, clicks: 0 }] });
    expect(s.ctr7d).toBe(0);
  });
  it("flags connection issues as attention", () => {
    const s = summarizeHealth({
      ...EMPTY,
      live: 1,
      connectionIssues: [
        { workspaceId: "w1", platformId: "google_ads", platform: "Google Ads", accountName: "Acme", status: "expired" },
      ],
    });
    expect(s.health).toBe("attention");
    expect(s.attention).toHaveLength(1);
    expect(s.attention[0]?.type).toBe("connection_issue");
  });
  it("lets platform failures win over connection issues", () => {
    const s = summarizeHealth({
      ...EMPTY,
      live: 1,
      failures: [
        {
          workspaceId: "w1",
          campaignId: "c1",
          campaignName: "Spring",
          platformId: "meta",
          platform: "Meta",
          status: "failed",
          message: "budget exhausted",
        },
      ],
      connectionIssues: [
        { workspaceId: "w1", platformId: "x", platform: "X", accountName: null, status: "expiring" },
      ],
    });
    expect(s.health).toBe("failing");
    expect(s.attention[0]?.type).toBe("platform_failure");
  });
  it("caps attention items at 10", () => {
    const failures = Array.from({ length: 12 }, (_, i) => ({
      workspaceId: "w1",
      campaignId: `c${i}`,
      campaignName: null,
      platformId: null,
      platform: null,
      status: "failed",
      message: null,
    }));
    const s = summarizeHealth({ ...EMPTY, failures });
    expect(s.attention).toHaveLength(10);
    expect(s.health).toBe("failing");
  });
});

describe("summarizeRaw", () => {
  const raw: RawHealth = {
    liveByWs: { w1: 2, w2: 1 },
    analytics: [
      { workspaceId: "w1", spend: 10, impressions: 100, clicks: 5 },
      { workspaceId: "w2", spend: 20, impressions: 200, clicks: 10 },
    ],
    failures: [
      { workspaceId: "w2", campaignId: "c9", campaignName: "X", platformId: null, platform: null, status: "rejected", message: "policy" },
    ],
    connectionIssues: [
      { workspaceId: "w1", platformId: "google_ads", platform: "Google Ads", accountName: "A", status: "expiring" },
    ],
  };
  it("rolls up everything without a scope", () => {
    const s = summarizeRaw(raw);
    expect(s.live).toBe(3);
    expect(s.spend7d).toBe(30);
    expect(s.health).toBe("failing");
  });
  it("scopes to the requested workspaces", () => {
    const s = summarizeRaw(raw, ["w1"]);
    expect(s.live).toBe(2);
    expect(s.spend7d).toBe(10);
    expect(s.impressions7d).toBe(100);
    expect(s.health).toBe("attention");
    expect(s.attention).toHaveLength(1);
  });
  it("returns no_activity for an empty scope", () => {
    const s = summarizeRaw(raw, []);
    expect(s).toMatchObject({ live: 0, spend7d: 0, health: "no_activity" });
  });
});

// --- guards -----------------------------------------------------------------

describe("resolveAgencyContext", () => {
  it("passes for an agency owner", async () => {
    const ctx = await resolveAgencyContext(fakeDb(agencyTenant), ownerSession);
    expect(ctx.tenant.id).toBe("t-agency");
    expect(ctx.isOwner).toBe(true);
  });
  it("passes for agency staff without owner rights", async () => {
    const ctx = await resolveAgencyContext(fakeDb(agencyTenant), staffSession);
    expect(ctx.isOwner).toBe(false);
  });
  it("lets a platform admin through on any tenant", async () => {
    const ctx = await resolveAgencyContext(fakeDb(clientTenant), adminOnClient);
    expect(ctx.isOwner).toBe(true);
  });
  it("rejects non-admin sessions on client tenants", async () => {
    const err = await resolveAgencyContext(fakeDb(clientTenant), staffSession).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("AGENCY_REQUIRED");
  });
  it("rejects unknown tenants", async () => {
    const err = await resolveAgencyContext(fakeDb(null), ownerSession).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("NO_TENANT");
  });
  it("requires a session", async () => {
    const err = await resolveAgencyContext(fakeDb(agencyTenant), undefined).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
  });
});

describe("assertOwner", () => {
  it("passes for owners", () => {
    expect(() => assertOwner(ownerSession, true)).not.toThrow();
  });
  it("throws 403 for non-owners", () => {
    const err = (() => {
      try {
        assertOwner(staffSession, false);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).code).toBe("AGENCY_OWNER_REQUIRED");
  });
});
