// Phase 8: scheduling routes — create/get/cancel lifecycle, publish-now,
// calendar window filtering, tenant isolation.
// The D1 layer is a stateful in-memory fake that evaluates the drizzle SQL
// conditions the routes actually use (eq/ne/gte/lte/in/and/or/is-null,
// orderBy, limit); auth + post-publisher are mocked. No network.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HttpError } from "../src/lib/filter.js";
import schedulingRouter from "../src/routes/scheduling.js";
import { publishScheduledPost } from "../src/jobs/post-publisher.js";
import {
  adPlatforms,
  platformConnections,
  posts,
  scheduledPosts,
  workspaceMembers,
  workspaces,
} from "../src/db/schema/index.js";

// --- Session the mocked auth middleware attaches ---

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
    getJwtSecret: () => "test-secret-for-unit-tests-32-bytes!!",
  };
});

// --- Stateful in-memory fake for drizzle, with a mini SQL evaluator ---

const fakeFactory = vi.hoisted(() => {
  const norm = (v: any) => (v instanceof Date ? v.getTime() : v);
  const getVal = (row: any, key: string) => norm(row?.[key]);
  const inList = (v: any, arr: any[]) => arr.some((p) => norm(p) === norm(v));

  const transformText = (raw: string) =>
    raw
      .replace(/<>/g, "!==")
      .replace(/\s=\s/g, " === ")
      .replace(/\bis not null\b/gi, " != null ")
      .replace(/\bis null\b/gi, " == null ")
      .replace(/\band\b/gi, " && ")
      .replace(/\bor\b/gi, " || ");

  class Compiler {
    params: any[] = [];
    emit(node: any): string {
      const parts: string[] = [];
      const chunks: any[] = node?.queryChunks ?? [];
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const kind = ch?.constructor?.name;
        if (kind === "StringChunk") {
          const raw = (ch.value as string[]).join("");
          if (/^\s*in\s*$/i.test(raw)) {
            // "col in (...)" — pop the already-emitted left operand. In
            // drizzle >= 0.44 the values arrive as a raw Array chunk of Params.
            const left = parts.pop() ?? "undefined";
            const idxs: number[] = [];
            const takeParam = (p: any) => {
              this.params.push(p.value);
              idxs.push(this.params.length - 1);
            };
            i++;
            for (; i < chunks.length; i++) {
              const c2 = chunks[i];
              if (Array.isArray(c2)) {
                for (const p of c2) if (p?.constructor?.name === "Param") takeParam(p);
                continue;
              }
              const k2 = c2?.constructor?.name;
              if (k2 === "Param") takeParam(c2);
              else if (k2 === "StringChunk") {
                if ((c2.value as string[]).join("").includes(")")) break;
              } else break;
            }
            parts.push(`__in(${left},[${idxs.map((n) => `__p[${n}]`).join(",")}])`);
            continue;
          }
          parts.push(transformText(raw));
          continue;
        }
        if (kind === "Param") {
          this.params.push(ch.value);
          parts.push(`__p[${this.params.length - 1}]`);
          continue;
        }
        if (typeof ch?.name === "string") {
          parts.push(`__get(__r,${JSON.stringify(ch.name)})`);
          continue;
        }
        if (ch?.queryChunks) {
          parts.push(`(${this.emit(ch)})`);
          continue;
        }
        parts.push("undefined");
      }
      return parts.join("");
    }
  }

  function compilePredicate(node: any): (row: any) => boolean {
    const comp = new Compiler();
    const js = comp.emit(node);
    const params = comp.params;
    const fn = new Function("__r", "__p", "__get", "__in", `return (${js});`) as any;
    return (row: any) => {
      try {
        return !!fn(row, params, getVal, inList);
      } catch {
        return false;
      }
    };
  }

  function orderSpec(node: any): { key: string; dir: 1 | -1 } | null {
    let key: string | null = null;
    let dir: 1 | -1 = 1;
    for (const ch of node?.queryChunks ?? []) {
      const kind = ch?.constructor?.name;
      if (kind === "StringChunk") {
        const t = (ch.value as string[]).join("").toLowerCase();
        if (t.includes("desc")) dir = -1;
        else if (t.includes("asc")) dir = 1;
      } else if (typeof ch?.name === "string" && key === null) {
        key = ch.name;
      }
    }
    return key ? { key, dir } : null;
  }

  // Mutable store shared by every getDb() within a test.
  const store = { tables: new Map<unknown, any[]>(), seq: 0 };

  function reset() {
    store.tables = new Map();
    store.seq = 0;
  }

  class Q {
    kind: string;
    table: any = null;
    cond: any = null;
    order: any[] = [];
    limitN: number | null = null;
    ins: any = null;
    setVals: any = null;
    constructor(kind: string, table?: any) {
      this.kind = kind;
      this.table = table ?? null;
    }
    from(t: any) {
      this.table = t;
      return this;
    }
    where(c: any) {
      this.cond = c;
      return this;
    }
    orderBy(...o: any[]) {
      this.order = o.flat();
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    set(v: any) {
      this.setVals = v;
      return this;
    }
    values(v: any) {
      this.ins = v;
      return this;
    }
    returning() {
      const rows = Array.isArray(this.ins) ? this.ins : [this.ins];
      const created = rows.map((v: any) => {
        const row = { ...(v ?? {}) };
        if (row.id == null) row.id = `fake-${++store.seq}`;
        const arr = store.tables.get(this.table) ?? [];
        arr.push(row);
        store.tables.set(this.table, arr);
        return { ...row };
      });
      return Promise.resolve(created);
    }
    exec(): any[] {
      const all = store.tables.get(this.table) ?? [];
      if (this.kind === "update") {
        const pred = this.cond ? compilePredicate(this.cond) : () => true;
        for (const r of all) if (pred(r)) Object.assign(r, this.setVals ?? {});
        return [];
      }
      if (this.kind === "delete") {
        const pred = this.cond ? compilePredicate(this.cond) : () => true;
        const kept = all.filter((r) => !pred(r));
        store.tables.set(this.table, kept);
        return [];
      }
      let rows = this.cond ? all.filter(compilePredicate(this.cond)) : [...all];
      for (const o of this.order) {
        const spec = orderSpec(o);
        if (spec) {
          const { key, dir } = spec;
          rows = [...rows].sort((a, b) => {
            const av = norm(a?.[key]);
            const bv = norm(b?.[key]);
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
          });
        }
      }
      if (this.limitN != null) rows = rows.slice(0, this.limitN);
      return rows.map((r) => ({ ...r }));
    }
    then(a: any, b: any) {
      return Promise.resolve(this.exec()).then(a, b);
    }
    catch(a: any) {
      return Promise.resolve(this.exec()).catch(a);
    }
  }

  return {
    reset,
    create: () =>
      ({
        insert: (t: any) => new Q("insert", t),
        update: (t: any) => new Q("update", t),
        select: (_c?: any) => new Q("select"),
        delete: (t: any) => new Q("delete", t),
      }) as any,
  };
});

vi.mock("../src/db/index.js", () => ({ getDb: () => fakeFactory.create() }));

vi.mock("../src/jobs/post-publisher.js", () => ({
  publishScheduledPost: vi.fn(async () => ({ published: true, externalPostId: "ext-1" })),
}));

// --- App wrapper with HttpError mapping (like src/index.ts) ---

function makeApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: { code: err.code ?? "ERROR", message: err.message } },
        err.status as any,
      );
    }
    throw err;
  });
  app.route("/", schedulingRouter);
  return app;
}

const app = makeApp();
const j = async (res: Response): Promise<any> => (await res.json()) as any;
// Hono only populates c.env when env is passed to app.request
const TEST_ENV = { DB: {} as any };
const getReq = (path: string) => app.request(path, { method: "GET" }, TEST_ENV);
const NOW = new Date("2026-10-03T12:00:00.000Z");

async function seedBase() {
  const db: any = fakeFactory.create();
  await db
    .insert(workspaces)
    .values({ id: "ws1", name: "WS One", account_id: "t1" })
    .returning();
  await db
    .insert(workspaceMembers)
    .values({ id: "wm1", workspace_id: "ws1", member_id: "u1", role: "owner", status: "active", account_id: "t1" })
    .returning();
  await db
    .insert(posts)
    .values({ id: "p1", workspace_id: "ws1", title: "Hello post", status: "draft", account_id: "t1" })
    .returning();
  await db
    .insert(adPlatforms)
    .values({ id: "plat-ig", code: "instagram", name: "Instagram" })
    .returning();
  await db
    .insert(platformConnections)
    .values({
      id: "conn1",
      workspace_id: "ws1",
      platform_id: "plat-ig",
      account_id: "t1",
      status: "healthy",
    })
    .returning();
}

function postJson(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    TEST_ENV,
  );
}

beforeEach(() => {
  fakeFactory.reset();
  testSession.current = {
    userId: "u1",
    tenantId: "t1",
    email: "u1@example.com",
    platformAdmin: false,
    isAccountOwner: true,
  };
  vi.clearAllMocks();
});

describe("scheduling routes", () => {
  it("create -> get -> cancel lifecycle flips status", async () => {
    await seedBase();
    const createRes = await postJson("/scheduled-posts", {
      workspaceId: "ws1",
      postId: "p1",
      scheduledAt: "2026-10-10T09:00:00.000Z",
      platformSlug: "instagram",
      priority: "high",
    });
    expect(createRes.status).toBe(201);
    const created = (await j(createRes)).data;
    expect(created.status).toBe("pending"); // queued -> pending UI mapping
    expect(created.platformSlug).toBe("instagram");
    expect(created.platformName).toBe("Instagram");
    expect(created.connectionId).toBe("conn1");
    expect(created.postName).toBe("Hello post");
    expect(created.account_id).toBeUndefined(); // internal fields stay out of the shape
    expect(created.priority).toBe("high");

    const getRes = await getReq(`/scheduled-posts/${created.id}`);
    expect(getRes.status).toBe(200);
    expect((await j(getRes)).data.id).toBe(created.id);

    const cancelRes = await postJson(`/scheduled-posts/${created.id}/cancel`, {});
    expect(cancelRes.status).toBe(200);
    expect((await j(cancelRes)).data.status).toBe("cancelled");

    const afterRes = await getReq(`/scheduled-posts/${created.id}`);
    expect((await j(afterRes)).data.status).toBe("cancelled");

    // the post drops back to draft
    const db: any = fakeFactory.create();
    const postRows = await db.select().from(posts);
    expect(postRows.find((p: any) => p.id === "p1").status).toBe("draft");
  });

  it("publish-now on an already-published row returns 409", async () => {
    await seedBase();
    const db: any = fakeFactory.create();
    await db
      .insert(scheduledPosts)
      .values({
        id: "sp-pub",
        workspace_id: "ws1",
        post_id: "p1",
        platform_id: "plat-ig",
        connection_id: "conn1",
        account_id: "t1",
        scheduledAt: NOW,
        status: "published",
      })
      .returning();
    const res = await postJson("/scheduled-posts/sp-pub/publish-now", {});
    expect(res.status).toBe(409);
    expect((await j(res)).error.code).toBe("ALREADY_PUBLISHED");
    expect(publishScheduledPost).not.toHaveBeenCalled();
  });

  it("publish-now on a queued row resets and publishes inline", async () => {
    await seedBase();
    const createRes = await postJson("/scheduled-posts", {
      workspaceId: "ws1",
      postId: "p1",
      scheduledAt: "2026-10-10T09:00:00.000Z",
      platformId: "plat-ig",
    });
    const created = (await j(createRes)).data;
    const res = await postJson(`/scheduled-posts/${created.id}/publish-now`, {});
    expect(res.status).toBe(200);
    const data = (await j(res)).data;
    expect(data.result).toEqual({ published: true, externalPostId: "ext-1" });
    expect(publishScheduledPost).toHaveBeenCalledTimes(1);
    const args = (publishScheduledPost as any).mock.calls[0];
    expect(args[3]).toBe(created.id); // called with the row id
  });

  it("calendar filters by date window and excludes cancelled", async () => {
    await seedBase();
    const db: any = fakeFactory.create();
    await db
      .insert(scheduledPosts)
      .values([
        { id: "sp-in", workspace_id: "ws1", post_id: "p1", platform_id: "plat-ig", account_id: "t1", scheduledAt: new Date("2026-10-05T10:00:00Z"), status: "queued" },
        { id: "sp-out", workspace_id: "ws1", post_id: "p1", platform_id: "plat-ig", account_id: "t1", scheduledAt: new Date("2026-11-05T10:00:00Z"), status: "queued" },
        { id: "sp-can", workspace_id: "ws1", post_id: "p1", platform_id: "plat-ig", account_id: "t1", scheduledAt: new Date("2026-10-06T10:00:00Z"), status: "cancelled" },
      ])
      .returning();
    const res = await getReq(
      "/scheduled-posts/calendar?workspaceId=ws1&startDate=2026-10-01&endDate=2026-10-31",
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.truncated).toBe(false);
    expect(body.data.events.map((e: any) => e.id)).toEqual(["sp-in"]);
    expect(body.data.events[0]).toMatchObject({
      postId: "p1",
      postName: "Hello post",
      platformId: "plat-ig",
      platformName: "Instagram",
      platformSlug: "instagram",
      status: "pending",
    });
  });

  it("list endpoint pages and maps status=pending to queued", async () => {
    await seedBase();
    const db: any = fakeFactory.create();
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `sp-${i}`,
      workspace_id: "ws1",
      post_id: "p1",
      platform_id: "plat-ig",
      account_id: "t1",
      scheduledAt: new Date(NOW.getTime() + i * 3600_000),
      status: i % 2 === 0 ? "queued" : "failed",
    }));
    await db.insert(scheduledPosts).values(rows).returning();

    const page1 = await getReq("/scheduled-posts?workspaceId=ws1&limit=2&page=1");
    const b1 = await j(page1);
    expect(b1.meta).toMatchObject({ total: 5, page: 1, limit: 2, pages: 3 });
    expect(b1.data).toHaveLength(2);

    const pending = await getReq("/scheduled-posts?workspaceId=ws1&status=pending");
    const bp = await j(pending);
    expect(bp.meta.total).toBe(3);
    expect(bp.data.every((r: any) => r.status === "pending")).toBe(true);
  });

  it("wrong-tenant access returns 404", async () => {
    await seedBase();
    const db: any = fakeFactory.create();
    await db
      .insert(scheduledPosts)
      .values({
        id: "sp-other",
        workspace_id: "ws1",
        post_id: "p1",
        account_id: "t1",
        scheduledAt: NOW,
        status: "queued",
      })
      .returning();

    testSession.current = {
      userId: "intruder",
      tenantId: "t2",
      email: "x@example.com",
      platformAdmin: false,
      isAccountOwner: false,
    };

    const getRes = await getReq("/scheduled-posts/sp-other");
    expect(getRes.status).toBe(404);

    const listRes = await getReq("/scheduled-posts?workspaceId=ws1");
    expect(listRes.status).toBe(404);

    const cancelRes = await postJson("/scheduled-posts/sp-other/cancel", {});
    expect(cancelRes.status).toBe(404);
  });

  it("create fails 400 with no platform connection and 404 for a foreign post", async () => {
    const db: any = fakeFactory.create();
    await db.insert(workspaces).values({ id: "ws2", name: "No conn", account_id: "t1" }).returning();
    await db
      .insert(posts)
      .values({ id: "p2", workspace_id: "ws2", title: "Lonely", status: "draft", account_id: "t1" })
      .returning();

    const noConn = await postJson("/scheduled-posts", {
      workspaceId: "ws2",
      postId: "p2",
      scheduledAt: "2026-10-10T09:00:00.000Z",
    });
    expect(noConn.status).toBe(400);
    expect((await j(noConn)).error.code).toBe("NO_CONNECTION");

    await seedBase();
    const foreignPost = await postJson("/scheduled-posts", {
      workspaceId: "ws1",
      postId: "p2", // belongs to ws2
      scheduledAt: "2026-10-10T09:00:00.000Z",
    });
    expect(foreignPost.status).toBe(404);
  });

  it("PATCH reschedules a queued post; DELETE removes it", async () => {
    await seedBase();
    const createRes = await postJson("/scheduled-posts", {
      workspaceId: "ws1",
      postId: "p1",
      scheduledAt: "2026-10-10T09:00:00.000Z",
      platformSlug: "instagram",
    });
    expect(createRes.status).toBe(201);
    const created = (await j(createRes)).data;

    const patchRes = await app.request(
      `/scheduled-posts/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduledAt: "2026-11-01T12:00:00.000Z", priority: "low" }),
      },
      TEST_ENV,
    );
    expect(patchRes.status).toBe(200);
    const patched = (await j(patchRes)).data;
    expect(new Date(patched.scheduledAt).toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(patched.priority).toBe("low");

    const delRes = await app.request(`/scheduled-posts/${created.id}`, { method: "DELETE" }, TEST_ENV);
    expect(delRes.status).toBe(200);
    expect((await j(delRes)).data.deleted).toBe(true);

    const gone = await getReq(`/scheduled-posts/${created.id}`);
    expect(gone.status).toBe(404);
  });

  it("PATCH/DELETE on missing or published rows fail", async () => {
    await seedBase();
    const db: any = fakeFactory.create();
    await db
      .insert(scheduledPosts)
      .values({ id: "sp-pub", workspace_id: "ws1", post_id: "p1", status: "published", scheduledAt: new Date(), priority: "normal", attempts: 0, account_id: "t1" })
      .returning();

    const patchMissing = await app.request("/scheduled-posts/nope", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }, TEST_ENV);
    expect(patchMissing.status).toBe(404);

    const patchPub = await app.request("/scheduled-posts/sp-pub", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priority: "high" }) }, TEST_ENV);
    expect(patchPub.status).toBe(409);

    const delPub = await app.request("/scheduled-posts/sp-pub", { method: "DELETE" }, TEST_ENV);
    expect(delPub.status).toBe(409);
  });
});
