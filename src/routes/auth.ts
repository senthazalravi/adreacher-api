// Authentication routes. Implements every /auth/* endpoint the frontend calls
// (see fe-api-surface.md §2) with identical method+path and response shapes.
// Contract: Bearer JWT in Authorization header, {data} envelope,
// ?token= OAuth handoff to the app's /auth/callback page.

import { Hono, type Context } from "hono";
import { getDb } from "../db/index.js";
import { and, eq, isNull } from "drizzle-orm";
import type { Env } from "../index.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { signJwt, verifyJwt, type JwtType } from "../lib/jwt.js";
import { generateTotpSecret, totpUri, verifyTotp } from "../lib/totp.js";
import { authMiddleware, getJwtSecret } from "../lib/auth.js";
import { bootstrapAccount } from "../lib/bootstrap.js";
import { sendMail, linkEmail } from "../lib/mail.js";
import { HttpError } from "../lib/filter.js";
import { rateLimitClear, rateLimitHit, rateLimitPeek } from "../lib/rate-limit.js";
import { users, tenants, userTokens } from "../db/schema/identity.js";
import { workspaceMembers } from "../db/schema/core.js";

type Db = ReturnType<typeof getDb>;
type AppContext = Context<{ Bindings: Env }>;

const auth = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sanitizeUser(row: Record<string, unknown>): Record<string, unknown> {
  const { passwordHash: _ph, totpSecret: _ts, ...rest } = row;
  return rest;
}

async function mint(
  env: Env,
  user: { id: string },
  tenantId: string,
  type: JwtType,
): Promise<string> {
  return signJwt({ sub: user.id, tenantId, type }, getJwtSecret(env));
}

function randomToken(bytes = 32): string {
  const rnd = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of rnd) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create a single-use token row; returns the raw token (shown once). */
async function issueUserToken(
  db: Db,
  opts: {
    userId?: string | null;
    email: string;
    tenantId?: string | null;
    type: "password_reset" | "email_verify" | "magic_link" | "invite";
    ttlMs: number;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const raw = randomToken();
  await db.insert(userTokens).values({
    userId: opts.userId ?? null,
    email: opts.email.toLowerCase(),
    tenantId: opts.tenantId ?? null,
    type: opts.type,
    tokenHash: await sha256Hex(raw),
    data: opts.data ?? null,
    expiresAt: new Date(Date.now() + opts.ttlMs),
  });
  return raw;
}

/** Validate + consume a single-use token. Returns the row or throws 400/410. */
async function consumeUserToken(
  db: Db,
  raw: string,
  type: "password_reset" | "email_verify" | "magic_link" | "invite",
): Promise<Record<string, unknown>> {
  const row = await db.query.userTokens.findFirst({
    where: and(eq(userTokens.tokenHash, await sha256Hex(raw)), eq(userTokens.type, type)),
  });
  if (!row) throw new HttpError(400, "Invalid token", "INVALID_TOKEN");
  if (row.usedAt) throw new HttpError(400, "Token already used", "TOKEN_USED");
  if (row.expiresAt.getTime() <= Date.now()) throw new HttpError(410, "Token expired", "TOKEN_EXPIRED");
  await db.update(userTokens).set({ usedAt: new Date() }).where(eq(userTokens.id, row.id));
  return row as unknown as Record<string, unknown>;
}

function clientIp(c: AppContext): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function rateLimited(c: AppContext, retryAfterSec: number) {
  return c.json(
    { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
    429,
    { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))) },
  );
}

async function readJson(c: AppContext): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_BODY");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object", "INVALID_BODY");
  }
  return body as Record<string, unknown>;
}

function appUrl(env: Env): string {
  return (env.APP_URL || "https://adreacher.app").replace(/\/+$/, "");
}

/** Only allow token-handoff redirect targets on the app origin. */
function safeRedirect(c: AppContext, raw: unknown, fallbackPath = "/auth/callback"): string {
  const base = appUrl(c.env);
  if (typeof raw === "string" && raw) {
    try {
      const u = new URL(raw, base);
      if (u.origin === new URL(base).origin) return u.toString();
    } catch {
      /* fall through to the app default */
    }
  }
  return `${base}${fallbackPath}`;
}

function apiPublicUrl(env: Env): string {
  return (env.API_PUBLIC_URL || "http://localhost:8787").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// registration & password login
// ---------------------------------------------------------------------------

auth.post("/register", async (c) => {
  const body = await readJson(c);
  const email = String(body["email"] ?? "").toLowerCase().trim();
  const password = String(body["password"] ?? "");
  const tenant = (body["tenant"] as Record<string, unknown> | undefined) ?? {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, "Valid email required", "INVALID_EMAIL");
  }
  if (password.length < 8) {
    throw new HttpError(400, "Password must be at least 8 characters", "WEAK_PASSWORD");
  }
  const db = getDb(c.env.DB);
  const regRetry = await rateLimitHit(db, `register:ip:${clientIp(c)}`, 10, 60 * 60);
  if (regRetry > 0) return rateLimited(c, regRetry);
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) throw new HttpError(409, "An account with this email already exists", "USER_EXISTS");

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(password),
      firstName: (body["firstName"] as string) ?? null,
      lastName: (body["lastName"] as string) ?? null,
    })
    .returning();
  if (!user) throw new HttpError(500, "Registration failed", "REGISTRATION_FAILED");
  const { tenantId } = await bootstrapAccount(db, {
    account: { name: String(tenant["name"] ?? email.split("@")[0]) },
    ownerUserId: user.id,
  });
  const token = await mint(c.env, user, tenantId, "access");
  const refreshToken = await mint(c.env, user, tenantId, "refresh");
  const fresh = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  return c.json({ data: { token, refreshToken, user: sanitizeUser(fresh as unknown as Record<string, unknown>) } });
});

auth.post("/login", async (c) => {
  const body = await readJson(c);
  const email = String(body["email"] ?? "").toLowerCase().trim();
  const password = String(body["password"] ?? "");
  const db = getDb(c.env.DB);
  const ipRetry = await rateLimitHit(db, `login:ip:${clientIp(c)}`, 30, 15 * 60);
  if (ipRetry > 0) return rateLimited(c, ipRetry);
  const emailRetry = await rateLimitPeek(db, `login:email:${email}`, 5, 15 * 60);
  if (emailRetry > 0) return rateLimited(c, emailRetry);
  const user = await db.query.users.findFirst({
    where: and(eq(users.email, email), isNull(users.deletedAt)),
  });
  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    await rateLimitHit(db, `login:email:${email}`, 5, 15 * 60);
    return c.json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }, 401);
  }
  await rateLimitClear(db, `login:email:${email}`);
  let tenantId = user.tenantId;
  const requested = body["tenant_Id"] ?? body["tenantId"];
  if (requested) {
    const ok = await canAccessTenant(db, user.id, String(requested), user.platformAdmin === true);
    if (!ok) return c.json({ error: { code: "FORBIDDEN", message: "No access to that account" } }, 403);
    tenantId = String(requested);
  }
  if (!tenantId) {
    return c.json({ error: { code: "NO_TENANT", message: "Account has no tenant" } }, 403);
  }
  if (user.twoFactorEnabled) {
    const twoFactorToken = await mint(c.env, user, tenantId, "2fa");
    return c.json({ data: { twoFactorRequired: true, twoFactorToken } });
  }
  const token = await mint(c.env, user, tenantId, "access");
  const refreshToken = await mint(c.env, user, tenantId, "refresh");
  return c.json({ data: { token, refreshToken, user: sanitizeUser(user as unknown as Record<string, unknown>) } });
});

async function canAccessTenant(
  db: Db,
  userId: string,
  tenantId: string,
  platformAdmin: boolean,
): Promise<boolean> {
  if (platformAdmin) return true;
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant || tenant.deletedAt) return false;
  if (tenant.ownerId === userId) return true;
  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.member_id, userId),
      eq(workspaceMembers.account_id, tenantId),
      eq(workspaceMembers.status, "active"),
    ),
  });
  return !!member;
}

// ---------------------------------------------------------------------------
// refresh / me / logout / switch-tenant
// ---------------------------------------------------------------------------

auth.post("/refresh", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const raw = m?.[1];
  if (!raw) return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  let payload;
  try {
    payload = await verifyJwt(raw, getJwtSecret(c.env));
  } catch {
    payload = null;
  }
  // Accepts the current access OR refresh token as Bearer (matches old contract).
  if (!payload || (payload.type !== "access" && payload.type !== "refresh")) {
    return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  }
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, payload.sub), isNull(users.deletedAt)),
  });
  if (!user) return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  const token = await mint(c.env, user, payload.tenantId, "access");
  return c.json({ data: { token } });
});

auth.get("/me", authMiddleware, async (c) => {
  const s = c.get("session");
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.userId) });
  if (!user) return c.json({ error: { code: "NOT_FOUND" } }, 404);
  return c.json({ data: { user: sanitizeUser(user as unknown as Record<string, unknown>) } });
});

auth.get("/logout", async (c) => c.json({ data: { ok: true } }));

auth.post("/switch-tenant", authMiddleware, async (c) => {
  const s = c.get("session");
  const body = await readJson(c);
  const tenantId = String(body["tenant_Id"] ?? body["tenantId"] ?? "");
  if (!tenantId) throw new HttpError(400, "tenant_Id required", "INVALID_BODY");
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.userId) });
  if (!user) return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  const ok = await canAccessTenant(db, user.id, tenantId, user.platformAdmin === true);
  if (!ok) return c.json({ error: { code: "FORBIDDEN", message: "No access to that account" } }, 403);
  const token = await mint(c.env, user, tenantId, "access");
  return c.json({ data: { token } });
});

// ---------------------------------------------------------------------------
// magic link
// ---------------------------------------------------------------------------

auth.post("/magiclink", async (c) => {
  const body = await readJson(c);
  const email = String(body["email"] ?? "").toLowerCase().trim();
  const link = safeRedirect(c, body["link"], "");
  const db = getDb(c.env.DB);
  // Always respond OK (no account enumeration).
  const user = await db.query.users.findFirst({
    where: and(eq(users.email, email), isNull(users.deletedAt)),
  });
  const magicLimited =
    (await rateLimitHit(db, `magic:ip:${clientIp(c)}`, 10, 60 * 60)) > 0 ||
    (await rateLimitHit(db, `magic:email:${email}`, 3, 60 * 60)) > 0;
  if (user?.tenantId && !magicLimited) {
    const raw = await issueUserToken(db, {
      userId: user.id,
      email,
      tenantId: user.tenantId,
      type: "magic_link",
      ttlMs: 15 * 60_000,
    });
    const verifyUrl = `${apiPublicUrl(c.env)}/auth/magiclink/verify?token=${raw}&redirect=${encodeURIComponent(link)}`;
    const mail = linkEmail({
      appUrl: appUrl(c.env),
      heading: "Your sign-in link",
      body: "Click below to sign in to AdReacher. This link expires in 15 minutes.",
      ctaUrl: verifyUrl,
      ctaLabel: "Sign in",
    });
    await sendMail(c.env, { to: email, ...mail });
  }
  return c.json({ data: { ok: true } });
});

auth.get("/magiclink/verify", async (c) => {
  const raw = c.req.query("token") ?? "";
  const redirect = safeRedirect(c, c.req.query("redirect"), "");
  const db = getDb(c.env.DB);
  let row;
  try {
    row = await consumeUserToken(db, raw, "magic_link");
  } catch {
    return c.redirect(`${redirect}?error=invalid_token`, 302);
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, String(row["userId"])) });
  if (!user || !row["tenantId"]) return c.redirect(`${redirect}?error=invalid_token`, 302);
  const token = await mint(c.env, user, String(row["tenantId"]), "access");
  return c.redirect(`${redirect}?token=${token}`, 302);
});

// ---------------------------------------------------------------------------
// password reset / change, email verify
// ---------------------------------------------------------------------------

auth.post("/password/reset", async (c) => {
  const body = await readJson(c);
  const email = String(body["email"] ?? "").toLowerCase().trim();
  const link = String(body["link"] ?? `${appUrl(c.env)}/reset-password`);
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({
    where: and(eq(users.email, email), isNull(users.deletedAt)),
  });
  const resetLimited =
    (await rateLimitHit(db, `reset:ip:${clientIp(c)}`, 10, 60 * 60)) > 0 ||
    (await rateLimitHit(db, `reset:email:${email}`, 3, 60 * 60)) > 0;
  if (user && !resetLimited) {
    const raw = await issueUserToken(db, {
      userId: user.id,
      email,
      tenantId: user.tenantId,
      type: "password_reset",
      ttlMs: 60 * 60_000,
    });
    const resetUrl = `${link}${link.includes("?") ? "&" : "?"}token=${raw}`;
    const mail = linkEmail({
      appUrl: appUrl(c.env),
      heading: "Reset your password",
      body: "Click below to choose a new password. This link expires in 1 hour.",
      ctaUrl: resetUrl,
      ctaLabel: "Reset password",
    });
    await sendMail(c.env, { to: email, ...mail });
  }
  return c.json({ data: { ok: true } });
});

auth.post("/password/reset/:token", async (c) => {
  const body = await readJson(c);
  const password = String(body["password"] ?? "");
  if (password.length < 8) {
    throw new HttpError(400, "Password must be at least 8 characters", "WEAK_PASSWORD");
  }
  const db = getDb(c.env.DB);
  const row = await consumeUserToken(db, c.req.param("token"), "password_reset");
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
    .where(eq(users.id, String(row["userId"])));
  return c.json({ data: { ok: true } });
});

auth.post("/password/change", authMiddleware, async (c) => {
  const s = c.get("session");
  const body = await readJson(c);
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.userId) });
  if (!user?.passwordHash || !(await verifyPassword(String(body["currentPassword"] ?? ""), user.passwordHash))) {
    return c.json({ error: { code: "INVALID_CREDENTIALS", message: "Current password is wrong" } }, 401);
  }
  const next = String(body["newPassword"] ?? "");
  if (next.length < 8) throw new HttpError(400, "Password must be at least 8 characters", "WEAK_PASSWORD");
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(next), updatedAt: new Date() })
    .where(eq(users.id, s.userId));
  return c.json({ data: { ok: true } });
});

auth.get("/email/verify/:token", async (c) => {
  const db = getDb(c.env.DB);
  const redirect = c.req.query("redirect");
  let row;
  try {
    row = await consumeUserToken(db, c.req.param("token"), "email_verify");
  } catch (e) {
    if (redirect) return c.redirect(`${redirect}?error=invalid_token`, 302);
    throw e;
  }
  await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.id, String(row["userId"])));
  if (redirect) return c.redirect(redirect, 302);
  return c.json({ data: { ok: true } });
});

auth.post("/email/verify/resend", async (c) => {
  const body = await readJson(c);
  const email = String(body["email"] ?? "").toLowerCase().trim();
  const link = String(body["link"] ?? appUrl(c.env));
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({
    where: and(eq(users.email, email), isNull(users.deletedAt)),
  });
  if (user && !user.emailVerified) {
    const raw = await issueUserToken(db, {
      userId: user.id,
      email,
      tenantId: user.tenantId,
      type: "email_verify",
      ttlMs: 24 * 3600_000,
    });
    const verifyUrl = `${apiPublicUrl(c.env)}/auth/email/verify/${raw}?redirect=${encodeURIComponent(link)}`;
    const mail = linkEmail({
      appUrl: appUrl(c.env),
      heading: "Verify your email",
      body: "Click below to verify your email address.",
      ctaUrl: verifyUrl,
      ctaLabel: "Verify email",
    });
    await sendMail(c.env, { to: email, ...mail });
  }
  return c.json({ data: { ok: true } });
});

// ---------------------------------------------------------------------------
// OAuth sign-in (user login via Google; facebook/github → 501)
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signState(data: Record<string, unknown>, secret: string): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + 600 })),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyState(raw: string, secret: string): Promise<Record<string, unknown> | null> {
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle
    .verify("HMAC", key, b64urlDecode(sig), new TextEncoder().encode(payload))
    .catch(() => false);
  if (!ok) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (typeof data.exp !== "number" || data.exp * 1000 <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

auth.get("/signin/:provider", async (c) => {
  const provider = c.req.param("provider");
  const redirectUrl = safeRedirect(c, c.req.query("redirect_url"));
  if (provider !== "google" && provider !== "facebook") {
    return c.json(
      { error: { code: "OAUTH_NOT_CONFIGURED", message: `Sign-in with ${provider} is not enabled` } },
      501,
    );
  }
  const state = await signState({ provider, redirect_url: redirectUrl }, getJwtSecret(c.env));
  if (provider === "facebook") {
    const clientId = c.env.FACEBOOK_CLIENT_ID;
    if (!clientId) {
      return c.json(
        { error: { code: "OAUTH_NOT_CONFIGURED", message: "Facebook sign-in is not configured" } },
        501,
      );
    }
    const url =
      "https://www.facebook.com/v18.0/dialog/oauth?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: `${apiPublicUrl(c.env)}/auth/signin/facebook/callback`,
        response_type: "code",
        scope: "email,public_profile",
        state,
      }).toString();
    return c.redirect(url, 302);
  }
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return c.json(
      { error: { code: "OAUTH_NOT_CONFIGURED", message: "Google sign-in is not configured" } },
      501,
    );
  }
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${apiPublicUrl(c.env)}/auth/signin/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "online",
      prompt: "select_account",
    }).toString();
  return c.redirect(url, 302);
});

auth.get("/signin/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  const code = c.req.query("code") ?? "";
  const stateRaw = c.req.query("state") ?? "";
  const state = await verifyState(stateRaw, getJwtSecret(c.env)).catch(() => null);
  const redirectUrl = safeRedirect(c, state?.["redirect_url"]);
  const fail = (msg: string) => c.redirect(`${redirectUrl}?error=${encodeURIComponent(msg)}`, 302);
  if ((provider !== "google" && provider !== "facebook") || !code || !state) return fail("oauth_failed");

  let email = "";
  let firstName: string | null = null;
  let lastName: string | null = null;
  let displayName: string | null = null;
  let avatarUrl: string | null = null;

  if (provider === "facebook") {
    const clientId = c.env.FACEBOOK_CLIENT_ID!;
    const clientSecret = c.env.FACEBOOK_CLIENT_SECRET!;
    const tokenRes = await fetch(
      "https://graph.facebook.com/v18.0/oauth/access_token?" +
        new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: `${apiPublicUrl(c.env)}/auth/signin/facebook/callback`,
        }).toString()
    );
    if (!tokenRes.ok) return fail("oauth_failed");
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) return fail("oauth_failed");
    const meRes = await fetch(
      `https://graph.facebook.com/v18.0/me?fields=id,name,email,first_name,last_name,picture.type(large)&access_token=${tokens.access_token}`
    );
    if (!meRes.ok) return fail("oauth_failed");
    const profile = (await meRes.json()) as {
      email?: string;
      first_name?: string;
      last_name?: string;
      name?: string;
      picture?: { data?: { url?: string } };
    };
    email = (profile.email ?? "").toLowerCase().trim();
    if (!email) return fail("oauth_failed");
    firstName = profile.first_name ?? null;
    lastName = profile.last_name ?? null;
    displayName = profile.name ?? null;
    avatarUrl = profile.picture?.data?.url ?? null;
  } else {
    const clientId = c.env.GOOGLE_CLIENT_ID!;
    const clientSecret = c.env.GOOGLE_CLIENT_SECRET!;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${apiPublicUrl(c.env)}/auth/signin/google/callback`,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) return fail("oauth_failed");
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) return fail("oauth_failed");
    const meRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) return fail("oauth_failed");
    const profile = (await meRes.json()) as {
      email?: string;
      given_name?: string;
      family_name?: string;
      name?: string;
      picture?: string;
    };
    email = (profile.email ?? "").toLowerCase().trim();
    if (!email) return fail("oauth_failed");
    firstName = profile.given_name ?? null;
    lastName = profile.family_name ?? null;
    displayName = profile.name ?? null;
    avatarUrl = typeof profile.picture === "string" && profile.picture ? profile.picture : null;
  }

  const db = getDb(c.env.DB);
  let user = await db.query.users.findFirst({
    where: and(eq(users.email, email), isNull(users.deletedAt)),
  });
  let tenantId = user?.tenantId ?? null;
  if (!user) {
    const [created] = await db
      .insert(users)
      .values({
        email,
        firstName,
        lastName,
        avatarUrl,
        emailVerified: true,
      })
      .returning();
    if (!created) return fail("no_user");
    user = created;
    ({ tenantId } = await bootstrapAccount(db, {
      account: { name: displayName || email.split("@")[0] },
      ownerUserId: user.id,
    }));
  }
  if (!tenantId) return fail("no_tenant");
  // Refresh the avatar on every Google sign-in (covers existing users).
  if (avatarUrl && user.avatarUrl !== avatarUrl) {
    await db.update(users).set({ avatarUrl, updatedAt: new Date() }).where(eq(users.id, user.id));
    user = { ...user, avatarUrl };
  }
  const token = await mint(c.env, user, tenantId, "access");
  return c.redirect(`${redirectUrl}?token=${token}`, 302);
});

// ---------------------------------------------------------------------------
// TOTP two-factor
// ---------------------------------------------------------------------------

auth.post("/2fa/verify", async (c) => {
  const body = await readJson(c);
  let payload;
  try {
    payload = await verifyJwt(String(body["twoFactorToken"] ?? ""), getJwtSecret(c.env));
  } catch {
    payload = null;
  }
  if (!payload || payload.type !== "2fa") {
    return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  }
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });
  const twoFaRetry = await rateLimitHit(db, `2fa:user:${payload.sub}`, 5, 15 * 60);
  if (twoFaRetry > 0) return rateLimited(c, twoFaRetry);
  if (!user?.totpSecret || !(await verifyTotp(user.totpSecret, String(body["code"] ?? "")))) {
    return c.json({ error: { code: "INVALID_CODE", message: "Invalid verification code" } }, 401);
  }
  await rateLimitClear(db, `2fa:user:${payload.sub}`);
  const token = await mint(c.env, user, payload.tenantId, "access");
  const refreshToken = await mint(c.env, user, payload.tenantId, "refresh");
  return c.json({ data: { token, refreshToken, user: sanitizeUser(user as unknown as Record<string, unknown>) } });
});

auth.post("/2fa/enable", authMiddleware, async (c) => {
  const s = c.get("session");
  const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.userId) });
  // Rotating the TOTP secret requires proving account ownership first
  // (password, plus the current code when 2FA is already on).
  if (!user?.passwordHash || !(await verifyPassword(String(body["currentPassword"] ?? ""), user.passwordHash))) {
    return c.json({ error: { code: "INVALID_CREDENTIALS", message: "Current password is required to change 2FA" } }, 401);
  }
  if (user.twoFactorEnabled && (!user.totpSecret || !(await verifyTotp(user.totpSecret, String(body["code"] ?? ""))))) {
    return c.json({ error: { code: "INVALID_CODE", message: "Current 2FA code is required to rotate the secret" } }, 401);
  }
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecret: secret, updatedAt: new Date() }).where(eq(users.id, s.userId));
  return c.json({
    data: { secret, otpauthUrl: totpUri(secret, user.email ?? s.userId) },
  });
});

auth.post("/2fa/confirm", authMiddleware, async (c) => {
  const s = c.get("session");
  const body = await readJson(c);
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.userId) });
  if (!user?.totpSecret || !(await verifyTotp(user.totpSecret, String(body["code"] ?? "")))) {
    return c.json({ error: { code: "INVALID_CODE", message: "Invalid verification code" } }, 400);
  }
  await db
    .update(users)
    .set({ twoFactorEnabled: true, updatedAt: new Date() })
    .where(eq(users.id, s.userId));
  return c.json({ data: { ok: true } });
});

auth.post("/2fa/disable", authMiddleware, async (c) => {
  const s = c.get("session");
  const body = await readJson(c);
  const db = getDb(c.env.DB);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.userId) });
  if (!user?.passwordHash || !(await verifyPassword(String(body["password"] ?? ""), user.passwordHash))) {
    return c.json({ error: { code: "INVALID_CREDENTIALS", message: "Password is wrong" } }, 401);
  }
  await db
    .update(users)
    .set({ twoFactorEnabled: false, totpSecret: null, updatedAt: new Date() })
    .where(eq(users.id, s.userId));
  return c.json({ data: { ok: true } });
});

export default auth;
