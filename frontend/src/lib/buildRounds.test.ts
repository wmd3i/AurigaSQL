import { describe, expect, it } from "vitest";
import { buildRounds } from "./buildRounds";
import type { Conversation } from "../state/types";
import type { TimelineEvent } from "./buildTimeline";

function conv(timeline: TimelineEvent[], title = "Q1"): Conversation {
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
    status: "done",
    turnInFlight: false,
    sseConnected: true,
    error: null,
    createdAt: 1,
  };
}

describe("buildRounds", () => {
  it("returns a single round for one question", () => {
    const rounds = buildRounds(conv([{ kind: "final", text: "answer one" }]));
    expect(rounds).toHaveLength(1);
    expect(rounds[0].question).toBe("Q1");
    expect(rounds[0].answerText).toBe("answer one");
  });

  it("splits follow-up user messages into separate rounds, preserving each", () => {
    const timeline: TimelineEvent[] = [
      { kind: "final", text: "answer one" },
      { kind: "user_msg", text: "Q2 follow up" },
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT 2" } },
      { kind: "final", text: "answer two" },
    ];
    const rounds = buildRounds(conv(timeline));
    expect(rounds.map((r) => r.question)).toEqual(["Q1", "Q2 follow up"]);
    expect(rounds[0].answerText).toBe("answer one");
    expect(rounds[1].answerText).toBe("answer two");
    expect(rounds[1].sql).toBe("SELECT 2");
  });

  it("attaches the executed table to the submitted SQL", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1" } },
      { kind: "tool_response", name: "execute_sql", response: "n\n1" },
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT 1" } },
      { kind: "tool_response", name: "submit_sql", response: "SQL submitted (free-chat mode)" },
      { kind: "final", text: "done" },
    ];
    const r = buildRounds(conv(timeline))[0];
    expect(r.sql).toBe("SELECT 1");
    expect(r.result).toBe("n\n1");
  });

  it("falls back to the last executed result when submit SQL differs", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT a FROM t" } },
      { kind: "tool_response", name: "execute_sql", response: "a\n5" },
      { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT a FROM t LIMIT 1" } },
    ];
    const r = buildRounds(conv(timeline))[0];
    expect(r.result).toBe("a\n5");
  });

  it("skips the echoed root question so round 0 isn't duplicated", () => {
    const rounds = buildRounds(conv([{ kind: "user_msg", text: "Q1" }, { kind: "final", text: "a" }]));
    expect(rounds).toHaveLength(1);
    expect(rounds[0].question).toBe("Q1");
  });

  it("keeps ask_user answers attached to their clarification", () => {
    const timeline: TimelineEvent[] = [
      { kind: "tool_call", name: "ask_user", args: { question: "which year?" } },
      { kind: "tool_response", name: "ask_user", response: "2024" },
    ];
    const rounds = buildRounds(conv(timeline));
    expect(rounds[0].clarifications).toEqual([{ q: "which year?", a: "2024" }]);
  });
});
