import { describe, expect, it } from "vitest";
import { cardCopyPayload, tableToHtml, tableToTsv } from "./cardCopy";

const TABLE = `region | orders
------------
East | 12
North | 7`;

describe("cardCopyPayload", () => {
  it("copies a question's text", () => {
    expect(cardCopyPayload({ id: "n0", kind: "question", body: "  How many orders?  " })).toEqual({
      text: "How many orders?",
    });
  });

  it("includes the user's clarification on an answered agent question", () => {
    expect(
      cardCopyPayload({ id: "n2", kind: "agent_question", body: "Which year?", answer: "2024" }),
    ).toEqual({ text: "Which year?\n\nYou clarified: 2024" });
    expect(cardCopyPayload({ id: "n2", kind: "agent_question", body: "Which year?" })).toEqual({
      text: "Which year?",
    });
  });

  it("copies only the result table of a final answer, as TSV plus HTML", () => {
    const payload = cardCopyPayload({ id: "n5", kind: "answer", body: "SELECT 1", result: TABLE });
    expect(payload?.text).toBe("region\torders\nEast\t12\nNorth\t7");
    expect(payload?.html).toBe(
      "<table><thead><tr><th>region</th><th>orders</th></tr></thead>" +
        "<tbody><tr><td>East</td><td>12</td></tr><tr><td>North</td><td>7</td></tr></tbody></table>",
    );
  });

  it("falls back to the SQL when a final answer has no result", () => {
    expect(cardCopyPayload({ id: "n5", kind: "answer", body: "SELECT 1" })).toEqual({ text: "SELECT 1" });
  });

  it("copies SQL plus its result for a SQL tool", () => {
    const payload = cardCopyPayload({
      id: "n3",
      kind: "tool",
      title: "execute_sql",
      body: "SELECT region, COUNT(*) FROM orders GROUP BY 1",
      result: TABLE,
    });
    expect(payload?.text).toBe(
      "SELECT region, COUNT(*) FROM orders GROUP BY 1\n\nregion\torders\nEast\t12\nNorth\t7",
    );
    expect(payload?.html).toMatch(/^<pre>SELECT region, COUNT\(\*\) FROM orders GROUP BY 1<\/pre><table>/);
  });

  it("copies only the result for a non-SQL tool", () => {
    expect(
      cardCopyPayload({ id: "n1", kind: "tool", title: "get_schema", body: '{"table": "orders"}', result: "orders(id, region)" }),
    ).toEqual({ text: "orders(id, region)" });
  });

  it("strips the trailing system note from results", () => {
    expect(
      cardCopyPayload({ id: "n1", kind: "tool", title: "get_schema", body: "", result: "ok [SYSTEM NOTE: internal]" }),
    ).toEqual({ text: "ok" });
  });

  // Shapes below are taken from real backend sessions (dbtools.py `dump_json(rows)` etc.).
  it("turns a SQL tool's bare JSON rows into a headerless table under the SQL", () => {
    const payload = cardCopyPayload({
      id: "n6",
      kind: "tool",
      title: "run_sqlite_readonly",
      body: "SELECT d.forename, d.surname, COUNT(*) AS wins FROM results r JOIN drivers d USING (driverId) GROUP BY 1, 2",
      result: '[\n  [\n    "Michael",\n    "Schumacher",\n    91\n  ],\n  [\n    "Lewis",\n    "Hamilton",\n    60\n  ]\n]',
    });
    expect(payload?.text).toBe(
      "SELECT d.forename, d.surname, COUNT(*) AS wins FROM results r JOIN drivers d USING (driverId) GROUP BY 1, 2\n\n" +
        "Michael\tSchumacher\t91\nLewis\tHamilton\t60",
    );
    expect(payload?.html).toContain("<table><tbody><tr><td>Michael</td><td>Schumacher</td><td>91</td></tr>");
  });

  it("marks an empty SQL result and keeps SQL errors as text", () => {
    expect(
      cardCopyPayload({ id: "n4", kind: "tool", title: "run_sqlite_readonly", body: "SELECT 1 WHERE 0", result: "[]" }),
    ).toEqual({ text: "SELECT 1 WHERE 0\n\n(no rows)" });
    expect(
      cardCopyPayload({ id: "n4", kind: "tool", title: "run_sqlite_readonly", body: "SELEC 1", result: "Error executing SQL: near \"SELEC\": syntax error" }),
    ).toEqual({ text: 'SELEC 1\n\nError executing SQL: near "SELEC": syntax error' });
  });

  it("uses object keys as headers for JSON object rows", () => {
    const payload = cardCopyPayload({ id: "n4", kind: "tool", title: "execute_sql", body: "SELECT 1", result: '[{"a": 1, "b": null}]' });
    expect(payload?.text).toBe("SELECT 1\n\na\tb\n1\t");
  });

  it("copies a validation card as the SQL plus its verdict, not the raw JSON", () => {
    const sql = "SELECT COUNT(*) FROM results";
    expect(
      cardCopyPayload({
        id: "n7",
        kind: "tool",
        title: "validate_sqlite_query",
        body: sql,
        result: `{\n  "ok": true,\n  "normalized_sql": "${sql}"\n}`,
      }),
    ).toEqual({ text: `${sql}\n\nValidation passed` });
    expect(
      cardCopyPayload({
        id: "n7",
        kind: "tool",
        title: "validate_postgres_query",
        body: sql,
        result: '{"ok": false, "stage": "schema", "error": "column \\"x\\" does not exist", "next_action": "Revise"}',
      }),
    ).toEqual({ text: `${sql}\n\nNeeds revision: column "x" does not exist` });
  });

  it("strips the fence when an agent reply is one SQL code block", () => {
    expect(
      cardCopyPayload({ id: "n9", kind: "agent_text", body: "```sql\nSELECT COUNT(*)\nFROM results\n```" }),
    ).toEqual({ text: "SELECT COUNT(*)\nFROM results" });
  });

  it("leaves agent replies with prose around a code block untouched", () => {
    const body = "Here is the query:\n```sql\nSELECT 1\n```";
    expect(cardCopyPayload({ id: "n9", kind: "agent_text", body })).toEqual({ text: body });
  });

  it("copies error text", () => {
    expect(cardCopyPayload({ id: "error", kind: "error", body: "boom" })).toEqual({ text: "boom" });
  });

  it("returns null for an empty card", () => {
    expect(cardCopyPayload({ id: "n4", kind: "thinking", body: "   " })).toBeNull();
  });
});

describe("table serializers", () => {
  const table = { headers: ["a", "b"], rows: [["x\ty", "<b>&"]], truncated: true };

  it("keeps TSV cells on one line and marks truncation", () => {
    expect(tableToTsv(table)).toBe("a\tb\nx y\t<b>&\n…");
  });

  it("escapes HTML cells and marks truncation", () => {
    expect(tableToHtml(table)).toContain("<td>&lt;b&gt;&amp;</td>");
    expect(tableToHtml(table)).toContain('<td colspan="2">…</td>');
  });
});
