import { describe, expect, it } from "vitest";
import { branchContextCards, buildBranchParentContext, formatNodeForBranchContext } from "./branchContext";
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

describe("buildBranchParentContext", () => {
  // n0 question, then n1..n10 tools; tool i's result is "MARK<i> " + 2000 x's
  const longThread = conv(
    "L",
    Array.from({ length: 10 }, (_, i) => sqlTool(`l${i + 1}`, `MARK${i + 1} ${"x".repeat(2000)}`)).flat(),
  );

  it("keeps the anchor card and drops the oldest cards when over the limit", () => {
    const text = buildBranchParentContext([longThread], { parentThreadId: "L", parentNodeId: "n10", label: "x" })!;
    expect(text.length).toBeLessThanOrEqual(14000);
    expect(text).toContain("Original user query:");
    expect(text).toContain("MARK10");
    expect(text).not.toContain("MARK1 ");
    expect(text).toMatch(/\[\d+ earlier cards omitted\]/);
  });

  it("excludes cards after a mid-thread anchor", () => {
    const text = buildBranchParentContext([threadA], { parentThreadId: "A", parentNodeId: "n2", label: "x" })!;
    expect(text).toContain("A-r2");
    expect(text).not.toContain("A-r3");
  });

  it("appends the error line when branching from an error card", () => {
    const failed = conv("E", sqlTool("e1", "E-r1"), { status: "error", error: "boom" });
    const text = buildBranchParentContext([failed], { parentThreadId: "E", parentNodeId: "n1", label: "Error", anchorError: true })!;
    expect(text.endsWith("Thread ended with error: boom")).toBe(true);
  });

  it("has no omitted line for a single-card thread", () => {
    const text = buildBranchParentContext([conv("S", [])], { parentThreadId: "S", parentNodeId: "n0", label: "x" })!;
    expect(text).toContain("S question");
    expect(text).not.toMatch(/omitted/);
  });

  it("stays within the limit even when the anchor card alone is too long", () => {
    const big = conv("G", sqlTool("g1", "y".repeat(8000)));
    const text = buildBranchParentContext([big], { parentThreadId: "G", parentNodeId: "n1", label: "x" }, 3000)!;
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain("[Card 2: tool/execute_sql]");
  });

  it("keeps the anchor card even when the error message alone exceeds the limit", () => {
    const failed = conv("E", sqlTool("e1", "E-r1"), { status: "error", error: "z".repeat(20000) });
    const text = buildBranchParentContext([failed], { parentThreadId: "E", parentNodeId: "n1", label: "Error", anchorError: true })!;
    expect(text.length).toBeLessThanOrEqual(14000);
    expect(text).toContain("[Card 2: tool/execute_sql]");
    expect(text).toContain("E-r1");
  });

  it("keeps the anchor card even when the original question alone exceeds the limit", () => {
    const longTitle = conv("T", sqlTool("t1", "T-r1"), { title: "q".repeat(20000) });
    const text = buildBranchParentContext([longTitle], { parentThreadId: "T", parentNodeId: "n1", label: "x" })!;
    expect(text.length).toBeLessThanOrEqual(14000);
    expect(text).toContain("T-r1");
  });

  it("returns undefined without a target", () => {
    expect(buildBranchParentContext([threadA], null)).toBeUndefined();
  });
});
