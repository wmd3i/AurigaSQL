import { describe, expect, it } from "vitest";
import { branchContextCards, formatNodeForBranchContext } from "./branchContext";
import type { Conversation } from "../state/types";
import type { TimelineEvent } from "./buildTimeline";

function conv(id: string, timeline: TimelineEvent[], extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    database: "db1",
    databases: ["db1"],
    mode: "workspace",
    canvasWorkId: "work",
    parentThreadId: null,
    parentNodeId: null,
    title: `${id} question`,
    summary: null,
    rawEvents: [],
    timeline,
    pendingQuestion: null,
    status: "done",
    turnInFlight: false,
    sseConnected: true,
    error: null,
    createdAt: 1,
    ...extra,
  };
}

/** One execute_sql call plus its response: becomes a single "tool" node. */
function sqlTool(callId: string, result: string): TimelineEvent[] {
  return [
    { kind: "tool_call", name: "execute_sql", args: { sql: `SELECT '${callId}'` }, id: callId },
    { kind: "tool_response", name: "execute_sql", response: result, id: callId },
  ];
}

// A: n0 question, n1 tool(A-r1), n2 tool(A-r2), n3 tool(A-r3)
const threadA = conv("A", [...sqlTool("a1", "A-r1"), ...sqlTool("a2", "A-r2"), ...sqlTool("a3", "A-r3")]);

function threadB(parentNodeId: string) {
  // B: n0 question, n1 tool(B-r1), n2 tool(B-r2)
  return conv("B", [...sqlTool("b1", "B-r1"), ...sqlTool("b2", "B-r2")], { parentThreadId: "A", parentNodeId });
}

describe("branchContextCards", () => {
  it("trims every ancestor at the card its child branched from", () => {
    const cards = branchContextCards([threadA, threadB("n1")], { parentThreadId: "B", parentNodeId: "n1", label: "x" });
    expect(cards.map((c) => `${c.threadId}:${c.node.id}`)).toEqual(["A:n0", "A:n1", "B:n0", "B:n1"]);
  });

  it("falls back to the whole ancestor when the child's parentNodeId is gone", () => {
    const cards = branchContextCards([threadA, threadB("n9")], { parentThreadId: "B", parentNodeId: "n1", label: "x" });
    expect(cards.map((c) => `${c.threadId}:${c.node.id}`)).toEqual(["A:n0", "A:n1", "A:n2", "A:n3", "B:n0", "B:n1"]);
  });

  it("returns [] when the parent thread is missing", () => {
    expect(branchContextCards([threadA], { parentThreadId: "nope", parentNodeId: "n0", label: "x" })).toEqual([]);
  });
});

describe("formatNodeForBranchContext", () => {
  it("includes the user's clarification answer", () => {
    expect(formatNodeForBranchContext({ id: "n1", kind: "agent_question", body: "Which date?", answer: "Ship date" })).toBe(
      "Assistant asked user: Which date?\nUser answered: Ship date",
    );
  });

  it("omits the answer line when the question is unanswered", () => {
    expect(formatNodeForBranchContext({ id: "n1", kind: "agent_question", body: "Which date?" })).toBe(
      "Assistant asked user: Which date?",
    );
  });
});
