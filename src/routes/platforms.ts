// Ad-platform connections: list platforms with per-workspace status, OAuth
// connect/callback, disconnect, ad-account selection. Port of the old
// baasix-endpoint-platforms extension (same method+path for every route).
//
//   GET    /platforms?workspaceId=                      platforms + connection status
//   GET    /platform-configs                           budget rules / objectives (any signed-in user)
//   GET    /platform-connections?workspaceId=          workspace connections
//   GET    /platform-connections/:id
//   POST   /platform-connections                       create a connection row directly
//   GET    /platforms/:code/auth-url?workspaceId=      → { authUrl, redirectUri }
//   GET|POST /platforms/:code/callback                 OAuth callback → connection
//   DELETE /platforms/:code/disconnect?workspaceId=
//   PATCH  /platforms/:code/ads-account-id             { workspaceId, adsAccountId }
//   GET    /platforms/:code/setup-options?workspaceId=
//   POST   /platforms/:code/refresh-accounts           { workspaceId }
//   PATCH  /platforms/:code/connection-setup           { workspaceId, adAccountId?, pageId? }
//   POST   /platforms/:code/api-key                    { workspaceId, apiKey }
//   PATCH  /platform-configs/:platformCode
import { Hono, type Context } from "hono";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import {
  adPlatforms,
  oauthRequestTokens,
  platformConfigs,
  platformConnections,
  workspaces,
} from "../db/schema/index.js";
import { allowedWorkspaceIds, sessionOf } from "../lib/auth.js";
import { decryptRowSecrets, encryptRowSecrets } from "../lib/secrets.js";
import { HttpError } from "../lib/filter.js";
import {
  computeStatus,
  getConnectionConfig,
  getValidAccessToken,
  isIdempotentExchangeError,
  parseState,
  publicConnection,
  signState,
  type ResolvedConfig,
} from "../lib/connections.js";
import {
  googleAdsVersion,
  isTwitterOAuth2,
  providerFor,
  xRequestToken,
} from "../lib/platform-providers.js";
import type { Env } from "../index.js";

type AppContext = Context<{ Bindings: Env }>;

// The frontend still uses reach_be's config slugs, which differ from our platform codes.
const LEGACY_SLUGS: Record<string, string> = { google_ads: "google" };

const normCode = (code: string): string =>
  code === "twitter" ? "x" : code === "google" ? "google_ads" : code;

function secretKey(c: AppContext): string {
  const k = c.env.SECRET_KEY;
  if (!k) throw new HttpError(500, "SECRET_KEY is not configured", "SECRETS_UNCONFIGURED");
  return k;
}

interface WsContext {
  uid: string;
  ws: Record<string, any>;
}

/** Session + workspace access check (mirrors the old ctx()). */
async function wsContext(c: AppContext, workspaceId?: string | null): Promise<WsContext> {
  const session = sessionOf(c);
  const uid = session.userId;
  if (!uid) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  let body: Record<string, any> = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  } catch {
    /* GET requests have no body */
  }
  const targetWsId =
    workspaceId ||
    c.req.query("workspaceId") ||
    (body as Record<string, any>).workspaceId ||
    c.req.header("x-workspace-id") ||
    c.req.header("x-workspace");
  if (!targetWsId) throw new HttpError(400, "workspaceId required", "WORKSPACE_REQUIRED");

  const allowed = await allowedWorkspaceIds(getDb(c.env.DB), session);
  if (allowed !== null && !allowed.includes(targetWsId)) {
    throw new HttpError(403, "You do not have access to this workspace", "WORKSPACE_FORBIDDEN");
  }
  const rows = await getDb(c.env.DB)
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, targetWsId),
        eq(workspaces.account_id, session.tenantId),
        isNull(workspaces.deletedAt),
      ),
    );
  const ws = rows[0] as unknown as Record<string, any> | undefined;
  if (!ws) throw new HttpError(404, "Workspace not found", "WORKSPACE_NOT_FOUND");
  return { uid, ws };
}

async function platformByCode(db: Db, code: string): Promise<Record<string, any>> {
  const normalized = normCode(code);
  const rows = await db
    .select()
    .from(adPlatforms)
    .where(eq(adPlatforms.code, normalized));
  const p = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  // Also accept the raw code (e.g. legacy "twitter"/"google") before 404ing.
  if (!p && normalized !== code) {
    const rows2 = await db.select().from(adPlatforms).where(eq(adPlatforms.code, code));
    const p2 = (rows2[0] as unknown as Record<string, any> | undefined) ?? null;
    if (p2) {
      if (!p2.isEnabled) throw new HttpError(404, "Platform is not enabled", "PLATFORM_NOT_FOUND");
      return p2;
    }
  }
  if (!p) throw new HttpError(404, "Platform not found", "PLATFORM_NOT_FOUND");
  if (!p.isEnabled) throw new HttpError(404, "Platform is not enabled", "PLATFORM_NOT_FOUND");
  return p;
}

/** Decrypted workspace connection row, or null. */
async function connectionFor(
  db: Db,
  key: string,
  workspaceId: string,
  platformId: string,
): Promise<Record<string, any> | null> {
  const rows = await db
    .select()
    .from(platformConnections)
    .where(
      and(
        eq(platformConnections.workspace_id, workspaceId),
        eq(platformConnections.platform_id, platformId),
        isNull(platformConnections.deletedAt),
      ),
    );
  const row = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!row) return null;
  return (await decryptRowSecrets("platform_connections", row, key)) as Record<string, any>;
}

function redirectBase(c: AppContext): string {
  const q = c.req.query("redirectBase");
  if (q) return q.replace(/\/+$/, "");
  const origin = c.req.header("origin");
  if (origin) return origin.replace(/\/+$/, "");
  const referer = c.req.header("referer");
  if (referer) {
    try {
      return new URL(referer).origin.replace(/\/+$/, "");
    } catch {
      /* ignore */
    }
  }
  const xfHost = c.req.header("x-forwarded-host");
  if (xfHost) {
    const proto = c.req.header("x-forwarded-proto") || "https";
    return `${proto}://${xfHost}`.replace(/\/+$/, "");
  }
  return (c.env.APP_URL || "").replace(/\/+$/, "");
}

function redirectUriFor(c: AppContext, platformCode: string): string {
  const q = c.req.query("redirectUri");
  if (q) return q;
  const code = (platformCode || "").toLowerCase();
  const base = redirectBase(c);
  if (code === "x" || code === "twitter") {
    if (c.env.ADS_X_REDIRECT_URI) return c.env.ADS_X_REDIRECT_URI;
    if (/localhost|127\.0\.0\.1/i.test(base)) return "http://localhost:3001/auth/x/callback";
    return `${base}/auth/x/callback`;
  }
  if ((code === "bing" || code === "bing_ads") && c.env.ADS_BING_REDIRECT_URI) {
    return c.env.ADS_BING_REDIRECT_URI;
  }
  return `${base}/dashboard/platforms/callback`;
}

interface SaveConnectionArgs {
  ws: Record<string, any>;
  platform: Record<string, any>;
  tokens: {
    accessToken: string;
    refreshToken?: string | null;
    expiresIn?: number | null;
    scopes?: string[];
    meta?: Record<string, any>;
  };
  account: {
    externalAccountId: string;
    externalAccountName: string;
    currency?: string;
    meta: Record<string, any>;
    issues: Array<{ code: string; message: string }>;
  };
  uid: string;
}

/** Insert or update the workspace connection row (tokens encrypted). */
async function saveConnection(
  db: Db,
  key: string,
  args: SaveConnectionArgs,
): Promise<Record<string, any>> {
  const { ws, platform, tokens, account, uid } = args;
  const existing = await connectionFor(db, key, ws.id, platform.id);

  const data: Record<string, any> = {
    workspace_id: ws.id,
    platform_id: platform.id,
    account_id: ws.account_id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || existing?.refreshToken || null,
    tokenExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
    scopes: tokens.scopes || [],
    externalAccountId: account.externalAccountId,
    externalAccountName: account.externalAccountName,
    currency: account.currency || existing?.currency || ws.currency,
    setupIssues: account.issues || [],
    lastSyncedAt: new Date(),
    lastError: null,
    meta: {
      ...(existing?.meta || {}),
      ...(tokens.meta || {}),
      ...(account.meta || {}),
      connectedBy: uid,
      connectedAt: new Date().toISOString(),
    },
  };
  data.status = computeStatus({ ...data });
  const enc = (await encryptRowSecrets("platform_connections", data, key)) as Record<string, any>;

  let id: string;
  if (existing) {
    await db
      .update(platformConnections)
      .set({ ...enc, updatedAt: new Date() })
      .where(eq(platformConnections.id, existing.id));
    id = existing.id;
  } else {
    const rows = await db.insert(platformConnections).values(enc as typeof platformConnections.$inferInsert).returning({ id: platformConnections.id });
    id = (rows[0] as unknown as { id: string }).id;
  }

  if (ws.onboardingState === "brand_ready" || ws.onboardingState === "pending") {
    await db
      .update(workspaces)
      .set({ onboardingState: "platform_connected", updatedAt: new Date() })
      .where(eq(workspaces.id, ws.id));
  }

  // TODO Phase 4: fire importGoogleCampaigns for google_ads (as the old backend did).
  // TODO Phase 7: notify(uid, platform.connected …) via the notifications system.

  return { ...data, id };
}

const platforms = new Hono<{ Bindings: Env }>();

/* GET /platforms?workspaceId= — platforms + per-workspace connection status */
platforms.get("/platforms", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const { ws } = await wsContext(c);

  const plats = await db
    .select()
    .from(adPlatforms)
    .where(eq(adPlatforms.isEnabled, true))
    .orderBy(asc(adPlatforms.sortOrder))
    .limit(50);
  const connRows = await db
    .select()
    .from(platformConnections)
    .where(
      and(
        eq(platformConnections.workspace_id, ws.id),
        isNull(platformConnections.deletedAt),
      ),
    )
    .limit(50);
  const cfgRows = await db
    .select({ platform_id: platformConfigs.platform_id, isConfigured: platformConfigs.isConfigured })
    .from(platformConfigs)
    .limit(50);

  const data = await Promise.all(
    (plats as unknown as Record<string, any>[]).map(async (p) => {
      const raw = (connRows as unknown as Record<string, any>[]).find(
        (x) => x.platform_id === p.id,
      );
      const conn = raw ? ((await decryptRowSecrets("platform_connections", raw, key)) as Record<string, any>) : null;
      const cfg = (cfgRows as unknown as Record<string, any>[]).find((x) => x.platform_id === p.id);
      const provider = providerFor(p.code);
      return {
        id: p.id,
        code: p.code,
        slug: p.code,
        name: p.name,
        kind: p.kind,
        platformType: p.kind,
        unlocksCopy: p.unlocksCopy,
        description: p.unlocksCopy,
        isEnabled: p.isEnabled,
        displayOrder: p.sortOrder,
        currencyUnit: p.currencyUnit,
        connectMode: !provider ? "unavailable" : provider.apiKey ? "api_key" : "oauth",
        isConfigured: Boolean(cfg?.isConfigured) || Boolean(provider?.apiKey),
        status: computeStatus(conn),
        connection: publicConnection(conn, p.code),
      };
    }),
  );
  return c.json({
    data,
    summary: {
      healthy: data.filter((d) => d.status === "healthy").length,
      attention: data.filter((d) =>
        ["expiring", "expired", "setup_incomplete", "error"].includes(d.status),
      ).length,
      notConnected: data.filter((d) => d.status === "not_connected").length,
      lastSyncedAt:
        (connRows as unknown as Record<string, any>[])
          .map((r) => r.lastSyncedAt)
          .filter(Boolean)
          .sort()
          .pop() || null,
    },
  });
});

/* GET /platform-configs — budget rules & objectives per platform (any signed-in user). */
platforms.get("/platform-configs", async (c) => {
  const db = getDb(c.env.DB);
  const plats = await db
    .select()
    .from(adPlatforms)
    .where(eq(adPlatforms.isEnabled, true))
    .orderBy(asc(adPlatforms.sortOrder))
    .limit(50);
  const data = (plats as unknown as Record<string, any>[]).map((p) => {
    const b = p.budgetMinimums || {};
    return {
      slug: LEGACY_SLUGS[p.code] || p.code,
      code: p.code,
      apiVersion: p.code === "google_ads" ? googleAdsVersion() : null,
      currencyUnit: p.currencyUnit,
      currencyMultiplier: b.multiplier || (p.currencyUnit === "micros" ? 1_000_000 : 100),
      supportsLifetimeBudget: b.supportsLifetimeBudget !== false,
      minimums: {
        campaign: b.campaign ?? null,
        adGroup: b.adGroup ?? null,
        daily: b.daily ?? null,
        bid: b.bid ?? null,
      },
      recommendations: { daily: b.recommendedDaily ?? null },
      objectives: Object.keys(p.supportedObjectives || {}),
    };
  });
  return c.json({ data });
});

/* GET /platform-connections?workspaceId= */
platforms.get("/platform-connections", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const { ws } = await wsContext(c);
  const rows = await db
    .select()
    .from(platformConnections)
    .where(
      and(
        eq(platformConnections.workspace_id, ws.id),
        isNull(platformConnections.deletedAt),
      ),
    );
  const plats = await db.select({ id: adPlatforms.id, code: adPlatforms.code }).from(adPlatforms);
  const codeOf = (id: string | null) =>
    (plats as unknown as Array<{ id: string; code: string }>).find((p) => p.id === id)?.code || "unknown";
  const data = await Promise.all(
    (rows as unknown as Record<string, any>[]).map(async (r) => {
      const dec = (await decryptRowSecrets("platform_connections", r, key)) as Record<string, any>;
      return publicConnection(dec, codeOf(r.platform_id));
    }),
  );
  return c.json({ data });
});

/* GET /platform-connections/:id */
platforms.get("/platform-connections/:id", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const session = sessionOf(c);
  if (!session?.userId) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  const rows = await db
    .select()
    .from(platformConnections)
    .where(
      and(
        eq(platformConnections.id, c.req.param("id")),
        eq(platformConnections.account_id, session.tenantId),
        isNull(platformConnections.deletedAt),
      ),
    );
  const row = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  if (!row) throw new HttpError(404, "Connection not found", "CONNECTION_NOT_FOUND");
  const dec = (await decryptRowSecrets("platform_connections", row, key)) as Record<string, any>;
  const plats = await db.select({ id: adPlatforms.id, code: adPlatforms.code }).from(adPlatforms);
  const code =
    (plats as unknown as Array<{ id: string; code: string }>).find((p) => p.id === dec.platform_id)?.code ||
    "unknown";
  return c.json({ data: publicConnection(dec, code) });
});

/* POST /platform-connections — create a connection row directly (admin tooling). */
platforms.post("/platform-connections", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws } = await wsContext(c, body.workspaceId);
  const platformCode = body.platformCode || body.code;
  if (!platformCode) throw new HttpError(400, "platformCode required", "PLATFORM_REQUIRED");
  const platform = await platformByCode(db, platformCode);
  const accessToken = String(body.accessToken || "").trim();
  if (!accessToken) throw new HttpError(400, "accessToken required", "TOKEN_REQUIRED");

  const data: Record<string, any> = {
    workspace_id: ws.id,
    platform_id: platform.id,
    account_id: ws.account_id,
    accessToken,
    refreshToken: body.refreshToken || null,
    tokenExpiresAt: body.tokenExpiresAt ? new Date(body.tokenExpiresAt) : null,
    scopes: body.scopes || [],
    externalAccountId: body.externalAccountId || null,
    externalAccountName: body.externalAccountName || null,
    currency: body.currency || null,
    setupIssues: body.setupIssues || [],
    lastSyncedAt: body.lastSyncedAt ? new Date(body.lastSyncedAt) : null,
    lastError: body.lastError || null,
    meta: body.meta || {},
    status: "healthy",
  };
  data.status = computeStatus({ ...data });
  const enc = (await encryptRowSecrets("platform_connections", data, key)) as Record<string, any>;
  const rows = await db.insert(platformConnections).values(enc as typeof platformConnections.$inferInsert).returning({ id: platformConnections.id });
  const id = (rows[0] as unknown as { id: string }).id;
  return c.json({ data: publicConnection({ ...data, id }, platform.code) }, 201);
});

/* GET /platforms/:code/auth-url?workspaceId= */
platforms.get("/platforms/:code/auth-url", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const { ws, uid } = await wsContext(c);
  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const resolved: ResolvedConfig = await getConnectionConfig(
    db,
    c.env as unknown as Record<string, string | undefined>,
    key,
    ws.id,
    platform.code,
  );
  const provider = resolved.provider;
  if (!provider) throw new HttpError(501, `${platform.name} connection is not available yet`, "PROVIDER_UNAVAILABLE");
  if (provider.apiKey)
    throw new HttpError(400, `${platform.name} uses an API key — paste it on the Connections page`, "API_KEY_PLATFORM");
  if (!resolved.clientId || !resolved.clientSecret)
    throw new HttpError(503, `${platform.name} OAuth credentials are not configured`, "OAUTH_UNCONFIGURED");

  const state = await signState(
    {
      p: platform.code,
      w: ws.id,
      u: uid,
      t: Date.now(),
      n: [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join(""),
    },
    key,
  );
  const uri = redirectUriFor(c, platform.code);

  // X OAuth 1.0a: the request-token secret must be stashed server-side for the
  // callback (Workers have no shared in-memory Map — D1 instead).
  if (platform.code === "x" && !isTwitterOAuth2(resolved.config)) {
    const rt = await xRequestToken(resolved.config, uri, state);
    await db
      .insert(oauthRequestTokens)
      .values({
        token: rt.oauthToken,
        secret: rt.oauthTokenSecret,
        state,
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      })
      .onConflictDoUpdate({
        target: oauthRequestTokens.token,
        set: {
          secret: rt.oauthTokenSecret,
          state,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
        },
      });
    return c.json({ data: { authUrl: rt.authUrl, redirectUri: uri } });
  }

  const authUrl = await provider.authUrl!(
    resolved.config,
    uri,
    state,
    c.env as unknown as Record<string, string | undefined>,
  );
  return c.json({ data: { authUrl, redirectUri: uri } });
});

/* GET|POST /platforms/:code/callback — OAuth callback → connection */
async function callback(c: AppContext) {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const query = c.req.query() as Record<string, string>;
  let body: Record<string, any> = {};
  if (c.req.method === "POST") {
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    } catch {
      /* form posts may not be JSON */
    }
  }
  const q: Record<string, any> = { ...query, ...body };
  const isOAuth1 = Boolean(q.oauth_token && q.oauth_verifier);
  const code = q.auth_code || q.code || q.oauth_verifier;
  let ws: Record<string, any> | undefined;
  let uid: string | undefined;
  let stateVerifier: string | undefined;

  if (isOAuth1) {
    const storedRows = await db
      .select()
      .from(oauthRequestTokens)
      .where(eq(oauthRequestTokens.token, String(q.oauth_token)));
    const stored = (storedRows[0] as unknown as Record<string, any> | undefined) ?? null;
    if (stored) {
      await db.delete(oauthRequestTokens).where(eq(oauthRequestTokens.token, stored.token));
    }
    if (stored?.state) {
      try {
        const st = await parseState(stored.state, key);
        if (st) {
          const authResult = await wsContext(c, st.w);
          ws = authResult.ws;
          uid = authResult.uid;
          stateVerifier = st.v;
        }
      } catch {
        /* fall through to workspaceId param */
      }
    }
    if (!ws || !uid) {
      const authResult = await wsContext(c, q.workspaceId);
      ws = authResult.ws;
      uid = authResult.uid;
    }
    if (stored && new Date(stored.expiresAt).getTime() < Date.now()) {
      throw new HttpError(400, "OAuth session expired — please start over", "OAUTH_EXPIRED");
    }
    q.oauthTokenSecret = stored?.secret || "";
  } else {
    const st = await parseState(q.state, key);
    if (!st) throw new HttpError(400, "Invalid OAuth state", "OAUTH_STATE_INVALID");
    const normReq = normCode((c.req.param("code") ?? ""));
    const normState = normCode(st.p);
    if (normState !== normReq)
      throw new HttpError(400, "OAuth state does not match this platform", "OAUTH_STATE_MISMATCH");
    const authResult = await wsContext(c, st.w);
    ws = authResult.ws;
    uid = authResult.uid;
    if (st.u !== uid)
      throw new HttpError(403, "This OAuth session belongs to a different user", "OAUTH_USER_MISMATCH");
    stateVerifier = st.v;
  }

  if (!code)
    throw new HttpError(400, q.error_description || q.error || "Authorization code missing from OAuth callback", "OAUTH_CODE_MISSING");

  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const resolved: ResolvedConfig = await getConnectionConfig(
    db,
    c.env as unknown as Record<string, string | undefined>,
    key,
    ws.id,
    platform.code,
  );
  const provider = resolved.provider;
  if (!provider?.exchange)
    throw new HttpError(501, `${platform.name} connection is not available yet`, "PROVIDER_UNAVAILABLE");

  let tokens;
  try {
    // X OAuth2 PKCE verifier is derived from SECRET_KEY (same as auth-url side).
    q.pkceSecret = key;
    tokens = await provider.exchange(
      resolved.config,
      code,
      redirectUriFor(c, platform.code),
      stateVerifier,
      q,
    );
  } catch (e) {
    const existing = await connectionFor(db, key, ws.id, platform.id);
    if (existing?.accessToken && isIdempotentExchangeError(e)) {
      return c.json({ data: publicConnection(existing, platform.code) });
    }
    throw new HttpError(400, (e as Error).message, "OAUTH_EXCHANGE_FAILED");
  }
  tokens.scopes = resolved.config.scopes || [];
  const account = await provider.account!(resolved.config, tokens, {
    env: c.env as unknown as Record<string, string | undefined>,
  } as never);
  const conn = await saveConnection(db, key, { ws, platform, tokens, account, uid: uid! });
  return c.json({ data: publicConnection(conn, platform.code) });
}
platforms.get("/platforms/:code/callback", callback);
platforms.post("/platforms/:code/callback", callback);

/* DELETE /platforms/:code/disconnect */
platforms.delete("/platforms/:code/disconnect", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const { ws } = await wsContext(c);
  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const conn = await connectionFor(db, key, ws.id, platform.id);
  if (!conn) throw new HttpError(404, "Not connected", "CONNECTION_NOT_FOUND");
  await db
    .update(platformConnections)
    .set({
      status: "disconnected",
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      setupIssues: [],
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(platformConnections.id, conn.id));
  return c.json({ data: { message: `${platform.name} disconnected` } });
});

/* PATCH /platforms/:code/ads-account-id */
platforms.patch("/platforms/:code/ads-account-id", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId);
  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const conn = await connectionFor(db, key, ws.id, platform.id);
  if (!conn) throw new HttpError(404, "Not connected", "CONNECTION_NOT_FOUND");
  const adsAccountId = String(body.adsAccountId || "").trim();
  if (!adsAccountId) throw new HttpError(400, "adsAccountId required", "ADS_ACCOUNT_REQUIRED");

  const meta = { ...(conn.meta || {}), selectedAdAccountId: adsAccountId };
  const issues = (conn.setupIssues || []).filter((i: any) => i.code !== "no_ad_account");
  const sel = (meta.adAccounts || meta.customers || []).find((a: any) => a.id === adsAccountId);
  if (sel?.managedBy) meta.managerCustomerId = sel.managedBy;
  const patch: Record<string, any> = {
    meta,
    setupIssues: issues,
    externalAccountId: adsAccountId,
    externalAccountName: sel?.name || conn.externalAccountName,
    status: computeStatus({ ...conn, setupIssues: issues }),
    updatedAt: new Date(),
  };
  await db.update(platformConnections).set(patch).where(eq(platformConnections.id, conn.id));

  // TODO Phase 4: importGoogleCampaigns on google_ads (as the old backend did).
  void uid;

  return c.json({ data: { message: "Ad account updated" } });
});

/* GET /platforms/:code/setup-options */
platforms.get("/platforms/:code/setup-options", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const { ws } = await wsContext(c);
  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const conn = await connectionFor(db, key, ws.id, platform.id);
  if (!conn) throw new HttpError(404, "Not connected", "CONNECTION_NOT_FOUND");
  const m = conn.meta || {};
  return c.json({
    data: {
      adAccounts: m.adAccounts || m.customers || [],
      pages: m.pages || [],
      selectedAdAccountId: m.selectedAdAccountId || null,
      selectedPageId: m.selectedPageId || null,
      setupIssues: conn.setupIssues || [],
    },
  });
});

/* POST /platforms/:code/refresh-accounts — re-run account discovery */
platforms.post("/platforms/:code/refresh-accounts", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws } = await wsContext(c, body.workspaceId);
  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const conn = await connectionFor(db, key, ws.id, platform.id);
  if (!conn) throw new HttpError(404, "Not connected", "CONNECTION_NOT_FOUND");
  const provider = providerFor(platform.code);
  if (!provider?.account)
    throw new HttpError(400, "This platform does not support account discovery", "DISCOVERY_UNSUPPORTED");

  const { accessToken } = await getValidAccessToken(
    db,
    key,
    ws.id,
    platform.code,
    c.env as unknown as Record<string, string | undefined>,
  );
  const cfg = (
    await getConnectionConfig(
      db,
      c.env as unknown as Record<string, string | undefined>,
      key,
      ws.id,
      platform.code,
    )
  ).config;
  const account = await provider.account(cfg, { accessToken }, {
    env: c.env as unknown as Record<string, string | undefined>,
  } as never);
  // Keep the user's own choice if it is still among the accounts we can see.
  const keep = (conn.meta || {}).selectedAdAccountId;
  const meta = { ...(conn.meta || {}), ...account.meta };
  if (
    keep &&
    (account.meta?.customers || account.meta?.adAccounts || []).some((a: any) => a.id === keep)
  ) {
    meta.selectedAdAccountId = keep;
  }
  await db
    .update(platformConnections)
    .set({ meta, setupIssues: account.issues || [], updatedAt: new Date() })
    .where(eq(platformConnections.id, conn.id));
  return c.json({
    data: {
      adAccounts: meta.customers || meta.adAccounts || [],
      selectedAdAccountId: meta.selectedAdAccountId || null,
      setupIssues: account.issues || [],
    },
  });
});

/* PATCH /platforms/:code/connection-setup */
platforms.patch("/platforms/:code/connection-setup", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId);
  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const conn = await connectionFor(db, key, ws.id, platform.id);
  if (!conn) throw new HttpError(404, "Not connected", "CONNECTION_NOT_FOUND");

  const m = { ...(conn.meta || {}) };
  let issues = conn.setupIssues || [];
  if (body.adAccountId) {
    m.selectedAdAccountId = body.adAccountId;
    issues = issues.filter((i: any) => i.code !== "no_ad_account");
  }
  if (body.pageId) {
    m.selectedPageId = body.pageId;
    issues = issues.filter((i: any) => i.code !== "no_page");
  }
  const sel = (m.adAccounts || m.customers || []).find((a: any) => a.id === m.selectedAdAccountId);
  if (sel?.managedBy) m.managerCustomerId = sel.managedBy;
  const patch: Record<string, any> = {
    meta: m,
    setupIssues: issues,
    ...(sel
      ? {
          externalAccountId: sel.id,
          externalAccountName: `${sel.name} · ad account + page`,
          currency: sel.currency || conn.currency,
        }
      : {}),
    status: computeStatus({ ...conn, setupIssues: issues }),
    updatedAt: new Date(),
  };
  await db.update(platformConnections).set(patch).where(eq(platformConnections.id, conn.id));

  // TODO Phase 4: importGoogleCampaigns on google_ads (as the old backend did).
  void uid;

  return c.json({
    data: {
      message: "Connection setup saved",
      selectedAdAccountId: m.selectedAdAccountId,
      selectedPageId: m.selectedPageId,
    },
  });
});

/* POST /platforms/:code/api-key — connect via API key (OpenAI Ads) */
platforms.post("/platforms/:code/api-key", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const { ws, uid } = await wsContext(c, body.workspaceId);
  const platform = await platformByCode(db, (c.req.param("code") ?? ""));
  const provider = providerFor(platform.code);
  if (!provider?.apiKey)
    throw new HttpError(400, `${platform.name} does not use an API key`, "NOT_API_KEY_PLATFORM");
  const apiKey = String(body.apiKey || "").trim();
  if (!apiKey) throw new HttpError(400, "apiKey required", "API_KEY_REQUIRED");

  const resolved: ResolvedConfig = await getConnectionConfig(
    db,
    c.env as unknown as Record<string, string | undefined>,
    key,
    ws.id,
    platform.code,
  );
  let account;
  try {
    account = await provider.account!(resolved.config, { accessToken: apiKey });
  } catch (e) {
    throw new HttpError(400, `Could not verify the API key: ${(e as Error).message}`, "API_KEY_INVALID");
  }
  const conn = await saveConnection(db, key, { ws, platform, tokens: { accessToken: apiKey }, account, uid });
  return c.json({ data: publicConnection(conn, platform.code) });
});

/* PATCH /platform-configs/:platformCode — update stored OAuth config */
platforms.patch("/platform-configs/:platformCode", async (c) => {
  const db = getDb(c.env.DB);
  const key = secretKey(c);
  const platform = await platformByCode(db, c.req.param("platformCode"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;

  const patch: Record<string, any> = {};
  for (const f of ["clientId", "developerToken", "authorizeUrl", "tokenUrl", "apiVersion", "isConfigured"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (body.clientSecret !== undefined) patch.clientSecret = body.clientSecret;
  if (body.scopes !== undefined) patch.scopes = body.scopes;
  const extra = { ...(body.extra || {}) };
  if (body.oauthVersion !== undefined) extra.oauthVersion = body.oauthVersion;
  if (Object.keys(extra).length) patch.extra = extra;
  if (body.clientId || body.clientSecret || body.developerToken) patch.isConfigured = true;

  const rows = await db
    .select()
    .from(platformConfigs)
    .where(eq(platformConfigs.platform_id, platform.id));
  const existing = (rows[0] as unknown as Record<string, any> | undefined) ?? null;
  if (existing) {
    const mergedExtra = { ...(existing.extra || {}), ...(patch.extra || {}) };
    const enc = (await encryptRowSecrets(
      "platform_configs",
      { ...patch, extra: mergedExtra },
      key,
    )) as Record<string, any>;
    await db
      .update(platformConfigs)
      .set({ ...enc, updatedAt: new Date() })
      .where(eq(platformConfigs.id, existing.id));
  } else {
    const enc = (await encryptRowSecrets(
      "platform_configs",
      { ...patch, platform_id: platform.id },
      key,
    )) as Record<string, any>;
    await db.insert(platformConfigs).values(enc as typeof platformConfigs.$inferInsert);
  }
  return c.json({ data: { message: "Platform config updated", platformCode: platform.code } });
});

export default platforms;
