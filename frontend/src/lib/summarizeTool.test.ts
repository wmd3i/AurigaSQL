import { describe, expect, it } from "vitest";
import { summarizeTool } from "./summarizeTool";

const SCHEMA = `CREATE TABLE "artifactscore" (
artregistry character NOT NULL,
    PRIMARY KEY (artregistry)
);

First 3 rows:
...

CREATE TABLE "digsites" (
siteid character NOT NULL
);`;

describe("summarizeTool", () => {
  it("summarizes get_schema with table count", () => {
    expect(summarizeTool("get_schema", SCHEMA)).toBe("Loaded schema: 2 tables");
  });

  it("truncates long table lists", () => {
    const many = Array.from({ length: 8 }, (_, i) => `CREATE TABLE "t${i}" (\nx integer\n);`).join("\n");
    expect(summarizeTool("get_schema", many)).toBe("Loaded schema: 8 tables");
  });

  it("summarizes execute_sql by counting data rows (header + separator skipped)", () => {
    const result = "count\n-----\n42\n43\n44";
    expect(summarizeTool("execute_sql", result)).toBe("Returned 3 rows");
  });

  it("summarizes SQL JSON payloads by row array length instead of JSON line count", () => {
    const result = JSON.stringify(
      {
        dialect: "postgres",
        query: "SELECT * FROM signals",
        row_count: 3,
        rows: [
          { id: 1, name: "Clear" },
          { id: 2, name: "Cloudy" },
          { id: 3, name: "Partially Cloudy" },
        ],
      },
      null,
      2,
    );

    expect(summarizeTool("run_postgres_readonly", result)).toBe("Returned 3 rows");
  });

  it("falls back to returned_rows for SQL JSON payloads without row arrays", () => {
    const result = JSON.stringify({ dialect: "duckdb", returned_rows: 55, row_count: 55 }, null, 2);
    expect(summarizeTool("run_duckdb_readonly", result)).toBe("Returned 55 rows");
  });

  it("explains empty SQL JSON payloads in natural language", () => {
    const result = JSON.stringify({ dialect: "postgres", row_count: 0, rows: [] }, null, 2);
    expect(summarizeTool("run_postgres_readonly", result)).toBe("No rows matched");
  });

  it("summarizes knowledge definitions by entry count", () => {
    const result = JSON.stringify([{ knowledge: "SQI" }, { knowledge: "AAS" }]);
    expect(summarizeTool("get_all_knowledge_definitions", result)).toBe("Loaded 2 domain term definitions");
  });

  it("summarizes knowledge name browsing by topic count", () => {
    const result = JSON.stringify(["Signal-to-Noise Quality Indicator (SNQI)", "Atmospheric Observability Index (AOI)"]);
    expect(summarizeTool("get_all_external_knowledge_names", result)).toBe("Returned 2 knowledge topic names");
  });

  it("summarizes column meanings by key count", () => {
    const result = JSON.stringify({ "t.a": "meaning a", "t.b": "meaning b", "t.c": "c" });
    expect(summarizeTool("get_all_column_meanings", result)).toBe("Loaded meanings for 3 columns");
  });

  it("falls back to a generic line for unknown tools", () => {
    expect(summarizeTool("mystery_tool", "whatever")).toBe("Ran mystery tool");
  });

  it("surfaces error results regardless of tool", () => {
    expect(summarizeTool("execute_sql", "Error: relation does not exist")).toBe("⚠ Error — review details");
  });

  it("does not count the [SYSTEM NOTE: …] line as a data row", () => {
    const result = "count\n-----\n42\n\n[SYSTEM NOTE: Remaining budget: 983.0/999.0]";
    expect(summarizeTool("execute_sql", result)).toBe("Returned 1 row");
  });
});
