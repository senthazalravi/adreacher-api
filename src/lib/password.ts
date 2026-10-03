// PBKDF2-HMAC-SHA256 password hashing via WebCrypto (no Node-only deps).
// Stored format: pbkdf2$<iterations>$<salt-b64>$<hash-b64>

// Workers' WebCrypto caps PBKDF2 at 100,000 iterations — 210k (OWASP) throws.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const te = new TextEncoder();

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

/** Constant-time comparison to avoid timing side channels. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [_prefix, iterStr, saltB64, hashB64] = parts;
  if (!iterStr || !saltB64 || !hashB64) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = b64decode(saltB64);
  const expected = b64decode(hashB64);
  const actual = await pbkdf2(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}
