// Phase 8: notifications — notify() row mapping, list/unread-count/mark-seen/clear routes.
// Auth + getDb are mocked; the D1 layer is a small stateful in-memory fake for the
// notifications table. No network.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import notificationsRouter from "../src/routes/notifications.js";
import { notify } from "../src/lib/notify.js";
import { HttpError } from "../src/lib/filter.js";

type Row = Record<string, any>;

// --- Mocked session ---

const testSession = vi.hoisted(() => ({
  current: {
    userId: "u1",
    tenantId: "t1",
    email: "u1@example.com",
    platformAdmin: false,
    isAccountOwner: true,
  },
}));

vi.mock("../src/lib/auth.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/auth.js")>();
  return {
    ...orig,
    authMiddleware: async (c: any, next: any) => {
      c.set("session", { ...testSession.current });
      await next();
    },
    tenantStatusGuard: async (_c: any, next: any) => {
      await next();
    },
    sessionOf: (c: any) => c.get("session"),
  };
});

// --- In-memory fake for the notifications table ---

const fake = vi.hoisted(() => {
  const store: { rows: Row[]; seq: number } = { rows: [], seq: 0 };

  function colVal(row: Row, name: string): unknown {
    const v = row[name];
    return v instanceof Date ? v.getTime() : v;
  }

  // Compile a drizzle condition into a row predicate (same approach as the
  // scheduling tests: StringChunk/Param/column-name chunks -> JS expression).
  function compileCond(cond: unknown): (row: Row) => boolean {
    const params: unknown[] = [];
    const emit = (node: unknown): string => {
      const parts: string[] = [];
      const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
      for (const ch of chunks) {
        const kind = (ch as { constructor?: { name?: string } })?.constructor?.name;
        if (kind === "StringChunk") {
          parts.push(
            ((ch as { value: string[] }).value.join(""))
              .replace(/\bis null\b/gi, " == null ")
              .replace(/\bis not null\b/gi, " != null ")
              .replace(/\band\b/gi, " && ")
              .replace(/\bor\b/gi, " || ")
              .replace(/\s=\s/g, " === "),
          );
          continue;
        }
        if (kind === "Param") {
          params.push((ch as { value: unknown }).value);
          parts.push(`__p[${params.length - 1}]`);
          continue;
        }
        if (typeof (ch as { name?: unknown }).name === "string") {
          parts.push(`__get(__r,${JSON.stringify((ch as { name: string }).name)})`);
          continue;
        }
        if ((ch as { queryChunks?: unknown }).queryChunks) {
          parts.push(`(${emit(ch)})`);
          continue;
        }
        parts.push("undefined");
      }
      return parts.join("");
    };
    const js = emit(cond);
    const fn = new Function("__r", "__p", "__get", `return (${js});`) as (r: Row, p: unknown[], g: (r: Row, k: string) => unknown) => unknown;
    return (row: Row) => {
      try {
        return !!fn(row, params, colVal);
      } catch {
        return false;
      }
    };
  }

  function matches(row: Row, cond: unknown): boolean {
    if (!cond) return true;
    return compileCond(cond)(row);
  }

  function orderRows(rows: Row[], orderBy: unknown): Row[] {
    const chunks = (orderBy as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    let col: string | null = null;
    let dir = "asc";
    for (const c of chunks) {
      const kind = (c as { constructor?: { name?: string } })?.constructor?.name;
      if (typeof (c as { name?: unknown }).name === "string") col = (c as { name: string }).name;
      else if (kind === "StringChunk") {
        const t = (c as { value: string[] }).value.join("");
        const m = /(desc|asc)/i.exec(t);
        if (m) dir = m[1]!.toLowerCase();
      }
    }
    if (!col) return rows;
    const sorted = [...rows].sort((a, b) => {
      const av = (colVal(a, col!) as number) ?? 0;
      const bv = (colVal(b, col!) as number) ?? 0;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    return dir === "desc" ? sorted.reverse() : sorted;
  }

  function makeDb(): unknown {
    const api: Record<string, unknown> = {
      select: (fields?: unknown) => {
        const q: Record<string, unknown> = { _fields: fields };
        q["from"] = () => q;
        q["where"] = (cond: unknown) => {
          q["_cond"] = cond;
          return q;
        };
        q["orderBy"] = (ob: unknown) => {
          q["_orderBy"] = ob;
          return q;
        };
        q["limit"] = (n: number) => {
          q["_limit"] = n;
          return q;
        };
        q["offset"] = (n: number) => {
          q["_offset"] = n;
          return q;
        };
        q["then"] = (resolve: (v: Row[]) => unknown) => {
          let rows = store.rows.filter((r) => matches(r, q["_cond"]));
          if (q["_orderBy"]) rows = orderRows(rows, q["_orderBy"]);
          if (typeof q["_offset"] === "number") rows = rows.slice(q["_offset"] as number);
          if (typeof q["_limit"] === "number") rows = rows.slice(0, q["_limit"] as number);
          const f = q["_fields"] as Record<string, unknown> | undefined;
          if (f && typeof f === "object" && !Array.isArray(f)) {
            const keys = Object.keys(f);
            rows = rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
          }
          return Promise.resolve(rows).then(resolve);
        };
        return q;
      },
      insert: () => ({
        values: (v: Row) => ({
          returning: () => {
            const row: Row = { id: `n${++store.seq}`, createdAt: new Date(), seenAt: null, ...v };
            store.rows.push(row);
            return Promise.resolve([{ id: row["id"] }]);
          },
        }),
      }),
      update: () => ({
        set: (vals: Row) => ({
          where: (cond: unknown) => {
            let n = 0;
            for (const r of store.rows) {
              if (matches(r, cond)) {
                Object.assign(r, vals);
                n++;
              }
            }
            return Promise.resolve({ rowsAffected: n });
          },
        }),
      }),
      delete: () => ({
        where: (cond: unknown) => {
          const before = store.rows.length;
          store.rows = store.rows.filter((r) => !matches(r, cond));
          return Promise.resolve({ rowsAffected: before - store.rows.length });
        },
      }),
    };
    return api;
  }

  return {
    store,
    reset: () => {
      store.rows = [];
      store.seq = 0;
    },
    makeDb,
  };
});

vi.mock("../src/db/index.js", () => ({ getDb: () => fake.makeDb() }));

function makeApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } }, err.status as 400);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: "x" } }, 500);
  });
  app.route("/", notificationsRouter);
  return app;
}

beforeEach(() => {
  fake.reset();
  testSession.current = {
    userId: "u1",
    tenantId: "t1",
    email: "u1@example.com",
    platformAdmin: false,
    isAccountOwner: true,
  };
});

describe("notify()", () => {
  it("writes one row per recipient with the mapped shape", async () => {
    const db = fake.makeDb() as Parameters<typeof notify>[0];
    const ids = await notify(db, ["u1", "u2"], {
      eventType: "campaign.published",
      category: "campaign",
      severity: "success",
      title: "Campaign is live",
      body: "Your campaign started serving",
      metadata: { campaignName: "Spring" },
      entityType: "campaign",
      entityId: "c1",
      workspaceId: "w1",
      accountId: "t1",
    });
    expect(ids).toHaveLength(2);
    expect(fake.store.rows).toHaveLength(2);
    const r = fake.store.rows[0]!;
    expect(r["type"]).toBe("campaign.published");
    expect(r["title"]).toBe("Campaign is live");
    expect(r["body"]).toBe("Your campaign started serving");
    expect(r["userId"]).toBe("u1");
    expect(r["tenantId"]).toBe("t1");
    expect(r["data"]).toMatchObject({
      category: "campaign",
      severity: "success",
      entityType: "campaign",
      entityId: "c1",
      workspaceId: "w1",
      campaignName: "Spring",
    });
    expect(r["seenAt"]).toBeNull();
  });

  it("falls back to the title when body is empty and drops falsy recipients", async () => {
    const db = fake.makeDb() as Parameters<typeof notify>[0];
    const ids = await notify(db, ["u1", "", null as unknown as string], {
      eventType: "x",
      title: "Only title",
    });
    expect(ids).toHaveLength(1);
    expect(fake.store.rows[0]!["body"]).toBe("Only title");
  });

  it("returns [] without writing when there are no recipients", async () => {
    const db = fake.makeDb() as Parameters<typeof notify>[0];
    expect(await notify(db, [], { eventType: "x", title: "t" })).toEqual([]);
    expect(fake.store.rows).toHaveLength(0);
  });
});

describe("routes", () => {
  it("lists newest first and counts unread", async () => {
    const db = fake.makeDb() as Parameters<typeof notify>[0];
    await notify(db, "u1", { eventType: "a", title: "First" });
    await notify(db, "u1", { eventType: "b", title: "Second" });
    await notify(db, "u2", { eventType: "c", title: "Other user" });

    const app = makeApp();
    const list = await app.request("/notifications", {}, { DB: {} } as any);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: Array<{ title: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]!.title).toBe("Second");

    const count = await app.request("/notifications/unread/count", {}, { DB: {} } as any);
    expect(((await count.json()) as { data: { count: number } }).data.count).toBe(2);
  });

  it("mark-seen decrements the unread count", async () => {
    const db = fake.makeDb() as Parameters<typeof notify>[0];
    const [id1] = await notify(db, "u1", { eventType: "a", title: "One" });
    await notify(db, "u1", { eventType: "b", title: "Two" });

    const app = makeApp();
    const res = await app.request("/notifications/mark-seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id1] }),
    }, { DB: {} } as any);
    expect(res.status).toBe(200);

    const count = await app.request("/notifications/unread/count", {}, { DB: {} } as any);
    expect(((await count.json()) as { data: { count: number } }).data.count).toBe(1);
  });

  it("mark-seen without ids marks everything seen", async () => {
    const db = fake.makeDb() as Parameters<typeof notify>[0];
    await notify(db, "u1", { eventType: "a", title: "One" });
    await notify(db, "u1", { eventType: "b", title: "Two" });

    const app = makeApp();
    await app.request("/notifications/mark-seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, { DB: {} } as any);
    const count = await app.request("/notifications/unread/count", {}, { DB: {} } as any);
    expect(((await count.json()) as { data: { count: number } }).data.count).toBe(0);
  });

  it("DELETE clears the user's notifications only", async () => {
    const db = fake.makeDb() as Parameters<typeof notify>[0];
    await notify(db, "u1", { eventType: "a", title: "Mine" });
    await notify(db, "u2", { eventType: "b", title: "Theirs" });

    const app = makeApp();
    const res = await app.request("/notifications", { method: "DELETE" }, { DB: {} } as any);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { cleared: boolean } }).data.cleared,
    ).toBe(true);
    expect(fake.store.rows).toHaveLength(1);
    expect(fake.store.rows[0]!["userId"]).toBe("u2");
  });
});
