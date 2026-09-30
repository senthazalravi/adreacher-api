// Platform connection helpers: config resolution (env wins over DB),
// HMAC-signed OAuth state, access-token refresh, and health status.
// Port of the old lib/connections.js, backed by Drizzle/D1 and the
// AES-256-GCM secrets layer (lib/secrets.ts) instead of Baasix.
import { and, eq, isNull } from "drizzle-orm";
import {
  adPlatforms,
  platformConfigs,
  platformConnections,
} from "../db/schema/index.js";
import {
  isTwitterOAuth2,
  providerFor,
  type PlatformCfg,
} from "./platform-providers.js";
import { decryptRowSecrets } from "./secrets.js";
import { HttpError } from "./filter.js";
import type { Db } from "../db/index.js";

export interface OAuthEnvDefaults {
  clientId?: string;
  clientSecret?: string;
  developerToken?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
}

/** Env-level defaults for a platform. Same ADS_<CODE>_* names as the old backend. */
export function envOAuthDefaults(
  code: string,
  env: Record<string, string | undefined>,
): OAuthEnvDefaults {
  const p = `ADS_${String(code || "").toUpperCase()}_`;
  return {
    clientId: env[`${p}CLIENT_ID`],
    clientSecret: env[`${p}CLIENT_SECRET`],
    developerToken: env[`${p}DEVELOPER_TOKEN`],
    authorizeUrl:
      env[`${p}AUTHORIZE_URL`] ||
      (String(code) === "x" ? "https://twitter.com/i/oauth2/authorize" : undefined),
    tokenUrl:
      env[`${p}TOKEN_URL`] ||
      (String(code) === "x" ? "https://api.twitter.com/2/oauth2/token" : undefined),
  };
}

export interface ResolvedConfig {
  platform: Record<string, any>;
  platformConfig: Record<string, any> | null;
  connection: Record<string, any> | null;
  config: PlatformCfg;
  provider: ReturnType<typeof providerFor>;
  code: string;
  clientId?: string | null;
  clientSecret?: string | null;
  developerToken?: string | null;
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
  needsKey: boolean;
  authorized: boolean;
}

export class ConnHttpError extends HttpError {
  data?: unknown;
  constructor(status: number, message: string, code?: string, data?: unknown) {
    super(status, message, code);
    this.data = data;
  }
}

export async function getPlatformByCode(db: Db, code: string) {
  const rows = await db
    .select()
    .from(adPlatforms)
    .where(and(eq(adPlatforms.code, code), eq(adPlatforms.isEnabled, true)));
  const platform = rows[0] as unknown as Record<string, any> | undefined;
  if (!platform) {
    throw new ConnHttpError(404, `Platform "${code}" is not available`, "PLATFORM_NOT_FOUND");
  }
  return platform;
}

/**
 * Resolve effective OAuth config: env vars win over the DB platform_configs
 * row, which wins over the ad_platforms row defaults. Tokens on the
 * workspace connection row are decrypted for use.
 */
export async function getConnectionConfig(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  workspaceId: string,
  code: string,
): Promise<ResolvedConfig> {
  const platform = await getPlatformByCode(db, code);
  const provider = providerFor(code);
  const envDefaults = envOAuthDefaults(code, env);

  const cfgRows = await db
    .select()
    .from(platformConfigs)
    .where(eq(platformConfigs.platform_id, platform.id));
  const platformConfigRaw = (cfgRows[0] as unknown as Record<string, any> | undefined) ?? null;
  const platformConfig = platformConfigRaw
    ? ((await decryptRowSecrets(
        "platform_configs",
        platformConfigRaw,
        secretKey,
      )) as Record<string, any>)
    : null;

  const connRows = await db
    .select()
    .from(platformConnections)
    .where(
      and(
        eq(platformConnections.workspace_id, workspaceId),
        eq(platformConnections.platform_id, platform.id),
        isNull(platformConnections.deletedAt),
      ),
    );
  const connectionRaw = (connRows[0] as unknown as Record<string, any> | undefined) ?? null;
  const connection = connectionRaw
    ? ((await decryptRowSecrets(
        "platform_connections",
        connectionRaw,
        secretKey,
      )) as Record<string, any>)
    : null;

  const extra: Record<string, any> = {
    ...(platform.extra || {}),
    ...(platformConfig?.extra || {}),
  };
  const oauthVersionEnv = env[`ADS_${String(code || "").toUpperCase()}_OAUTH_VERSION`];
  const config: PlatformCfg = {
    clientId: envDefaults.clientId ?? platformConfig?.clientId ?? platform.clientId ?? null,
    clientSecret: envDefaults.clientSecret ?? platformConfig?.clientSecret ?? null,
    developerToken: envDefaults.developerToken ?? platformConfig?.developerToken ?? null,
    authorizeUrl:
      envDefaults.authorizeUrl ?? platformConfig?.authorizeUrl ?? platform.authorizeUrl ?? null,
    tokenUrl: envDefaults.tokenUrl ?? platformConfig?.tokenUrl ?? platform.tokenUrl ?? null,
    scopes: platformConfig?.scopes ?? platform.scopes ?? [],
    apiVersion: platformConfig?.apiVersion ?? platform.apiVersion ?? null,
    oauthVersion:
      (oauthVersionEnv ? parseInt(oauthVersionEnv, 10) : null) ??
      platformConfig?.extra?.oauthVersion ??
      (code === "x" ? 1 : null),
    extra,
  };

  const needsKey = Boolean(provider?.apiKey);
  const authorized = Boolean(connection?.accessToken);

  return {
    platform,
    platformConfig,
    connection,
    config,
    provider,
    code,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    developerToken: config.developerToken,
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    needsKey,
    authorized,
  };
}

/* ---------------- OAuth state ---------------- */

const te = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

/** Sign {ws, code, redirectUri?} for the OAuth round-trip (replaces signed cookies). */
export async function signState(
  payload: Record<string, unknown>,
  secretKey: string,
): Promise<string> {
  const body = b64url(te.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function parseState(
  state: string,
  secretKey: string,
): Promise<Record<string, any> | null> {
  try {
    const [body, sig] = String(state || "").split(".");
    if (!body || !sig) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      te.encode(secretKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify("HMAC", key, unb64url(sig), te.encode(body));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(unb64url(body)));
  } catch {
    return null;
  }
}

/* ---------------- status ---------------- */

// Only a connection that cannot refresh is judged on its access-token clock
// (Google's hourly tokens would otherwise read "expiring" while healthy).
const EXPIRING_DAYS = 7;

/**
 * Compute the connect-state for a workspace connection row (decrypted).
 * Mirrors the old computeStatus semantics exactly: not_connected / healthy /
 * expiring / expired / setup_incomplete / error / disconnected.
 */
export function computeStatus(conn: Record<string, any> | null): string {
  if (!conn) return "not_connected";
  if (conn.status === "disconnected" || conn.status === "error") return conn.status;
  // Set by getValidAccessToken when the refresh token itself is rejected; only a reconnect clears it.
  if (conn.status === "expired" && conn.lastError) return "expired";
  if (!conn.accessToken) return "not_connected";
  if (
    (conn.setupIssues || []).some((i: any) =>
      ["no_ad_account", "no_page", "no_developer_token"].includes(i.code),
    )
  )
    return "setup_incomplete";
  // A refresh token means the access token is renewed automatically, so its
  // expiry says nothing about the connection's health.
  if (!conn.refreshToken && conn.tokenExpiresAt) {
    const ms = new Date(conn.tokenExpiresAt).getTime() - Date.now();
    if (ms <= 0) return "expired";
    if (ms < EXPIRING_DAYS * 864e5) return "expiring";
  }
  return "healthy";
}

export function statusMessage(status: string): string {
  switch (status) {
    case "error":
      return "Connection failed — reconnect to restore sync.";
    case "expired":
      return "Token expired — reconnect to restore sync.";
    case "expiring":
      return "Token expires soon.";
    case "setup_incomplete":
      return "Connected, but setup needs attention.";
    case "disconnected":
      return "Not connected yet.";
    default:
      return "Connected and healthy.";
  }
}

/**
 * The public connection shape the frontend reads — the row minus its
 * secrets, plus hasToken / status / platformCode. Same as the old
 * publicConnection(conn, platformCode).
 */
export function publicConnection(
  conn: Record<string, any> | null,
  platformCode: string,
): Record<string, any> | null {
  if (!conn) return null;
  const { accessToken, refreshToken, ...rest } = conn;
  return { ...rest, hasToken: Boolean(accessToken), status: computeStatus(conn), platformCode };
}

/* ---------------- access token ---------------- */

/**
 * The old callback treated an exchange failure as idempotent when the
 * provider said the grant was already used / invalid but we still hold a
 * working token: return the existing connection instead of erroring.
 */
export function isIdempotentExchangeError(e: unknown): boolean {
  return /invalid_grant|already/i.test((e as Error)?.message || "");
}

/**
 * Access token for server-side platform calls; refreshes (and persists) when
 * expiring within 5 minutes. Mirrors the old getValidAccessToken.
 * A refresh the provider rejects marks the connection "expired" and throws
 * 409/TOKEN_REFRESH_FAILED — only a reconnect clears it.
 */
export async function getValidAccessToken(
  db: Db,
  secretKey: string,
  workspaceId: string,
  code: string,
  env: Record<string, string | undefined>,
): Promise<{ accessToken: string; connection: Record<string, any> }> {
  const resolved = await getConnectionConfig(db, env, secretKey, workspaceId, code);
  const { platform, provider, connection, config } = resolved;
  const conn = connection as Record<string, any> | null;

  if (!conn?.accessToken) {
    throw new ConnHttpError(
      404,
      `Platform "${code}" is not connected`,
      "CONNECTION_NOT_FOUND",
    );
  }

  const msLeft = conn.tokenExpiresAt
    ? new Date(conn.tokenExpiresAt).getTime() - Date.now()
    : Infinity;
  if (msLeft > 5 * 60 * 1000 || !provider?.refresh) {
    return { accessToken: conn.accessToken, connection: conn };
  }

  let fresh: { accessToken: string; refreshToken?: string | null; expiresIn?: number | null };
  try {
    fresh = await provider.refresh(config, conn.refreshToken, conn.accessToken);
  } catch (e) {
    const body = (e as any)?.body;
    const reason = body?.error
      ? `${body.error}${body.error_description ? `: ${body.error_description}` : ""}`
      : ((e as Error).message || String(e));
    await db
      .update(platformConnections)
      .set({
        status: "expired",
        lastError: `Token refresh failed — ${reason}`,
        updatedAt: new Date(),
      })
      .where(eq(platformConnections.id, conn.id));
    throw new ConnHttpError(
      409,
      `${platform?.name || "Platform"} connection has expired (${reason}) — reconnect it in Connections`,
      "TOKEN_REFRESH_FAILED",
    );
  }

  const patch: Record<string, any> = {
    accessToken: fresh.accessToken,
    ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
    tokenExpiresAt: fresh.expiresIn ? new Date(Date.now() + fresh.expiresIn * 1000) : null,
    lastError: null,
    ...(conn.status === "expired" ? { status: "healthy" } : {}),
    updatedAt: new Date(),
  };
  await db.update(platformConnections).set(patch).where(eq(platformConnections.id, conn.id));
  return { accessToken: fresh.accessToken, connection: { ...conn, ...patch } };
}

/** X OAuth1 access-token secret lives in refreshToken (see provider exchange). */
export async function getXOAuth1Credentials(
  db: Db,
  secretKey: string,
  workspaceId: string,
  env: Record<string, string | undefined>,
): Promise<{ accessToken: string; accessTokenSecret: string }> {
  const resolved = await getConnectionConfig(db, env, secretKey, workspaceId, "x");
  const conn = resolved.connection as Record<string, any> | null;
  if (!conn?.accessToken) {
    throw new ConnHttpError(404, "No X connection for workspace", "CONNECTION_NOT_FOUND");
  }
  return {
    accessToken: conn.accessToken,
    accessTokenSecret: conn.refreshToken || (conn.meta as any)?.accessTokenSecret || "",
  };
}
