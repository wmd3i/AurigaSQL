import { describe, expect, it } from "vitest";
import { buildNodes } from "./buildNodes";
import type { TimelineEvent } from "./buildTimeline";

describe("buildNodes", () => {
  it("synthesizes the root question node from the title even with an empty timeline", () => {
    const nodes = buildNodes([], "list all tables");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "question", body: "list all tables" });
  });

  it("dedupes the SSE echo of the title but keeps other user messages", () => {
    const timeline: TimelineEvent[] = [
      { kind: "user_msg", text: "list all tables" }, // echo of title → skipped
      { kind: "user_msg", text: "something else" },  // kept
    ];
    const nodes = buildNodes(timeline, "list all tables");
    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({ kind: "question", body: "something else" });
  });

  it("downgrades preparatory thinking when a tool action follows", () => {
    const timeline: TimelineEvent[] = [
      { kind: "thinking", text: "I should inspect the schema" },
      { kind: "tool_call", name: "get_schema", args: {} },
      { kind: "tool_response", name: "get_schema", response: "CREATE TABLE t (...)" },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes).toHaveLength(2); // root + tool
    expect(nodes[1]).toMatchObject({
      kind: "tool",
      title: "get_schema",
      result: "CREATE TABLE t (...)",
    });
  });

  it("keeps orphaned trailing thinking visible", () => {
    const timeline: TimelineEvent[] = [{ kind: "thinking", text: "I should inspect the schema" }];
    const nodes = buildNodes(timeline, "q");
    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({ kind: "thinking", body: "I should inspect the schema" });
  });

  it("arg-less tools get an empty body, not '{}'", () => {
    const timeline: TimelineEvent[] = [{ kind: "tool_call", name: "get_schema", args: {} }];
    expect(buildNodes(timeline, "q")[1].body).toBe("");
  });

  it("renders execute_sql args.sql as the body", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1;" } },
      { kind: "tool_response", name: "execute_sql", response: "1" },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes[1]).toMatchObject({ kind: "tool", body: "SELECT 1;", result: "1", summary: "Inspect query results" });
  });

  it("stores the latest thinking as execute_sql reasoning while deriving the title from SQL", () => {
    const timeline: TimelineEvent[] = [
      { kind: "thinking", text: "I should count the rows with missing scores" },
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
    ];
    const nodes = buildNodes(timeline, "original question");
    expect(nodes[1]).toMatchObject({
      summary: "Count matching rows",
      reasoning: "Count the rows with missing scores",
    });
  });

  it("stores the latest thinking as reasoning for lookup tools", () => {
    const timeline: TimelineEvent[] = [
      { kind: "thinking", text: "I need the AOI definition to apply the formula correctly" },
      {
        kind: "tool_call",
        name: "get_knowledge_definition",
        args: { knowledge_name: "Atmospheric Observability Index (AOI)" },
      },
    ];
    const nodes = buildNodes(timeline, "original question");
    expect(nodes[1]).toMatchObject({
      title: "get_knowledge_definition",
      reasoning: "I need the AOI definition to apply the formula correctly",
    });
  });

  it("matches parallel same-name tool responses by id", () => {
    const timeline: TimelineEvent[] = [
      {
        kind: "tool_call",
        name: "get_knowledge_definition",
        id: "tooluse_aoi",
        args: { knowledge_name: "Atmospheric Observability Index (AOI)" },
      },
      {
        kind: "tool_call",
        name: "get_knowledge_definition",
        id: "tooluse_oow",
        args: { knowledge_name: "Optimal Observing Window (OOW)" },
      },
      {
        kind: "tool_response",
        name: "get_knowledge_definition",
        id: "tooluse_aoi",
        response: '{"knowledge":"Atmospheric Observability Index (AOI)"}',
      },
      {
        kind: "tool_response",
        name: "get_knowledge_definition",
        id: "tooluse_oow",
        response: '{"knowledge":"Optimal Observing Window (OOW)"}',
      },
    ];
    const nodes = buildNodes(timeline, "original question");
    expect(nodes[1]).toMatchObject({
      body: '{\n  "knowledge_name": "Atmospheric Observability Index (AOI)"\n}',
      result: '{"knowledge":"Atmospheric Observability Index (AOI)"}',
    });
    expect(nodes[2]).toMatchObject({
      body: '{\n  "knowledge_name": "Optimal Observing Window (OOW)"\n}',
      result: '{"knowledge":"Optimal Observing Window (OOW)"}',
    });
  });

  it("falls back to SQL-specific intent instead of the root question", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT COUNT(*) FROM t WHERE score IS NULL;" } },
    ];
    const nodes = buildNodes(timeline, "how many issues are there overall?");
    expect(nodes[1]).toMatchObject({ summary: "Count rows missing score" });
  });

  it("names the columns involved in execute_sql null checks", () => {
    const timeline: TimelineEvent[] = [
      {
        kind: "tool_call",
        name: "execute_sql",
        args: { sql: "SELECT COUNT(*) FROM signals WHERE snrratio IS NULL OR noisefloordbm IS NULL;" },
      },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes[1]).toMatchObject({ summary: "Count rows missing snrratio or noisefloordbm" });
  });

  it("keeps generic missing-value thinking separate from SQL-specific null-check title", () => {
    const timeline: TimelineEvent[] = [
      { kind: "thinking", text: "I should count rows with missing values" },
      {
        kind: "tool_call",
        name: "execute_sql",
        args: { sql: "SELECT COUNT(*) FROM signals WHERE snrratio IS NULL OR noisefloordbm IS NULL;" },
      },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes[1]).toMatchObject({
      summary: "Count rows missing snrratio or noisefloordbm",
      reasoning: "Count rows with missing values",
    });
  });

  it("maps ask_user call/response to one answered agent_question node", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "ask_user", args: { question: "which year?" } },
      { kind: "tool_response", name: "ask_user", response: "2024" },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({ kind: "agent_question", body: "which year?" });
    expect(nodes[1]).toMatchObject({ answer: "2024" });
  });

  it("strips trailing [SYSTEM NOTE: …] from user answers", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "ask_user", args: { question: "which year?" } },
      {
        kind: "tool_response",
        name: "ask_user",
        response: "2024\n\n[SYSTEM NOTE: Remaining budget: 995.0/999.0]",
      },
    ];
    expect(buildNodes(timeline, "q")[1].answer).toBe("2024");
  });

  it("maps submit_sql to a terminal answer node with executed result; ack response is skipped", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
      { kind: "tool_response", name: "execute_sql", response: "42" },
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
      { kind: "tool_response", name: "submit_sql", response: "SQL submitted" },
    ];
    const nodes = buildNodes(timeline, "q");
    const last = nodes[nodes.length - 1];
    expect(last).toMatchObject({ kind: "answer", body: "SELECT COUNT(*) FROM t;", result: "42" });
    // ack must not create a node
    expect(nodes.filter((n) => n.body.includes("SQL submitted"))).toHaveLength(0);
  });

  it("does not treat SQL validation as the final executed result", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
      { kind: "tool_response", name: "execute_sql", response: "count\n-----\n42" },
      { kind: "tool_call", name: "validate_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
      {
        kind: "tool_response",
        name: "validate_sql",
        response: '{"ok":true,"normalized_sql":"SELECT COUNT(*) FROM t"}',
      },
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
    ];
    const last = buildNodes(timeline, "q").at(-1)!;
    expect(last).toMatchObject({ kind: "answer", body: "SELECT COUNT(*) FROM t;", result: "count\n-----\n42" });
  });

  it("maps AgentEvent final_answer to a terminal answer node", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "run_postgres_readonly", args: { query: "SELECT COUNT(*) FROM t;" } },
      { kind: "tool_response", name: "run_postgres_readonly", response: "count\n-----\n42" },
      {
        kind: "final_answer",
        text: "```sql\nSELECT COUNT(*) FROM t;\n```",
        sql: "SELECT COUNT(*) FROM t;",
        result: "count\n-----\n42",
      },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes.at(-2)).toMatchObject({ kind: "answer", body: "SELECT COUNT(*) FROM t;", result: "count\n-----\n42" });
    expect(nodes.at(-1)).toMatchObject({ kind: "agent_text", body: "```sql\nSELECT COUNT(*) FROM t;\n```" });
  });

  it("attaches the submit_sql response as the answer result when nothing ran it before", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT 1;" } },
      { kind: "tool_response", name: "submit_sql", response: "n\n---\n1\n\n[SYSTEM NOTE: Remaining budget: 996.0/999.0]" },
    ];
    const last = buildNodes(timeline, "q").at(-1)!;
    expect(last).toMatchObject({ kind: "answer", body: "SELECT 1;", result: "n\n---\n1" });
  });

  it("strips trailing [SYSTEM NOTE: …] from the answer node's executed result", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1;" } },
      { kind: "tool_response", name: "execute_sql", response: "x\n---\n1\n\n[SYSTEM NOTE: Remaining budget: 983.0/999.0]" },
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT 1;" } },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes[nodes.length - 1].result).toBe("x\n---\n1");
  });

  it("maps final agent text to an agent_text node", () => {
    const timeline: TimelineEvent[] = [{ kind: "final", text: "All done!" }];
    const nodes = buildNodes(timeline, "q");
    expect(nodes[1]).toMatchObject({ kind: "agent_text", body: "All done!" });
  });

  it("assigns stable sequential ids", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "get_schema", args: {} },
      { kind: "tool_response", name: "get_schema", response: "ok" },
    ];
    const nodes = buildNodes(timeline, "q");
    expect(nodes.map((n) => n.id)).toEqual(["n0", "n1"]);
  });
});
