import {
  and,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

/** HTTP-friendly error thrown for bad filter/query input (mapped to a JSON error body). */
export class HttpError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

type Operator = "eq" | "ne" | "in" | "nin" | "gt" | "gte" | "lt" | "lte" | "icontains" | "arraycontains" | "jsonbContains" | "is";

const OPERATORS: readonly Operator[] = ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "icontains", "arraycontains", "jsonbContains", "is"];

function isOperator(op: string): op is Operator {
  return (OPERATORS as readonly string[]).includes(op);
}

function resolveColumn(table: SQLiteTable, field: string): AnySQLiteColumn {
  const col: AnySQLiteColumn | undefined = getTableColumns(table)[field];
  if (!col) {
    throw new HttpError(400, `Unknown field "${field}"`, "UNKNOWN_FIELD");
  }
  return col;
}

function compileOperator(column: AnySQLiteColumn, field: string, op: string, value: unknown): SQL {
  if (!isOperator(op)) {
    throw new HttpError(400, `Unknown operator "${op}" on field "${field}"`, "UNKNOWN_OPERATOR");
  }
  switch (op) {
    case "eq":
      return value === null || value === undefined ? isNull(column) : eq(column, value);
    case "ne":
      return value === null || value === undefined ? isNotNull(column) : ne(column, value);
    case "in":
    case "nin": {
      if (!Array.isArray(value)) {
        throw new HttpError(400, `Operator "${op}" on field "${field}" requires an array value`, "INVALID_FILTER");
      }
      if (value.length === 0) return sql`1 = ${op === "in" ? 0 : 1}`;
      return (op === "in" ? inArray(column, value) : notInArray(column, value)) as SQL;
    }
    case "is": {
      // Null checks, Baasix-style: { is: null } | { is: { not: null } } | { is: value }
      if (value === null || value === undefined) return isNull(column);
      if (typeof value === "object" && !Array.isArray(value) && "not" in (value as Record<string, unknown>)) {
        const inner = (value as Record<string, unknown>)["not"];
        return inner === null || inner === undefined ? isNotNull(column) : ne(column, inner as string | number);
      }
      return eq(column, value as string | number);
    }
    case "gt":
      return gt(column, value as string | number);
    case "gte":
      return gte(column, value as string | number);
    case "lt":
      return lt(column, value as string | number);
    case "lte":
      return lte(column, value as string | number);
    case "icontains": {
      if (typeof value !== "string") {
        throw new HttpError(
          400,
          `Operator "icontains" on field "${field}" requires a string value`,
          "INVALID_FILTER",
        );
      }
      // Escape LIKE wildcards, then compare lowercased on both sides.
      const escaped = value.replace(/[\\%_]/g, (ch) => `\\${ch}`).toLowerCase();
      return sql`lower(${column}) LIKE ${`%${escaped}%`} ESCAPE '\\'`;
    }
    case "arraycontains":
      // Column holds a JSON text array; true when the scalar appears as an element.
      return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value})`;
    case "jsonbContains": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(
          400,
          `Operator "jsonbContains" on field "${field}" requires an object value`,
          "INVALID_FILTER",
        );
      }
      const entries = Object.entries(value);
      if (entries.length === 0) return sql`1 = 1`;
      const parts = entries.map(([k, v]) => {
        const path = `$."${k.replace(/"/g, '\\"')}"`;
        const rhs =
          v !== null && typeof v === "object"
            ? JSON.stringify(v)
            : typeof v === "boolean"
              ? Number(v)
              : v;
        return sql`json_extract(${column}, ${path}) = ${rhs}`;
      });
      return and(...parts) as SQL;
    }
  }
}

function compileFieldCondition(column: AnySQLiteColumn, field: string, condition: unknown): SQL {
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    // Shorthand: { field: value } === { field: { eq: value } }
    return compileOperator(column, field, "eq", condition);
  }
  const entries = Object.entries(condition);
  if (entries.length === 0) return sql`1 = 1`;
  const parts = entries.map(([op, value]) => compileOperator(column, field, op, value));
  return and(...parts) as SQL;
}

/**
 * Compile a parsed JSON filter into a Drizzle SQL fragment.
 * Shape: `{ field: { op: value }, AND: [...], OR: [...] }`; top-level keys are ANDed.
 * Returns undefined when the filter is empty/absent.
 */
export function compileFilter(filter: unknown, table: SQLiteTable): SQL | undefined {
  if (filter === undefined || filter === null) return undefined;
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new HttpError(400, "Filter must be a JSON object", "INVALID_FILTER");
  }
  const parts: SQL[] = [];
  for (const [key, raw] of Object.entries(filter)) {
    if (key === "AND" || key === "OR") {
      if (!Array.isArray(raw)) {
        throw new HttpError(400, `"${key}" must be an array of filter objects`, "INVALID_FILTER");
      }
      const nested = raw
        .map((item) => compileFilter(item, table))
        .filter((c): c is SQL => c !== undefined);
      if (nested.length === 0) continue;
      parts.push((key === "AND" ? and(...nested) : or(...nested)) as SQL);
      continue;
    }
    parts.push(compileFieldCondition(resolveColumn(table, key), key, raw));
  }
  if (parts.length === 0) return undefined;
  return and(...parts) as SQL;
}
