import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  getTableColumns,
  isNull,
  max,
  min,
  sum,
  type SQL,
} from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { registry } from "../db/registry.js";
import { compileFilter, HttpError } from "../lib/filter.js";
import { parseFields, parseListQuery, type AggregateOp, type ListQuery } from "../lib/query.js";
import { scopeItemsWhere, enforceWriteScope, sessionOf } from "../lib/auth.js";
import { SECRET_FIELDS, encryptRowSecrets, maskRowSecrets } from "../lib/secrets.js";
import { bootstrapWorkspace } from "../lib/workspace.js";
import type { Env } from "../index.js";

// Server-side scoping is enforced on every /items route (authMiddleware +
// tenantStatusGuard run first in index.ts). The FE still sends its own
// workspace_id filters; those are honored ANDed with the session-derived
// constraint, so a forged filter can only narrow, never widen, access.

type Db = ReturnType<typeof drizzle>;
type AppContext = Context<{ Bindings: Env }>;
type Row = Record<string, unknown>;

const items = new Hono<{ Bindings: Env }>();

function getTable(collection: string): SQLiteTable {
  const table: SQLiteTable | undefined = registry[collection];
  if (!table) {
    throw new HttpError(400, `Unknown collection "${collection}"`, "UNKNOWN_COLLECTION");
  }
  return table;
}

function columnOf(table: SQLiteTable, name: string): AnySQLiteColumn {
  const col: AnySQLiteColumn | undefined = getTableColumns(table)[name];
  if (!col) throw new HttpError(400, `Unknown field "${name}"`, "UNKNOWN_FIELD");
  return col;
}

/** Paranoid guard: hide soft-deleted rows on tables that carry a deletedAt column. */
function paranoidGuard(table: SQLiteTable): SQL | undefined {
  const deletedAt: AnySQLiteColumn | undefined = getTableColumns(table)["deletedAt"];
  return deletedAt ? isNull(deletedAt) : undefined;
}

function whereClause(table: SQLiteTable, filter: unknown): SQL | undefined {
  const parts = [compileFilter(filter, table), paranoidGuard(table)].filter(
    (p): p is SQL => p !== undefined,
  );
  return parts.length > 0 ? (and(...parts) as SQL) : undefined;
}

/** Client filter + paranoid guard + server-side session scoping. */
async function scopedWhere(
  c: AppContext,
  collection: string,
  table: SQLiteTable,
  filter: unknown,
): Promise<SQL | undefined> {
  const parts = [
    compileFilter(filter, table),
    paranoidGuard(table),
    await scopeItemsWhere(c, table, collection),
  ].filter((p): p is SQL => p !== undefined);
  return parts.length > 0 ? (and(...parts) as SQL) : undefined;
}

/** Encrypt secret fields on a write payload (no-op for other collections). */
async function encryptWrite(
  c: AppContext,
  collection: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!SECRET_FIELDS[collection]) return values;
  const key = c.env.SECRET_KEY;
  if (!key) throw new HttpError(500, "SECRET_KEY is not configured", "SECRETS_UNCONFIGURED");
  return encryptRowSecrets(collection, values, key);
}

/** Mask secret fields on rows leaving the API. */
function maskRead(collection: string, row: Row): Row {
  return maskRowSecrets(collection, row);
}

async function findOne(
  db: Db,
  table: SQLiteTable,
  id: string,
  fields?: string[],
): Promise<Row | undefined> {
  const where = and(eq(columnOf(table, "id"), id), paranoidGuard(table));
  const selection = fields
    ? Object.fromEntries(fields.map((f) => [f, columnOf(table, f)]))
    : undefined;
  const rows: Row[] = selection
    ? ((await db.select(selection).from(table).where(where).limit(1)) as Row[])
    : ((await db.select().from(table).where(where).limit(1)) as Row[]);
  return rows[0];
}

/** findOne + server-side session scoping (existence checks must not leak across scopes). */
async function findOneScoped(
  c: AppContext,
  collection: string,
  table: SQLiteTable,
  id: string,
  fields?: string[],
): Promise<Row | undefined> {
  const scope = await scopeItemsWhere(c, table, collection);
  const where = and(eq(columnOf(table, "id"), id), paranoidGuard(table), scope);
  const selection = fields
    ? Object.fromEntries(fields.map((f) => [f, columnOf(table, f)]))
    : undefined;
  const rows: Row[] = selection
    ? ((await drizzle(c.env.DB).select(selection).from(table).where(where).limit(1)) as Row[])
    : ((await drizzle(c.env.DB).select().from(table).where(where).limit(1)) as Row[]);
  return rows[0];
}

async function insertRow(db: Db, table: SQLiteTable, input: Record<string, unknown>): Promise<Row> {
  const cols = getTableColumns(table);
  const values: Record<string, unknown> = { ...input };
  if (cols["id"] && values["id"] === undefined) values["id"] = crypto.randomUUID();
  const now = new Date();
  if (cols["createdAt"] && values["createdAt"] === undefined) values["createdAt"] = now;
  if (cols["updatedAt"] && values["updatedAt"] === undefined) values["updatedAt"] = now;
  const id = values["id"];
  if (typeof id !== "string") {
    throw new HttpError(400, "Row must have a string id", "INVALID_BODY");
  }
  // Fail fast with a 400 (not a 500 from the DB) when a NOT NULL column has
  // no value and no schema default. Columns with defaults are filled in by
  // Drizzle itself at insert time.
  for (const [name, col] of Object.entries(cols)) {
    if (col.notNull && !col.hasDefault && values[name] === undefined) {
      throw new HttpError(400, `Missing required field: ${name}`, "MISSING_FIELD");
    }
  }
  await db.insert(table).values(values as { [key: string]: unknown });
  const row = await findOne(db, table, id);
  if (!row) throw new HttpError(500, "Insert did not return a row", "INSERT_FAILED");
  return row;
}

async function updateRow(
  db: Db,
  table: SQLiteTable,
  id: string,
  data: Record<string, unknown>,
): Promise<Row> {
  const values: Record<string, unknown> = { ...data };
  delete values["id"];
  if (getTableColumns(table)["updatedAt"]) values["updatedAt"] = new Date();
  await db
    .update(table)
    .set(values as { [key: string]: unknown })
    .where(eq(columnOf(table, "id"), id));
  const row = await findOne(db, table, id);
  if (!row) throw new HttpError(500, "Update did not return a row", "UPDATE_FAILED");
  return row;
}

async function deleteRow(db: Db, table: SQLiteTable, id: string): Promise<void> {
  const idCol = columnOf(table, "id");
  if (getTableColumns(table)["deletedAt"]) {
    await db
      .update(table)
      .set({ deletedAt: new Date() })
      .where(eq(idCol, id));
  } else {
    await db.delete(table).where(eq(idCol, id));
  }
}

async function readJsonObject(c: AppContext): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_BODY");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object", "INVALID_BODY");
  }
  return body as Record<string, unknown>;
}

async function readJsonArray(c: AppContext): Promise<Record<string, unknown>[]> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_BODY");
  }
  if (!Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON array", "INVALID_BODY");
  }
  for (const item of body) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new HttpError(400, "Each array item must be a JSON object", "INVALID_BODY");
    }
  }
  return body as Record<string, unknown>[];
}

const AGG_FNS: Record<AggregateOp, (expr: AnySQLiteColumn) => SQL> = { sum, avg, min, max, count };

function aggregateSelection(
  table: SQLiteTable,
  aggregate: ListQuery["aggregate"],
): Record<string, SQL> {
  const selection: Record<string, SQL> = {};
  for (const [op, fields] of Object.entries(aggregate ?? {})) {
    const fn = AGG_FNS[op as AggregateOp];
    for (const field of fields ?? []) {
      selection[`${op}_${field}`] = fn(columnOf(table, field));
    }
  }
  return selection;
}

// Bulk routes first: "/:collection/bulk" must win over "/:collection/:id" (where id would be "bulk").

items.post("/:collection/bulk", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const body = await readJsonArray(c);
  const db = drizzle(c.env.DB);
  const rows: Row[] = [];
  for (const item of body) {
    const scoped = await enforceWriteScope(c, table, item);
    rows.push(maskRead(collection, await insertRow(db, table, await encryptWrite(c, collection, scoped))));
  }
  return c.json({ data: rows });
});

items.patch("/:collection/bulk", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const body = await readJsonObject(c);
  const ids = body["ids"];
  const data = body["data"];
  if (!Array.isArray(ids) || !ids.every((v): v is string => typeof v === "string")) {
    throw new HttpError(400, 'Body must be { ids: string[], data: object }', "INVALID_BODY");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HttpError(400, 'Body must be { ids: string[], data: object }', "INVALID_BODY");
  }
  const db = drizzle(c.env.DB);
  const rows: Row[] = [];
  for (const id of ids) {
    const existing = await findOneScoped(c, collection, table, id);
    if (!existing) {
      return c.json({ error: { code: "NOT_FOUND", message: `Row "${id}" not found` } }, 404);
    }
    const scoped = await enforceWriteScope(c, table, data as Record<string, unknown>);
    rows.push(maskRead(collection, await updateRow(db, table, id, await encryptWrite(c, collection, scoped))));
  }
  return c.json({ data: rows });
});

items.delete("/:collection/bulk", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const body = await readJsonObject(c);
  const ids = body["ids"];
  if (!Array.isArray(ids) || !ids.every((v): v is string => typeof v === "string")) {
    throw new HttpError(400, 'Body must be { ids: string[] }', "INVALID_BODY");
  }
  const db = drizzle(c.env.DB);
  const deletedIds: string[] = [];
  for (const id of ids) {
    const existing = await findOneScoped(c, collection, table, id);
    if (!existing) continue;
    await deleteRow(db, table, id);
    deletedIds.push(id);
  }
  return c.json({ data: { deleted: deletedIds.length, ids: deletedIds } });
});

items.get("/:collection", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const q = parseListQuery(new URL(c.req.url).searchParams, table);
  const db = drizzle(c.env.DB);
  const where = await scopedWhere(c, collection, table, q.filter);

  if (q.groupBy.length > 0) {
    const groupCols = q.groupBy.map((g) => columnOf(table, g));
    const grouped: Record<string, AnySQLiteColumn | SQL> = {};
    for (const g of q.groupBy) grouped[g] = columnOf(table, g);
    if (q.aggregate) Object.assign(grouped, aggregateSelection(table, q.aggregate));
    const rows = await db.select(grouped).from(table).where(where).groupBy(...groupCols);
    return c.json({ data: rows, totalCount: rows.length });
  }

  if (q.aggregate) {
    const selection = aggregateSelection(table, q.aggregate);
    const rows = await db.select(selection).from(table).where(where);
    return c.json({ data: rows[0] ?? {} });
  }

  const selection = q.fields
    ? Object.fromEntries(q.fields.map((f) => [f, columnOf(table, f)]))
    : undefined;
  const orderBy = q.sort.map((s) =>
    s.dir === "desc" ? desc(columnOf(table, s.field)) : asc(columnOf(table, s.field)),
  );
  const rows: Row[] = selection
    ? ((await db
        .select(selection)
        .from(table)
        .where(where)
        .orderBy(...orderBy)
        .limit(q.limit)
        .offset(q.offset)) as Row[])
    : ((await db
        .select()
        .from(table)
        .where(where)
        .orderBy(...orderBy)
        .limit(q.limit)
        .offset(q.offset)) as Row[]);
  const totalRows = await db.select({ value: count() }).from(table).where(where);
  const totalCount = totalRows[0]?.value ?? 0;
  return c.json({ data: rows.map((r) => maskRead(collection, r)), totalCount });
});

items.get("/:collection/:id", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const fields = parseFields(c.req.query("fields") ?? null, table);
  const row = await findOneScoped(c, collection, table, c.req.param("id"), fields);
  if (!row) return c.json({ error: { code: "NOT_FOUND" } }, 404);
  return c.json({ data: maskRead(collection, row) });
});

items.post("/:collection", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const scoped = await enforceWriteScope(c, table, await readJsonObject(c));
  // Workspace creation also bootstraps workspace_settings + an owner
  // membership, and enforces the plan's workspace limit (402 when reached).
  if (collection === "workspaces") {
    const s = sessionOf(c);
    const { name, slug, account_id, id, ...extra } = scoped as Record<string, unknown>;
    const ws = await bootstrapWorkspace(drizzle(c.env.DB), {
      accountId: String(account_id ?? s.tenantId),
      userId: s.userId,
      name: String(name ?? "Workspace"),
      slug: slug ? String(slug) : undefined,
      extra,
    });
    return c.json({ data: maskRead(collection, ws as Row) });
  }
  const row = await insertRow(drizzle(c.env.DB), table, await encryptWrite(c, collection, scoped));
  return c.json({ data: maskRead(collection, row) });
});

items.patch("/:collection/:id", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await findOneScoped(c, collection, table, id);
  if (!existing) return c.json({ error: { code: "NOT_FOUND" } }, 404);
  const scoped = await enforceWriteScope(c, table, await readJsonObject(c));
  const row = await updateRow(db, table, id, await encryptWrite(c, collection, scoped));
  return c.json({ data: maskRead(collection, row) });
});

items.delete("/:collection/:id", async (c) => {
  const collection = c.req.param("collection");
  const table = getTable(collection);
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await findOneScoped(c, collection, table, id);
  if (!existing) return c.json({ error: { code: "NOT_FOUND" } }, 404);
  await deleteRow(db, table, id);
  return c.json({ data: { id, deleted: true } });
});

export default items;
