import { describe, expect, it } from "vitest";
import { integer, sqliteTable, text, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import { compileFilter, HttpError } from "../src/lib/filter.js";
import { parseListQuery } from "../src/lib/query.js";

const t = sqliteTable("t", {
  id: text("id"),
  name: text("name"),
  tags: text("tags", { mode: "json" }),
  meta: text("meta", { mode: "json" }),
  deletedAt: integer("deletedAt", { mode: "timestamp" }),
});

const dialect = new SQLiteSyncDialect();

function render(filter: unknown): { sql: string; params: unknown[] } | undefined {
  const compiled: SQL | undefined = compileFilter(filter, t);
  if (!compiled) return undefined;
  const q = dialect.sqlToQuery(compiled);
  return { sql: q.sql, params: q.params };
}

function sqlOf(filter: unknown): string {
  return render(filter)?.sql ?? "";
}

function paramsOf(filter: unknown): unknown[] {
  return render(filter)?.params ?? [];
}

function expectHttpError400(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    return;
  }
  throw new Error("Expected HttpError(400) to be thrown");
}

describe("compileFilter operators", () => {
  it("eq", () => {
    expect(sqlOf({ name: { eq: "Acme" } })).toBe(`"t"."name" = ?`);
    expect(paramsOf({ name: { eq: "Acme" } })).toEqual(["Acme"]);
  });

  it("ne", () => {
    expect(sqlOf({ name: { ne: "Acme" } })).toBe(`"t"."name" <> ?`);
    expect(paramsOf({ name: { ne: "Acme" } })).toEqual(["Acme"]);
  });

  it("shorthand { field: value } means { field: { eq: value } }", () => {
    expect(sqlOf({ name: "Acme" })).toBe(`"t"."name" = ?`);
    expect(paramsOf({ name: "Acme" })).toEqual(["Acme"]);
  });

  it("eq: null becomes IS NULL", () => {
    expect(sqlOf({ name: { eq: null } })).toBe(`"t"."name" is null`);
  });

  it("ne: null becomes IS NOT NULL", () => {
    expect(sqlOf({ name: { ne: null } })).toBe(`"t"."name" is not null`);
  });

  it("shorthand null becomes IS NULL", () => {
    expect(sqlOf({ name: null })).toBe(`"t"."name" is null`);
  });

  it("icontains is case-insensitive LIKE with escaped wildcards", () => {
    const sql = sqlOf({ name: { icontains: "A%b_c\\d" } });
    expect(sql.toLowerCase()).toContain("like");
    expect(sql).toContain(`lower("t"."name")`);
    expect(sql).toContain("ESCAPE");
    // Lowercased value, % _ \ escaped, wrapped in %...%
    expect(paramsOf({ name: { icontains: "A%b_c\\d" } })).toEqual(["%a\\%b\\_c\\\\d%"]);
  });

  it("arraycontains uses json_each EXISTS", () => {
    const sql = sqlOf({ tags: { arraycontains: "x" } });
    expect(sql).toContain(`json_each("t"."tags")`);
    expect(sql).toContain("WHERE value = ?");
    expect(sql.toUpperCase()).toContain("EXISTS");
    expect(paramsOf({ tags: { arraycontains: "x" } })).toEqual(["x"]);
  });

  it("jsonbContains ANDs json_extract comparisons per key", () => {
    const filter = { meta: { jsonbContains: { status: "active", count: 3 } } };
    const sql = sqlOf(filter);
    expect(sql).toContain(`json_extract("t"."meta", ?) = ?`);
    expect(sql.toLowerCase()).toContain("and");
    expect(paramsOf(filter)).toEqual(['$."status"', "active", '$."count"', 3]);
  });

  it("jsonbContains stringifies nested objects", () => {
    expect(paramsOf({ meta: { jsonbContains: { nested: { a: 1 } } } })).toEqual([
      '$."nested"',
      JSON.stringify({ a: 1 }),
    ]);
  });

  it("multiple top-level keys are ANDed", () => {
    const sql = sqlOf({ name: "a", id: "b" });
    expect(sql).toContain(`"t"."name" = ?`);
    expect(sql).toContain(`"t"."id" = ?`);
    expect(sql.toLowerCase()).toContain("and");
  });

  it("AND/OR nest", () => {
    const sql = sqlOf({
      AND: [{ name: { eq: "a" } }, { OR: [{ id: "1" }, { id: "2" }] }],
    });
    expect(sql).toContain(`"t"."name" = ?`);
    expect(sql).toContain(`"t"."id" = ? or "t"."id" = ?`);
  });

  it("multiple operators on one field are ANDed", () => {
    const sql = sqlOf({ name: { ne: "a", icontains: "b" } });
    expect(sql).toContain(`"t"."name" <> ?`);
    expect(sql).toContain(`lower("t"."name") LIKE ? ESCAPE '\\'`);
    expect(paramsOf({ name: { ne: "a", icontains: "b" } })).toEqual(["a", "%b%"]);
  });

  it("empty filter returns undefined", () => {
    expect(render(undefined)).toBeUndefined();
    expect(render(null)).toBeUndefined();
    expect(render({})).toBeUndefined();
  });

  it("unknown field throws HttpError 400", () => {
    expectHttpError400(() => render({ nope: { eq: 1 } }));
  });

  it("unknown operator throws HttpError 400", () => {
    expectHttpError400(() => render({ name: { foo: 1 } }));
  });

  it("non-object filter throws HttpError 400", () => {
    expectHttpError400(() => render("name"));
    expectHttpError400(() => render([{ name: "a" }]));
  });

  it("AND with non-array throws HttpError 400", () => {
    expectHttpError400(() => render({ AND: { name: "a" } }));
  });
});

describe("parseListQuery", () => {
  const sp = (s: string) => new URLSearchParams(s);

  it("defaults: limit 25, offset 0", () => {
    const q = parseListQuery(sp(""), t);
    expect(q.limit).toBe(25);
    expect(q.offset).toBe(0);
    expect(q.sort).toEqual([]);
    expect(q.groupBy).toEqual([]);
    expect(q.fields).toBeUndefined();
  });

  it("page is 1-based: page=3&limit=10 -> offset 20", () => {
    const q = parseListQuery(sp("page=3&limit=10"), t);
    expect(q.offset).toBe(20);
    expect(q.limit).toBe(10);
  });

  it("explicit offset wins over page", () => {
    const q = parseListQuery(sp("page=3&offset=5&limit=10"), t);
    expect(q.offset).toBe(5);
  });

  it("limit is clamped to 1..500", () => {
    expect(parseListQuery(sp("limit=9999"), t).limit).toBe(500);
    expect(parseListQuery(sp("limit=0"), t).limit).toBe(1);
    expect(parseListQuery(sp("limit=-5"), t).limit).toBe(1);
  });

  it("parses string sort form with - prefix for desc", () => {
    const q = parseListQuery(sp('sort=["-deletedAt","name"]'), t);
    expect(q.sort).toEqual([
      { field: "deletedAt", dir: "desc" },
      { field: "name", dir: "asc" },
    ]);
  });

  it("parses object sort form", () => {
    const q = parseListQuery(sp('sort=[{"field":"name","order":"DESC"}]'), t);
    expect(q.sort).toEqual([{ field: "name", dir: "desc" }]);
  });

  it("unknown sort field throws HttpError 400", () => {
    expectHttpError400(() => parseListQuery(sp('sort=["nope"]'), t));
  });

  it("fields are validated and always include id", () => {
    const q = parseListQuery(sp('fields=["name"]'), t);
    expect(q.fields).toEqual(["id", "name"]);
  });

  it("unknown fields entry throws HttpError 400", () => {
    expectHttpError400(() => parseListQuery(sp('fields=["nope"]'), t));
  });

  it("groupBy is comma-separated and validated", () => {
    const q = parseListQuery(sp("groupBy=name"), t);
    expect(q.groupBy).toEqual(["name"]);
    expectHttpError400(() => parseListQuery(sp("groupBy=nope"), t));
  });

  it("aggregate is parsed and validated", () => {
    const q = parseListQuery(sp('aggregate={"sum":["deletedAt"],"count":["id"]}'), t);
    expect(q.aggregate).toEqual({ sum: ["deletedAt"], count: ["id"] });
    expectHttpError400(() => parseListQuery(sp('aggregate={"bogus":["id"]}'), t));
    expectHttpError400(() => parseListQuery(sp('aggregate={"sum":["nope"]}'), t));
  });

  it("filter passes through as parsed JSON", () => {
    const q = parseListQuery(sp('filter={"name":{"eq":"a"}}'), t);
    expect(q.filter).toEqual({ name: { eq: "a" } });
  });

  it("invalid JSON throws HttpError 400", () => {
    expectHttpError400(() => parseListQuery(sp("filter={bad"), t));
  });
});
