import { describe, expect, it } from "vitest";
import { extractAgentResult } from "./extractAgentResult";
import type { TimelineEvent } from "./buildTimeline";
import type { Conversation } from "../state/types";

function conv(timeline: TimelineEvent[], title = "q"): Conversation {
  return {
    id: "t1",
    database: "db1",
    databases: ["db1"],
    mode: "agent",
    canvasWorkId: null,
    parentThreadId: null,
    parentNodeId: null,
    title,
    summary: null,
    rawEvents: [],
    timeline,
    pendingQuestion: null,
    status: "active",
    turnInFlight: false,
    sseConnected: true,
    error: null,
    createdAt: 1,
  };
}

const TABLE = "id | name\n------\n1 | a\n2 | b";

describe("extractAgentResult", () => {
  it("returns nulls for an empty timeline (only the synthesized question)", () => {
    const r = extractAgentResult(conv([]));
    expect(r).toMatchObject({ answerText: null, sql: null, result: null, steps: 0, currentStep: null });
  });

  it("reports the latest reasoning/tool step as a friendly live label", () => {
    expect(extractAgentResult(conv([{ kind: "thinking", text: "hmm" }])).currentStep).toBe("Thinking");
    expect(
      extractAgentResult(
        conv([{ kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1" } }]),
      ).currentStep,
    ).toBe("Running SQL");
    expect(
      extractAgentResult(conv([{ kind: "tool_call", name: "get_schema", args: {} }])).currentStep,
    ).toBe("Reading the schema");
  });

  it("attaches the executed result to the submitted SQL and counts process steps", () => {
    const timeline: TimelineEvent[] = [
      { kind: "thinking", text: "look at schema" },
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT * FROM t" } },
      { kind: "tool_response", name: "execute_sql", response: TABLE },
      { kind: "final", text: "Here are the rows." },
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT * FROM t" } },
    ];
    const r = extractAgentResult(conv(timeline));
    expect(r.sql).toBe("SELECT * FROM t");
    expect(r.result).toBe(TABLE);
    expect(r.answerText).toBe("Here are the rows.");
    expect(r.steps).toBe(1); // preparatory thinking is downgraded; execute_sql remains visible
  });

  it("strips the [SYSTEM NOTE: Remaining budget …] hint from the result", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1" } },
      {
        kind: "tool_response",
        name: "execute_sql",
        response: `${TABLE}\n\n[SYSTEM NOTE: Remaining budget: 995.0/999.0]`,
      },
    ];
    const r = extractAgentResult(conv(timeline));
    expect(r.result).toBe(TABLE);
    expect(r.result).not.toContain("Remaining budget");
  });

  it("falls back to the latest execute_sql result while no SQL has been submitted yet", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1" } },
      { kind: "tool_response", name: "execute_sql", response: TABLE },
    ];
    const r = extractAgentResult(conv(timeline));
    expect(r.sql).toBe("SELECT 1");
    expect(r.result).toBe(TABLE);
    expect(r.answerText).toBeNull();
  });

  it("does not treat a last tool result as final after a turn ends without an answer", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "run_postgres_readonly", args: { sql: "SELECT datname FROM pg_database" } },
      { kind: "tool_response", name: "run_postgres_readonly", response: TABLE },
    ];
    const r = extractAgentResult({ ...conv(timeline), status: "done" });
    expect(r.sql).toBeNull();
    expect(r.result).toBeNull();
  });
});
