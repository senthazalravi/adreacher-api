import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { HttpError } from "./filter.js";

export type AggregateOp = "sum" | "avg" | "min" | "max" | "count";
export type AggregateSpec = Partial<Record<AggregateOp, string[]>>;

export interface SortSpec {
  field: string;
  dir: "asc" | "desc";
}

export interface ListQuery {
  filter?: unknown;
  fields?: string[];
  sort: SortSpec[];
  limit: number;
  offset: number;
  aggregate?: AggregateSpec;
  groupBy: string[];
  includeTotal: boolean;
}

const AGGREGATE_OPS: readonly string[] = ["sum", "avg", "min", "max", "count"];

function assertField(table: SQLiteTable, field: string, param: string): void {
  if (!Object.hasOwn(getTableColumns(table), field)) {
    throw new HttpError(400, `Unknown field "${field}" in "${param}"`, "UNKNOWN_FIELD");
  }
}

function parseJson(raw: string | null, param: string): unknown {
  if (raw === null || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, `Query param "${param}" must be valid JSON`, "INVALID_QUERY");
  }
}

export function parseFields(raw: string | null, table: SQLiteTable): string[] | undefined {
  const parsed = parseJson(raw, "fields");
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed) || !parsed.every((f): f is string => typeof f === "string")) {
    throw new HttpError(400, `Query param "fields" must be a JSON array of strings`, "INVALID_QUERY");
  }
  const fields = [...new Set<string>(parsed)];
  for (const f of fields) assertField(table, f, "fields");
  // The id is always selected so rows stay addressable.
  if (Object.hasOwn(getTableColumns(table), "id") && !fields.includes("id")) fields.unshift("id");
  return fields;
}

function parseSort(raw: string | null, table: SQLiteTable): SortSpec[] {
  const parsed = parseJson(raw, "sort");
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new HttpError(400, `Query param "sort" must be a JSON array`, "INVALID_QUERY");
  }
  return parsed.map((item): SortSpec => {
    if (typeof item === "string") {
      const dir = item.startsWith("-") ? "desc" : "asc";
      const field = item.startsWith("-") ? item.slice(1) : item;
      assertField(table, field, "sort");
      return { field, dir };
    }
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const field = rec["field"];
      if (typeof field !== "string" || field === "") {
        throw new HttpError(400, `Each "sort" object needs a string "field"`, "INVALID_QUERY");
      }
      assertField(table, field, "sort");
      const orderRaw = rec["order"] ?? rec["dir"] ?? "asc";
      const order = typeof orderRaw === "string" ? orderRaw.toLowerCase() : "";
      if (order !== "asc" && order !== "desc") {
        throw new HttpError(400, `Invalid sort order "${String(orderRaw)}" for field "${field}"`, "INVALID_QUERY");
      }
      return { field, dir: order };
    }
    throw new HttpError(400, `Each "sort" entry must be a string or { field, order }`, "INVALID_QUERY");
  });
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return 25;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new HttpError(400, `Query param "limit" must be an integer`, "INVALID_QUERY");
  }
  return Math.min(500, Math.max(1, n));
}

function parseOffset(rawOffset: string | null, rawPage: string | null, limit: number): number {
  if (rawOffset !== null && rawOffset !== "") {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) {
      throw new HttpError(400, `Query param "offset" must be a non-negative integer`, "INVALID_QUERY");
    }
    return n;
  }
  if (rawPage !== null && rawPage !== "") {
    const p = Number(rawPage);
    if (!Number.isInteger(p) || p < 1) {
      throw new HttpError(400, `Query param "page" must be an integer >= 1`, "INVALID_QUERY");
    }
    return (p - 1) * limit;
  }
  return 0;
}

function parseGroupBy(raw: string | null, table: SQLiteTable): string[] {
  if (raw === null || raw.trim() === "") return [];
  const fields = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const f of fields) assertField(table, f, "groupBy");
  return fields;
}

function parseAggregate(raw: string | null, table: SQLiteTable): AggregateSpec | undefined {
  const parsed = parseJson(raw, "aggregate");
  if (parsed === undefined) return undefined;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, `Query param "aggregate" must be a JSON object`, "INVALID_QUERY");
  }
  const spec: AggregateSpec = {};
  for (const [op, value] of Object.entries(parsed)) {
    if (!AGGREGATE_OPS.includes(op)) {
      throw new HttpError(400, `Unknown aggregate "${op}"`, "INVALID_QUERY");
    }
    if (!Array.isArray(value) || !value.every((f): f is string => typeof f === "string")) {
      throw new HttpError(400, `Aggregate "${op}" must be an array of field names`, "INVALID_QUERY");
    }
    for (const f of value) assertField(table, f, "aggregate");
    spec[op as AggregateOp] = [...value];
  }
  return spec;
}

export function parseListQuery(searchParams: URLSearchParams, table: SQLiteTable): ListQuery {
  const limit = parseLimit(searchParams.get("limit"));
  return {
    filter: parseJson(searchParams.get("filter"), "filter"),
    fields: parseFields(searchParams.get("fields"), table),
    sort: parseSort(searchParams.get("sort"), table),
    limit,
    offset: parseOffset(searchParams.get("offset"), searchParams.get("page"), limit),
    aggregate: parseAggregate(searchParams.get("aggregate"), table),
    groupBy: parseGroupBy(searchParams.get("groupBy"), table),
    includeTotal: searchParams.get("includeTotal") !== "false",
  };
}
