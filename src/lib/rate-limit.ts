// D1-backed fixed-window rate limiting for the public auth endpoints.
// Self-provisions its table on first use so deploys never depend on a
// manual migration having run. Counters are best-effort (read-modify-write);
// that is fine for abuse throttling, which does not need strict atomicity.
import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/index.js";

const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: integer("window_start").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

let ensured: Promise<void> | null = null;
function ensureTable(db: Db): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.run(sql`CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

async function readRow(db: Db, key: string) {
  const rows = await db.select().from(authRateLimits).where(eq(authRateLimits.key, key)).limit(1);
  return rows[0];
}

/** Seconds until a retry is allowed WITHOUT consuming an attempt (0 = allowed). */
export async function rateLimitPeek(db: Db, key: string, limit: number, windowSec: number): Promise<number> {
  await ensureTable(db);
  const now = Math.floor(Date.now() / 1000);
  const row = await readRow(db, key);
  if (!row || now - row.windowStart >= windowSec) return 0;
  return row.count >= limit ? row.windowStart + windowSec - now : 0;
}

/** Consume one attempt; returns seconds until retry is allowed (0 = allowed). */
export async function rateLimitHit(db: Db, key: string, limit: number, windowSec: number): Promise<number> {
  await ensureTable(db);
  const now = Math.floor(Date.now() / 1000);
  const row = await readRow(db, key);
  if (!row || now - row.windowStart >= windowSec) {
    await db
      .insert(authRateLimits)
      .values({ key, count: 1, windowStart: now, updatedAt: now })
      .onConflictDoUpdate({ target: authRateLimits.key, set: { count: 1, windowStart: now, updatedAt: now } });
    return 0;
  }
  const count = row.count + 1;
  await db.update(authRateLimits).set({ count, updatedAt: now }).where(eq(authRateLimits.key, key));
  return count > limit ? row.windowStart + windowSec - now : 0;
}

/** Forget a counter (e.g. after a successful login). */
export async function rateLimitClear(db: Db, key: string): Promise<void> {
  await ensureTable(db);
  await db.delete(authRateLimits).where(eq(authRateLimits.key, key));
}
