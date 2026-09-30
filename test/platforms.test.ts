// Phase 3: platform connection helpers — OAuth state, status computation,
// provider selection, and pure URL-building flows.
import { describe, expect, it, vi } from "vitest";
import {
  computeStatus,
  isIdempotentExchangeError,
  parseState,
  publicConnection,
  signState,
  statusMessage,
} from "../src/lib/connections.js";
import {
  googleAdsVersion,
  isTwitterOAuth2,
  providerFor,
  PROVIDERS,
} from "../src/lib/platform-providers.js";
import { generateOAuth1Header, percentEncode } from "../src/lib/oauth1.js";

const SECRET = "test-secret-key-for-unit-tests-32bytes!";

describe("oauth state", () => {
  it("round-trips a payload", async () => {
    const state = await signState({ p: "google_ads", w: "ws1", u: "u1", t: 123 }, SECRET);
    expect(state).toContain(".");
    const parsed = await parseState(state, SECRET);
    expect(parsed).toMatchObject({ p: "google_ads", w: "ws1", u: "u1", t: 123 });
  });

  it("rejects tampered state and wrong secrets", async () => {
    const state = await signState({ p: "x", w: "ws1" }, SECRET);
    const [body] = state.split(".");
    expect(await parseState(`${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, SECRET)).toBeNull();
    expect(await parseState(state, "wrong-secret")).toBeNull();
    expect(await parseState("garbage", SECRET)).toBeNull();
    expect(await parseState("", SECRET)).toBeNull();
  });
});

describe("computeStatus", () => {
  const base = { accessToken: "tok", refreshToken: "ref", status: "healthy", setupIssues: [] };

  it("returns not_connected without a connection or token", () => {
    expect(computeStatus(null)).toBe("not_connected");
    expect(computeStatus({ ...base, accessToken: null })).toBe("not_connected");
  });

  it("passes through disconnected / error", () => {
    expect(computeStatus({ ...base, status: "disconnected" })).toBe("disconnected");
    expect(computeStatus({ ...base, status: "error" })).toBe("error");
  });

  it("returns expired when a failed refresh was recorded", () => {
    expect(computeStatus({ ...base, status: "expired", lastError: "boom" })).toBe("expired");
  });

  it("flags setup_incomplete on discovery issues", () => {
    for (const code of ["no_ad_account", "no_page", "no_developer_token"]) {
      expect(
        computeStatus({ ...base, setupIssues: [{ code, message: code }] }),
      ).toBe("setup_incomplete");
    }
  });

  it("judges the token clock only when there is no refresh token", () => {
    // Refreshable token, expired access token → still healthy
    expect(
      computeStatus({ ...base, refreshToken: "r", tokenExpiresAt: new Date(Date.now() - 1000) }),
    ).toBe("healthy");
    // No refresh token + expired → expired; within 7 days → expiring
    expect(
      computeStatus({ ...base, refreshToken: null, tokenExpiresAt: new Date(Date.now() - 1000) }),
    ).toBe("expired");
    expect(
      computeStatus({
        ...base,
        refreshToken: null,
        tokenExpiresAt: new Date(Date.now() + 2 * 864e5),
      }),
    ).toBe("expiring");
    expect(
      computeStatus({
        ...base,
        refreshToken: null,
        tokenExpiresAt: new Date(Date.now() + 30 * 864e5),
      }),
    ).toBe("healthy");
  });

  it("statusMessage covers every status", () => {
    for (const s of ["healthy", "expiring", "expired", "setup_incomplete", "error", "disconnected", "not_connected"]) {
      expect(typeof statusMessage(s)).toBe("string");
    }
  });
});

describe("publicConnection", () => {
  it("strips tokens and adds hasToken/status/platformCode", () => {
    const conn = {
      id: "c1",
      accessToken: "secret",
      refreshToken: "secret2",
      status: "healthy",
      setupIssues: [],
      externalAccountName: "Acme",
    };
    const pub = publicConnection(conn, "meta");
    expect(pub).not.toBeNull();
    expect(pub!.accessToken).toBeUndefined();
    expect(pub!.refreshToken).toBeUndefined();
    expect(pub!.hasToken).toBe(true);
    expect(pub!.status).toBe("healthy");
    expect(pub!.platformCode).toBe("meta");
    expect(pub!.externalAccountName).toBe("Acme");
  });

  it("returns null for a missing connection", () => {
    expect(publicConnection(null, "meta")).toBeNull();
  });
});

describe("isIdempotentExchangeError", () => {
  it("matches invalid_grant / already-used codes", () => {
    expect(isIdempotentExchangeError(new Error("invalid_grant: code already used"))).toBe(true);
    expect(isIdempotentExchangeError(new Error("Authorization code already redeemed"))).toBe(true);
    expect(isIdempotentExchangeError(new Error("redirect_uri_mismatch"))).toBe(false);
    expect(isIdempotentExchangeError(null)).toBe(false);
  });
});

describe("provider selection", () => {
  it("maps every seeded code to a provider", () => {
    for (const code of ["google_ads", "meta", "tiktok", "reddit", "pinterest", "bing_ads", "x", "openai_ads"]) {
      expect(providerFor(code), code).not.toBeNull();
    }
    expect(providerFor("twitter")).toBe(PROVIDERS.x);
    expect(providerFor("bing")).toBe(PROVIDERS.bing_ads);
    expect(providerFor("nope")).toBeNull();
  });

  it("marks openai_ads as api-key only", () => {
    expect(PROVIDERS.openai_ads!.apiKey).toBe(true);
    expect(PROVIDERS.meta!.apiKey).toBeFalsy();
  });
});

describe("isTwitterOAuth2", () => {
  it("detects OAuth2 client ids", () => {
    expect(isTwitterOAuth2({ oauthVersion: 2 })).toBe(true);
    expect(isTwitterOAuth2({ oauthVersion: 1 })).toBe(false);
    // clientId containing ":" (clientId:clientSecret form)
    expect(isTwitterOAuth2({ clientId: "abc:def" })).toBe(true);
    // long bearer-style ids
    expect(isTwitterOAuth2({ clientId: "a".repeat(30) })).toBe(true);
    // plain OAuth1 consumer key
    expect(isTwitterOAuth2({ clientId: "shortkey123" })).toBe(false);
    expect(isTwitterOAuth2({})).toBe(false);
  });
});

describe("googleAdsVersion", () => {
  it("floors stale versions below the minimum", () => {
    expect(googleAdsVersion()).toBe("v23");
    expect(googleAdsVersion({ extra: { adsApiVersion: "v17" } })).toBe("v23");
    expect(googleAdsVersion({ apiVersion: "v20" })).toBe("v23");
    expect(googleAdsVersion({ extra: { adsApiVersion: "v23" } })).toBe("v23");
    expect(googleAdsVersion({ extra: { adsApiVersion: "v99" } })).toBe("v99");
  });
});

describe("authUrl builders (no network)", () => {
  it("builds the Google consent URL", async () => {
    const url = await PROVIDERS.google_ads!.authUrl!(
      { clientId: "cid", scopes: ["s1", "s2"] },
      "https://app.example/cb",
      "state123",
    );
    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("state=state123");
  });

  it("builds the Meta dialog URL", async () => {
    const url = await PROVIDERS.meta!.authUrl!(
      { clientId: "cid", scopes: ["a", "b"] },
      "https://app.example/cb",
      "state123",
    );
    expect(url).toContain("facebook.com");
    expect(url).toContain("response_type=code");
  });

  it("builds a deterministic X OAuth2 PKCE URL", async () => {
    const cfg = { clientId: "a".repeat(30), scopes: [] as string[] };
    const env = { SECRET_KEY: SECRET };
    const u1 = await PROVIDERS.x!.authUrl!(cfg, "https://app.example/cb", "st", env);
    const u2 = await PROVIDERS.x!.authUrl!(cfg, "https://app.example/cb", "st", env);
    expect(u1).toBe(u2);
    expect(u1).toContain("code_challenge_method=S256");
    const u3 = await PROVIDERS.x!.authUrl!(cfg, "https://app.example/cb", "other", env);
    expect(u3).not.toBe(u1);
  });
});

describe("oauth1", () => {
  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("generates a well-formed Authorization header", async () => {
    const header = await generateOAuth1Header(
      "POST",
      "https://api.twitter.com/oauth/request_token",
      { consumerKey: "ck", consumerSecret: "cs" },
      { oauth_callback: "https://app.example/cb" },
    );
    expect(header.startsWith("OAuth ")).toBe(true);
    for (const k of ["oauth_consumer_key", "oauth_nonce", "oauth_signature", "oauth_signature_method", "oauth_timestamp", "oauth_version", "oauth_callback"]) {
      expect(header).toContain(k);
    }
  });
});

describe("callback exchange fallback (mocked fetch)", () => {
  // Mirrors the route's try/catch: on exchange failure, an existing token +
  // an invalid_grant/already-redeemed error returns the stored connection.
  const decide = (existing: { accessToken: string } | null, e: unknown): string => {
    try {
      throw e;
    } catch (err) {
      return existing?.accessToken && isIdempotentExchangeError(err) ? "idempotent" : "error";
    }
  };

  it("propagates a fresh exchange failure as 400 without an existing token", async () => {
    const exchange = vi.fn().mockRejectedValue(new Error("invalid_grant: expired"));
    await expect(exchange()).rejects.toThrow("invalid_grant");
    // No existing connection → the error must surface, not be swallowed.
    expect(decide(null, new Error("invalid_grant: expired"))).toBe("error");
  });

  it("returns the existing connection on an already-redeemed code", () => {
    expect(decide({ accessToken: "tok" }, new Error("code already redeemed"))).toBe("idempotent");
    expect(decide({ accessToken: "tok" }, new Error("redirect_uri_mismatch"))).toBe("error");
  });
});
