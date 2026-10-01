// Phase 7: scheduled jobs — recordRun ledger, cron dispatch routing,
// post-publisher backoff, connection-health status flips.
// The D1 layer is faked with a minimal chainable stub; no network.
import { describe, expect, it, vi, afterEach } from "vitest";
import { recordRun } from "../src/lib/job-runs.js";
import { JOBS, jobNameForCron, dispatchCron } from "../src/jobs/index.js";
import { retryDelayMinutes } from "../src/jobs/post-publisher.js";
import { runConnectionHealth } from "../src/jobs/connection-health.js";
import { getValidAccessToken } from "../src/lib/connections.js";
import { jobRuns, platformConnections, tenants, workspaceMembers } from "../src/db/schema/index.js";

vi.mock("../src/lib/connections.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/connections.js")>();
  return { ...orig, getValidAccessToken: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Minimal chainable fake for the Drizzle calls the jobs make ---

interface FakeCall {
  op: "insert" | "update";
  table: unknown;
  values: unknown;
}

function fakeDb(config: {
  insertRows?: (table: unknown, values: unknown) => unknown[];
  selectRows?: (table: unknown) => unknown[];
}) {
  const calls: FakeCall[] = [];
  class Q {
    rows: unknown[];
    table: unknown;
    insVals: unknown;
    constructor(rows: unknown[], table?: unknown) {
      this.rows = rows;
      this.table = table;
    }
    from(t: unknown) {
      this.table = t;
      this.rows = config.selectRows?.(t) ?? [];
      return this;
    }
    leftJoin() {
      return this;
    }
    where() {
      return this;
    }
    orderBy() {
      return this;
    }
    limit() {
      return this;
    }
    set(v: unknown) {
      calls.push({ op: "update", table: this.table, values: v });
      return this;
    }
    values(v: unknown) {
      this.insVals = v;
      calls.push({ op: "insert", table: this.table, values: v });
      return this;
    }
    returning() {
      return Promise.resolve(config.insertRows?.(this.table, this.insVals) ?? this.rows);
    }
    then(a: any, b: any) {
      return Promise.resolve(this.rows).then(a, b);
    }
    catch(a: any) {
      return Promise.resolve(this.rows).catch(a);
    }
  }
  const db = {
    insert: (t: unknown) => new Q([], t),
    update: (t: unknown) => new Q([], t),
    select: (_c?: unknown) => new Q([]),
    delete: (t: unknown) => new Q([], t),
  };
  return { db: db as any, calls };
}

// --- recordRun ---

describe("recordRun", () => {
  it("writes a start row and marks it completed on success", async () => {
    const { db, calls } = fakeDb({
      insertRows: () => [{ id: "run-1" }],
      selectRows: () => [],
    });
    const result = await recordRun(db, "analytics-sync", async () => ({ synced: 5, errors: 0 }));
    expect(result).toEqual({ synced: 5, errors: 0 });
    const insert = calls.find((c) => c.op === "insert");
    expect(insert?.table).toBe(jobRuns);
    expect(insert?.values).toMatchObject({ name: "analytics-sync", status: "processing" });
    const update = calls.find((c) => c.op === "update");
    expect(update?.values).toMatchObject({ status: "completed" });
    expect((update?.values as any).result.synced).toBe(5);
    expect((update?.values as any).durationMs).toEqual(expect.any(Number));
  });

  it("marks the run failed when the job reports item errors", async () => {
    const { db, calls } = fakeDb({ insertRows: () => [{ id: "run-2" }], selectRows: () => [] });
    const result = await recordRun(db, "post-publisher", async () => ({ due: 3, published: 1, failed: 2 }));
    expect(result.failed).toBe(2);
    const update = calls.find((c) => c.op === "update");
    expect(update?.values).toMatchObject({ status: "failed" });
    expect((update?.values as any).error.partial).toBe(true);
  });

  it("records the failure and re-throws when the job throws", async () => {
    const { db, calls } = fakeDb({ insertRows: () => [{ id: "run-3" }], selectRows: () => [] });
    await expect(
      recordRun(db, "connection-health", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const update = calls.find((c) => c.op === "update");
    expect(update?.values).toMatchObject({ status: "failed" });
    expect((update?.values as any).error.message).toBe("boom");
  });

  it("never lets a broken ledger stop the job", async () => {
    const broken = {
      insert: () => {
        throw new Error("d1 down");
      },
    };
    const result = await recordRun(broken as any, "auto-loop", async () => ({ processed: 0, errors: [] }));
    expect(result).toEqual({ processed: 0, errors: [] });
  });
});

// --- cron dispatch ---

describe("cron dispatch", () => {
  it("routes every documented schedule to the right job", () => {
    expect(jobNameForCron("0 */6 * * *")).toBe("analytics-sync");
    expect(jobNameForCron("20 3 * * *")).toBe("auto-loop");
    expect(jobNameForCron("17 * * * *")).toBe("connection-health");
    expect(jobNameForCron("10 2 * * *")).toBe("creative-topup");
    expect(jobNameForCron("* * * * *")).toBe("post-publisher");
    expect(jobNameForCron("0 0 1 1 *")).toBeUndefined();
  });

  it("dispatchCron invokes the matching job's run function", async () => {
    const stub = vi.fn().mockResolvedValue({ ok: true });
    const entry = JOBS["analytics-sync"];
    if (!entry) throw new Error("analytics-sync job missing");
    const orig = entry.run;
    entry.run = stub as any;
    try {
      const { db } = fakeDb({ insertRows: () => [{ id: "r" }], selectRows: () => [] });
      await dispatchCron("0 */6 * * *", { DB: db, SECRET_KEY: "sk", R2: {} } as any);
      expect(stub).toHaveBeenCalledTimes(1);
      expect(stub.mock.calls[0]![0]).toMatchObject({ secretKey: "sk" });
    } finally {
      entry.run = orig;
    }
  });

  it("dispatchCron ignores unknown schedules without throwing", async () => {
    await expect(dispatchCron("0 0 29 2 *", {} as any)).resolves.toBeUndefined();
  });
});

// --- post-publisher backoff ---

describe("retryDelayMinutes", () => {
  it("backs off exponentially and caps at 60 minutes", () => {
    expect(retryDelayMinutes(1)).toBe(10); // 5 * 2^1
    expect(retryDelayMinutes(2)).toBe(20);
    expect(retryDelayMinutes(3)).toBe(40);
    expect(retryDelayMinutes(4)).toBe(60); // capped
    expect(retryDelayMinutes(10)).toBe(60);
  });
});

// --- connection-health ---

describe("runConnectionHealth", () => {
  const refreshMock = getValidAccessToken as unknown as ReturnType<typeof vi.fn>;

  const connRows = [
    {
      // expiring in 1 day with a refresh token → refreshed via provider
      conn: {
        id: "c-refresh",
        status: "healthy",
        refreshToken: "rt",
        tokenExpiresAt: new Date(Date.now() + 864e5),
        accessToken: "enc",
        workspace_id: "ws-1",
        platform_id: "p-meta",
        account_id: "acct-1",
      },
      platformCode: "meta",
      platformName: "Meta",
    },
    {
      // token dead a day ago, no refresh token → flipped to expired
      conn: {
        id: "c-expired",
        status: "healthy",
        refreshToken: null,
        tokenExpiresAt: new Date(Date.now() - 864e5),
        accessToken: "enc",
        workspace_id: "ws-1",
        platform_id: "p-meta",
        account_id: "acct-1",
      },
      platformCode: "meta",
      platformName: "Meta",
    },
    {
      // no expiry at all → stays healthy, untouched
      conn: {
        id: "c-healthy",
        status: "healthy",
        refreshToken: null,
        tokenExpiresAt: null,
        accessToken: "enc",
        workspace_id: "ws-1",
        platform_id: "p-meta",
        account_id: "acct-1",
      },
      platformCode: "meta",
      platformName: "Meta",
    },
  ];

  it("refreshes near-expiry tokens and flips dead ones to expired", async () => {
    refreshMock.mockResolvedValue({ accessToken: "new", connection: {} });
    const { db, calls } = fakeDb({
      selectRows: (t) => {
        if (t === tenants) return [];
        if (t === platformConnections) return connRows;
        if (t === workspaceMembers) return [];
        return [];
      },
    });
    const out = await runConnectionHealth({
      db,
      env: {},
      secretKey: "sk",
      r2: {} as any,
    });
    expect(out).toMatchObject({ checked: 3, refreshed: 1, flipped: 1 });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock.mock.calls[0]!.slice(1, 4)).toEqual(["sk", "ws-1", "meta"]);
    const updates = calls.filter((c) => c.op === "update");
    // only the expired connection gets a status update; the refreshed one is
    // updated by getValidAccessToken itself, the healthy one is untouched
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toMatchObject({ status: "expired" });
  });

  it("marks the connection expired when the provider rejects the refresh", async () => {
    refreshMock.mockRejectedValue(new Error("invalid_grant: token revoked"));
    const { db, calls } = fakeDb({
      selectRows: (t) => {
        if (t === tenants) return [];
        if (t === platformConnections) return [connRows[0]];
        return [];
      },
    });
    const out = await runConnectionHealth({ db, env: {}, secretKey: "sk", r2: {} as any });
    expect(out.refreshed).toBe(0);
    const updates = calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toMatchObject({ status: "expired" });
    expect((updates[0]!.values as any).lastError).toMatch(/invalid_grant/);
  });

  it("skips connections belonging to paused accounts", async () => {
    refreshMock.mockResolvedValue({ accessToken: "new", connection: {} });
    const { db } = fakeDb({
      selectRows: (t) => {
        if (t === tenants) return [{ id: "acct-1" }];
        if (t === platformConnections) return connRows;
        return [];
      },
    });
    const out = await runConnectionHealth({ db, env: {}, secretKey: "sk", r2: {} as any });
    expect(out).toMatchObject({ checked: 0, refreshed: 0, flipped: 0 });
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
