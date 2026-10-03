// Phase 8: super-admin route — pure guard logic, shadow JWT round-trip, CSV.
// DB-backed endpoints are exercised through the same middleware chain the
// worker uses; no network calls happen here.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { signJwt, verifyJwt } from "../src/lib/jwt.js";
import { requireRole, type Session } from "../src/lib/auth.js";
import { isPlatformAdmin, csvEscape, auditLogsToCsv } from "../src/routes/super-admin.js";
import type { Env } from "../src/index.js";

const adminSession: Session = {
  userId: "admin-1",
  tenantId: "t-admin",
  email: "admin@example.com",
  platformAdmin: true,
  isAccountOwner: true,
};

const userSession: Session = {
  userId: "user-1",
  tenantId: "t-1",
  email: "user@example.com",
  platformAdmin: false,
  isAccountOwner: false,
};

/** Minimal app: fake session injector + the real requireRole guard. */
function guardedApp(session: Session) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/protected/*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.use("/protected/*", requireRole("platformAdmin"));
  app.get("/protected/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("requireRole platformAdmin guard (as mounted by super-admin.ts)", () => {
  it("allows platform admins through", async () => {
    const res = await guardedApp(adminSession).request("/protected/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("denies non-admins with 403 FORBIDDEN", async () => {
    const res = await guardedApp(userSession).request("/protected/ping");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("isPlatformAdmin helper mirrors the guard", () => {
    expect(isPlatformAdmin(adminSession)).toBe(true);
    expect(isPlatformAdmin(userSession)).toBe(false);
  });
});

describe("shadow JWT round-trip", () => {
  const secret = "test-jwt-secret";

  it("carries shadow:true + shadowedBy through sign/verify", async () => {
    const token = await signJwt(
      { sub: "user-1", tenantId: "t-1", type: "access", shadow: true, shadowedBy: "admin-1" },
      secret,
    );
    const payload = await verifyJwt(token, secret);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe("user-1");
    expect(payload?.tenantId).toBe("t-1");
    expect(payload?.type).toBe("access");
    expect(payload?.shadow).toBe(true);
    expect(payload?.shadowedBy).toBe("admin-1");
  });

  it("rejects a shadow token signed with a different secret", async () => {
    const token = await signJwt(
      { sub: "user-1", tenantId: "t-1", type: "access", shadow: true, shadowedBy: "admin-1" },
      secret,
    );
    expect(await verifyJwt(token, "wrong-secret")).toBeNull();
  });

  it("a normal token has no shadow claim", async () => {
    const token = await signJwt({ sub: "user-1", tenantId: "t-1", type: "access" }, secret);
    const payload = await verifyJwt(token, secret);
    expect(payload).not.toBeNull();
    expect(payload?.shadow).toBeUndefined();
  });
});

describe("csvEscape (audit-log CSV export)", () => {
  it("leaves plain values alone", () => {
    expect(csvEscape("hello")).toBe("hello");
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(true)).toBe("true");
  });

  it("blanks null/undefined", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("quotes cells containing commas, quotes, CR or LF", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("a\rb")).toBe('"a\rb"');
  });

  it("serializes objects as JSON (then quotes)", () => {
    expect(csvEscape({ ok: true })).toBe('"{""ok"":true}"');
  });

  it("serializes dates as ISO strings", () => {
    expect(csvEscape(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("auditLogsToCsv", () => {
  it("emits the header plus one RFC-4180 line per row", () => {
    const csv = auditLogsToCsv([
      {
        createdAt: new Date("2026-10-03T10:00:00.000Z"),
        action: "tenant.status.updated",
        entityType: "tenant",
        entityId: "t-1",
        userId: "admin-1",
        tenantId: "t-admin",
        meta: { to: "suspended" },
      },
      {
        createdAt: new Date("2026-10-03T11:00:00.000Z"),
        action: "login",
        entityType: null,
        entityId: null,
        userId: "user-1",
        tenantId: null,
        meta: null,
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("createdAt,action,entityType,entityId,userId,tenantId,meta");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("tenant.status.updated");
    expect(lines[1]).toContain('"{""to"":""suspended""}"');
    expect(lines[1]).toContain("2026-10-03T10:00:00.000Z");
    expect(lines[2]).toContain("login");
    // Nulls become empty cells, not the string "null".
    expect(lines[2]).not.toContain("null");
  });
});
