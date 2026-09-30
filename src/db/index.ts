// Shared Drizzle instance WITH the schema, so the relational query API
// (db.query.<table>.findFirst) is available. Use getDb(c.env.DB) anywhere a
// route needs db.query; the plain drizzle() call remains fine for the
// non-relational select/insert/update builders.
import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema/index.js";

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof getDb>;
