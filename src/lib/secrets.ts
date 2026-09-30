// AES-256-GCM at-rest encryption for third-party secrets, via WebCrypto.
// Keeps the old `enc:v1:<iv-b64>:<tag-b64>:<ct-b64>` format so the concept (and
// any tooling that recognizes it) ports cleanly. Key = SHA-256(SECRET_KEY).

const PREFIX = "enc:v1:";
const MASK = "••••••••";

export const isEncrypted = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith(PREFIX);

export const isMasked = (v: unknown): boolean => v === MASK;

async function aesKey(secretKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secretKey),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptSecret(plain: string, secretKey: string): Promise<string> {
  if (plain == null || plain === "" || isEncrypted(plain)) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctAndTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      await aesKey(secretKey),
      new TextEncoder().encode(String(plain)),
    ),
  );
  // WebCrypto appends the 16-byte auth tag to the ciphertext; split them out
  // to match the legacy iv:tag:ct layout.
  const ct = ctAndTag.slice(0, ctAndTag.length - 16);
  const tag = ctAndTag.slice(ctAndTag.length - 16);
  return `${PREFIX}${b64encode(iv)}:${b64encode(tag)}:${b64encode(ct)}`;
}

export async function decryptSecret(v: string, secretKey: string): Promise<string> {
  if (!isEncrypted(v)) return v;
  const [ivB64, tagB64, ctB64] = v.slice(PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed encrypted value");
  const iv = b64decode(ivB64);
  const tag = b64decode(tagB64);
  const ct = b64decode(ctB64);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct, 0);
  combined.set(tag, ct.length);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    await aesKey(secretKey),
    combined as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// Which fields hold secrets, per collection (Drizzle property names).
export const SECRET_FIELDS: Record<string, string[]> = {
  platform_configs: ["clientSecret", "developerToken"],
  platform_connections: ["accessToken", "refreshToken"],
  billing_settings: ["stripeSecretKey", "stripeWebhookSecret"],
  ai_settings: ["textApiKey", "imageApiKey"],
};

/**
 * Encrypt secret fields on a write payload. Idempotent: already-encrypted or
 * masked values pass through untouched (never encrypt the mask — that
 * destroyed live OAuth tokens once in the old backend).
 */
export async function encryptRowSecrets(
  collection: string,
  values: Record<string, unknown>,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const fields = SECRET_FIELDS[collection];
  if (!fields) return values;
  const out = { ...values };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string" && v !== "" && !isEncrypted(v) && !isMasked(v)) {
      out[f] = await encryptSecret(v, secretKey);
    }
  }
  return out;
}

/** Mask secret fields on a row before it leaves the API. */
export function maskRowSecrets<T extends Record<string, unknown>>(
  collection: string,
  row: T,
): T {
  const fields = SECRET_FIELDS[collection];
  if (!fields) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (out[f] != null && out[f] !== "") out[f] = MASK;
  }
  return out as T;
}

/** Decrypt secret fields for server-side use only — never return these rows to clients. */
export async function decryptRowSecrets<T extends Record<string, unknown>>(
  collection: string,
  row: T,
  secretKey: string,
): Promise<T> {
  const fields = SECRET_FIELDS[collection];
  if (!fields) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string" && isEncrypted(v)) {
      out[f] = await decryptSecret(v, secretKey);
    }
  }
  return out as T;
}
