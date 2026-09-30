// Unit tests for the auth crypto primitives (password hashing, JWT, TOTP).
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { signJwt, verifyJwt } from "../src/lib/jwt.js";
import { generateTotpSecret, totpCode, verifyTotp, totpUri } from "../src/lib/totp.js";
import { encryptSecret, decryptSecret, isEncrypted, maskRowSecrets } from "../src/lib/secrets.js";

describe("password", () => {
  it("hashes and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$210000$abc")).toBe(false);
  });
});

describe("jwt", () => {
  const secret = "test-secret-key-for-unit-tests-32bytes!";

  it("round-trips access tokens", async () => {
    const token = await signJwt({ sub: "u1", tenantId: "t1", type: "access" }, secret);
    const payload = await verifyJwt(token, secret);
    expect(payload?.sub).toBe("u1");
    expect(payload?.tenantId).toBe("t1");
    expect(payload?.type).toBe("access");
  });

  it("rejects wrong secret, tampering, and expired tokens", async () => {
    const token = await signJwt({ sub: "u1", tenantId: "t1", type: "access" }, secret);
    expect(await verifyJwt(token, "wrong-secret")).toBeNull();
    const tampered = token.slice(0, -2) + "AA";
    expect(await verifyJwt(tampered, secret)).toBeNull();
    const expired = await signJwt({ sub: "u1", tenantId: "t1", type: "access" }, secret, { ttl: -10 });
    expect(await verifyJwt(expired, secret)).toBeNull();
  });
});

describe("totp", () => {
  // RFC 6238 test vector (SHA-1, secret "12345678901234567890").
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches the RFC 6238 vector", async () => {
    // T = 59 → counter 1 → 94287082 → last 6 digits 287082
    const code = await totpCode(rfcSecret, 1);
    expect(code).toBe("287082");
  });

  it("generates, verifies, and rejects bad codes", async () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThan(16);
    const uri = totpUri(secret, "test@example.com", "AdReacher");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    const step = Math.floor(Date.now() / 30_000);
    const code = await totpCode(secret, step);
    expect(await verifyTotp(secret, code)).toBe(true);
    expect(await verifyTotp(secret, "000000")).toBe(false);
  });
});

describe("secrets", () => {
  const key = "0123456789abcdef0123456789abcdef";

  it("encrypts and decrypts with enc:v1 format", async () => {
    const enc = await encryptSecret("sk-live-123", key);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(isEncrypted(enc)).toBe(true);
    expect(await decryptSecret(enc, key)).toBe("sk-live-123");
  });

  it("decryptSecret passes plain values through", async () => {
    expect(await decryptSecret("plain", key)).toBe("plain");
  });

  it("masks secret fields on rows", () => {
    const row = maskRowSecrets("platform_connections", { id: "1", accessToken: "secret", name: "n" });
    expect(row.accessToken).toBe("••••••••");
    expect(row.name).toBe("n");
  });
});
