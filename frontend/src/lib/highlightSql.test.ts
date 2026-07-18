import { describe, expect, it } from "vitest";
import { tokenizeSql, type SqlToken } from "./highlightSql";

const typesOf = (sql: string, text: string) =>
  tokenizeSql(sql).filter((t: SqlToken) => t.text === text).map((t) => t.type);

describe("tokenizeSql", () => {
  it("round-trips the source exactly", () => {
    const sql = "SELECT a, COUNT(*) FROM t WHERE x > 1 -- note\n";
    expect(tokenizeSql(sql).map((t) => t.text).join("")).toBe(sql);
  });

  it("classifies keywords case-insensitively", () => {
    expect(typesOf("select 1", "select")).toEqual(["keyword"]);
    expect(typesOf("SELECT 1", "SELECT")).toEqual(["keyword"]);
  });

  it("marks a word before '(' as a function, not a plain identifier", () => {
    expect(typesOf("ROUND(x)", "ROUND")).toEqual(["function"]);
    expect(typesOf("a.col", "col")).toEqual(["plain"]);
  });

  it("highlights strings, numbers, and comments", () => {
    expect(typesOf("WHERE s = 'hi'", "'hi'")).toEqual(["string"]);
    expect(typesOf("LIMIT 10", "10")).toEqual(["number"]);
    expect(typesOf("-- c\n", "-- c")).toEqual(["comment"]);
  });
});
