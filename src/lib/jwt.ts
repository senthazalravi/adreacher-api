// HMAC-SHA256 JWTs via WebCrypto. Payload: { sub, tenantId, type, iat, exp }.
// type is "access" (7 days), "refresh" (30 days) or "2fa" (5 minutes).

export type JwtType = "access" | "refresh" | "2fa";

export interface JwtPayload {
  sub: string;
  tenantId: string;
  type: JwtType;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

const ACCESS_TTL = 7 * 24 * 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const TWO_FA_TTL = 5 * 60;

const te = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signJwt(
  claims: { sub: string; tenantId: string; type: JwtType; [key: string]: unknown },
  secret: string,
  opts?: { ttl?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl =
    opts?.ttl ??
    (claims.type === "access" ? ACCESS_TTL : claims.type === "refresh" ? REFRESH_TTL : TWO_FA_TTL);
  const payload: JwtPayload = { ...claims, iat: now, exp: now + ttl };
  const header = b64urlEncode(te.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64urlEncode(te.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), te.encode(`${header}.${body}`));
  return `${header}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Returns the payload, or null when the signature is bad, it expired, or the shape is wrong. */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!header || !body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(sig),
      te.encode(`${header}.${body}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (
    typeof payload.sub !== "string" ||
    typeof payload.tenantId !== "string" ||
    typeof payload.exp !== "number" ||
    !["access", "refresh", "2fa"].includes(payload.type as string)
  ) {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload as JwtPayload;
}
