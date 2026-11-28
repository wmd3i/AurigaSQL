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


describe("clarification bridge", () => {
  it("deduplicates delayed trajectory ask calls and preserves the accepted answer", () => {
    const timeline = buildTimeline([
      { type: "clarification_request", question: "Which drivers?" },
      { type: "clarification_answer", answer: "All drivers" },
      { type: "tool_call", id: "ask-1", name: "ask", args: { question: "Which drivers?" } },
      { type: "tool_result", id: "ask-1", name: "ask", result: "All drivers" },
    ]);
    expect(timeline).toEqual([
      { kind: "tool_call", name: "ask_user", args: { question: "Which drivers?" } },
      { kind: "tool_response", name: "ask_user", response: "All drivers" },
    ]);
  });
  it("does not duplicate a question already streamed from the trajectory", () => {
    const timeline = buildTimeline([
      { type: "tool_call", id: "ask-1", name: "ask", args: { question: "Which drivers?" } },
      { type: "clarification_request", question: "Which drivers?" },
    ]);
    expect(timeline).toHaveLength(1);
  });
});


it("keeps one answer when trajectory streaming precedes the IPC question", () => {
  const timeline = buildTimeline([
    { type: "tool_call", id: "a", name: "ask", args: { question: "Which?" } },
    { type: "clarification_request", question: "Which?" },
    { type: "clarification_answer", answer: "All" },
    { type: "tool_result", id: "a", name: "ask", result: "All" },
  ]);
  expect(timeline).toHaveLength(2);
});
