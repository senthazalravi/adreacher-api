// RFC 6238 TOTP (SHA-1, 30s step) via WebCrypto. No dependencies.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20): string {
  const rnd = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of rnd) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Compute the 6-digit code for a given time step (exported for tests). */
export async function totpCode(secret: string, timeStep: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const msg = new Uint8Array(8);
  let t = timeStep;
  for (let i = 7; i >= 0; i--) {
    msg[i] = t & 255;
    t = Math.floor(t / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg as BufferSource));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code =
    (((mac[offset] ?? 0) & 0x7f) << 24) | ((mac[offset + 1] ?? 0) << 16) | ((mac[offset + 2] ?? 0) << 8) | (mac[offset + 3] ?? 0);
  return String(code % 1_000_000).padStart(6, "0");
}

/** Verify a user-supplied code, accepting ±`window` steps of clock skew. */
export async function verifyTotp(secret: string, token: string, window = 1): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;
  const step = Math.floor(Date.now() / 30_000);
  for (let d = -window; d <= window; d++) {
    if ((await totpCode(secret, step + d)) === token) return true;
  }
  return false;
}

/** otpauth:// URI for QR-code enrollment. */
export function totpUri(secret: string, account: string, issuer = "AdReacher"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
