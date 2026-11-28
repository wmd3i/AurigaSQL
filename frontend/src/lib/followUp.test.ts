import { describe, expect, it } from "vitest";
import { canFollowUp, contextListLine, followUpSides } from "./followUp";

describe("canFollowUp", () => {
  it.each([
    ["question", { kind: "question" }],
    ["answer", { kind: "answer" }],
    ["agent_text", { kind: "agent_text" }],
    ["error", { kind: "error" }],
    ["finished tool", { kind: "tool", result: "3 rows" }],
    ["answered clarification", { kind: "agent_question", answer: "Ship date" }],
  ])("allows %s", (_name, card) => {
    expect(canFollowUp(card)).toBe(true);
  });

  it.each([
    ["thinking", { kind: "thinking" }],
    ["working placeholder", { kind: "working" }],
    ["tool group", { kind: "tool_group" }],
    ["running tool", { kind: "tool" }],
    ["unanswered clarification", { kind: "agent_question" }],
    ["user_answer", { kind: "user_answer" }],
  ])("refuses %s", (_name, card) => {
    expect(canFollowUp(card)).toBe(false);
  });
});

describe("followUpSides", () => {
  const base = { card: { kind: "answer" }, status: "done" as const, isLastCard: true, hasBelowBranch: false, hasBelowDraft: false };

  it("offers all three sides on the last card of a finished thread", () => {
    expect(followUpSides(base)).toEqual({ left: true, right: true, below: true });
  });

  it("has no bottom plus while the thread is still running", () => {
    expect(followUpSides({ ...base, status: "active" })).toEqual({ left: true, right: true, below: false });
  });

  it("has no bottom plus once something already continues below", () => {
    expect(followUpSides({ ...base, hasBelowBranch: true }).below).toBe(false);
    expect(followUpSides({ ...base, hasBelowDraft: true }).below).toBe(false);
  });

  it("has no bottom plus on a middle card", () => {
    expect(followUpSides({ ...base, isLastCard: false })).toEqual({ left: true, right: true, below: false });
  });

  it("offers nothing on a card that cannot be followed up", () => {
    expect(followUpSides({ ...base, card: { kind: "thinking" } })).toEqual({ left: false, right: false, below: false });
  });
});

describe("contextListLine", () => {
  it("names the thread by its question and the card by its label", () => {
    expect(contextListLine("Monthly orders", "Run SQL")).toBe("Monthly orders · Run SQL");
  });

  it("shortens long thread questions to 24 characters", () => {
    expect(contextListLine("How many artifacts are in each conservation category?", "Final Result")).toBe(
      "How many artifacts are i… · Final Result",
    );
  });
});
