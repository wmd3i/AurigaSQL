import { describe, expect, it } from "vitest";
import { formatSql } from "./formatSql";

describe("formatSql", () => {
  it("breaks major clauses onto separate lines", () => {
    const sql = "SELECT a, COUNT(*) FROM t WHERE x IS NULL OR y IS NULL GROUP BY a";
    expect(formatSql(sql)).toBe(
      [
        "SELECT a,",
        "  COUNT(*)",
        "FROM t",
        "WHERE x IS NULL",
        "  OR y IS NULL",
        "GROUP BY a;",
      ].join("\n"),
    );
  });

  it("preserves quoted strings while formatting", () => {
    const sql = "SELECT 'FROM here', note FROM logs WHERE level = 'warn'";
    expect(formatSql(sql)).toContain("'FROM here'");
    expect(formatSql(sql)).toContain("WHERE level = 'warn'");
  });

  it("indents CASE branches in a more readable way", () => {
    const sql = "SELECT CASE WHEN score < 0.25 THEN 'Low' WHEN score < 0.75 THEN 'Medium' ELSE 'High' END AS bucket, COUNT(*) AS n FROM signals GROUP BY CASE WHEN score < 0.25 THEN 'Low' WHEN score < 0.75 THEN 'Medium' ELSE 'High' END";
    expect(formatSql(sql)).toBe(
      [
        "SELECT",
        "  CASE",
        "    WHEN score < 0.25",
        "      THEN 'Low'",
        "    WHEN score < 0.75",
        "      THEN 'Medium'",
        "    ELSE 'High'",
        "  END AS bucket,",
        "  COUNT(*) AS n",
        "FROM signals",
        "GROUP BY",
        "  CASE",
        "    WHEN score < 0.25",
        "      THEN 'Low'",
        "    WHEN score < 0.75",
        "      THEN 'Medium'",
        "    ELSE 'High'",
        "  END;",
      ].join("\n"),
    );
  });

  it("adds a statement terminator so displayed and copied SQL can run directly", () => {
    expect(formatSql("SELECT County FROM schools")).toBe(["SELECT County", "FROM schools;"].join("\n"));
    expect(formatSql("SELECT County FROM schools;")).toBe(["SELECT County", "FROM schools;"].join("\n"));
  });
});
