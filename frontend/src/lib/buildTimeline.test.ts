import { describe, expect, it } from "vitest";
import { buildTimeline } from "./buildTimeline";

describe("buildTimeline", () => {
  it("maps user_message to user_msg", () => {
    expect(buildTimeline([{ type: "user_message", message: "hi" }])).toEqual([
      { kind: "user_msg", text: "hi" },
    ]);
  });

  it("maps non-final model text to thinking", () => {
    const t = buildTimeline([
      { type: "adk_event", final: false, content: { role: "model", parts: [{ type: "text", text: "let me check" }] } },
    ]);
    expect(t).toEqual([{ kind: "thinking", text: "let me check" }]);
  });

  it("maps final model text ONLY to final (no duplicate thinking row)", () => {
    const t = buildTimeline([
      { type: "adk_event", final: true, content: { role: "model", parts: [{ type: "text", text: "answer" }] } },
    ]);
    expect(t).toEqual([{ kind: "final", text: "answer" }]);
  });

  it("maps tool calls and preserves full tool responses", () => {
    const long = "x".repeat(3000);
    const t = buildTimeline([
      { type: "adk_event", content: { role: "model", parts: [{ type: "function_call", name: "execute_sql", args: { sql: "SELECT 1" } }] } },
      { type: "adk_event", content: { role: "tool", parts: [{ type: "function_response", name: "execute_sql", response: long }] } },
    ]);
    expect(t[0]).toEqual({ kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1" } });
    expect(t[1].kind).toBe("tool_response");
    expect((t[1] as { response: string }).response).toHaveLength(3000);
  });

  it("maps AgentEvent tool and final answer events", () => {
    const t = buildTimeline([
      { type: "user_message", text: "question" },
      { type: "tool_call", id: "c1", name: "run_postgres_readonly", args: { query: "SELECT 1" } },
      { type: "tool_result", id: "c1", name: "run_postgres_readonly", result: "n\n-\n1" },
      { type: "final_answer", text: "```sql\nSELECT 1\n```", sql: "SELECT 1", result: "n\n-\n1" },
      { type: "done" },
    ]);
    expect(t).toEqual([
      { kind: "user_msg", text: "question" },
      { kind: "tool_call", id: "c1", name: "run_postgres_readonly", args: { query: "SELECT 1" } },
      { kind: "tool_response", id: "c1", name: "run_postgres_readonly", response: "n\n-\n1" },
      { kind: "final_answer", text: "```sql\nSELECT 1\n```", sql: "SELECT 1", result: "n\n-\n1" },
    ]);
  });

  it("strips trailing system budget notes from tool responses", () => {
    const t = buildTimeline([
      {
        type: "adk_event",
        content: {
          role: "tool",
          parts: [
            {
              type: "function_response",
              name: "execute_sql",
              response: "count\n-----\n1\n\n[SYSTEM NOTE: Remaining budget: 994.0/999.0]",
            },
          ],
        },
      },
    ]);
    expect(t).toEqual([{ kind: "tool_response", name: "execute_sql", response: "count\n-----\n1" }]);
  });

  it("returns [] for empty/undefined", () => {
    expect(buildTimeline(undefined)).toEqual([]);
    expect(buildTimeline([])).toEqual([]);
  });
});
