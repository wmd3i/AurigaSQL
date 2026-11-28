import { describe, expect, it } from "vitest";
import {
  branchHandles,
  branchPosition,
  resolveAnchorCanvasId,
  sideSiblingIndex,
  toolBranchTotal,
  upsertBranchDraft,
  collapsedThreadIds,
  type BranchDraftKey,
} from "./branchPlacement";

const parent = { x: 1000, y: 200, width: 300, height: 100 };

describe("branchPosition", () => {
  it("places a right branch past the parent, stacking siblings downwards", () => {
    expect(branchPosition("right", parent, 300, 0)).toEqual({ x: 1500, y: 200 });
    expect(branchPosition("right", parent, 300, 2)).toEqual({ x: 1500, y: 464 });
  });

  it("mirrors the right offset on the left", () => {
    expect(branchPosition("left", parent, 300, 0)).toEqual({ x: 500, y: 200 });
  });

  it("centres a below branch under the parent", () => {
    expect(branchPosition("below", parent, 300, 0)).toEqual({ x: 1000, y: 336 });
    expect(branchPosition("below", parent, 300, 0, 94).y).toBe(394);
  });
});

describe("sideSiblingIndex", () => {
  it("counts only branches on the same side", () => {
    const siblings = [
      { id: "a", side: "below" as const },
      { id: "b", side: "right" as const },
      { id: "c", side: "right" as const },
    ];
    expect(sideSiblingIndex(siblings, "c")).toBe(1);
    expect(sideSiblingIndex(siblings, "a")).toBe(0);
  });
});

describe("branchHandles", () => {
  it("leaves from the clicked side and enters the facing side", () => {
    expect(branchHandles("right")).toEqual({ sourceHandle: "right", targetHandle: "left" });
    expect(branchHandles("left")).toEqual({ sourceHandle: "left", targetHandle: "right" });
    expect(branchHandles("below")).toEqual({ sourceHandle: "bottom", targetHandle: "top" });
  });

  it("leaves from the sub-tool while its group is open, from the group otherwise", () => {
    expect(branchHandles("right", { toolId: "n3", groupOpen: true }).sourceHandle).toBe("tool:n3");
    expect(branchHandles("right", { toolId: "n3", groupOpen: false }).sourceHandle).toBe("right");
  });
});

describe("resolveAnchorCanvasId", () => {
  const mapNode = (nodeId: string) => `P:${nodeId}`;

  it("anchors on the Error card while it exists", () => {
    expect(resolveAnchorCanvasId("P", ["P:n0", "P:n2", "P:error"], { parentNodeId: "n2", parentAnchorError: true }, mapNode)).toBe(
      "P:error",
    );
  });

  it("falls back to the last real card once the Error card is gone", () => {
    expect(resolveAnchorCanvasId("P", ["P:n0", "P:n2", "P:n5"], { parentNodeId: "n2", parentAnchorError: true }, mapNode)).toBe(
      "P:n2",
    );
  });
});

describe("toolBranchTotal", () => {
  it("adds up the branches of every sub-tool", () => {
    expect(toolBranchTotal({ n2: 1, n4: 2 })).toBe(3);
  });
});

describe("upsertBranchDraft", () => {
  it("keeps the existing draft for the same card, side and node", () => {
    const first = { id: "d1", parentCanvasNodeId: "P:n2", side: "right" as const, parentNodeId: "n2", text: "typed" };
    const again = { ...first, id: "d2", text: "" };
    const once = upsertBranchDraft([], first);
    const twice = upsertBranchDraft(once.drafts, again);
    expect(twice.drafts).toHaveLength(1);
    expect(twice.drafts[0].text).toBe("typed");
    expect(twice.selectedId).toBe("d1");
  });

  it("adds a separate draft for another side", () => {
    const right: BranchDraftKey & { id: string } = { id: "d1", parentCanvasNodeId: "P:n2", side: "right", parentNodeId: "n2" };
    const left = { ...right, id: "d2", side: "left" as const };
    expect(upsertBranchDraft([right], left)).toEqual({ drafts: [right, left], selectedId: "d2" });
  });
});

describe("collapsedThreadIds", () => {
  const branches = new Map([
    ["A:n11", [{ id: "B", side: "right" as const, parentNodeId: "n11" }, { id: "C", side: "right" as const, parentNodeId: "n11" }, { id: "D", side: "below" as const, parentNodeId: "n11" }]],
    ["B:n0", [{ id: "E", side: "left" as const, parentNodeId: "n0" }]],
    ["A:n8", [{ id: "T", side: "right" as const, parentNodeId: "n5" }, { id: "U", side: "right" as const, parentNodeId: "n6" }]],
  ]);

  it("hides every follow-up on a collapsed side, with their own follow-ups", () => {
    expect([...collapsedThreadIds(branches, new Set(["A:n11|right"]))].sort()).toEqual(["B", "C", "E"]);
  });

  it("hides only the follow-ups of a collapsed sub-tool", () => {
    expect([...collapsedThreadIds(branches, new Set(["A:n8|tool:n5"]))]).toEqual(["T"]);
  });

  it("hides nothing when nothing is collapsed", () => {
    expect(collapsedThreadIds(branches, new Set()).size).toBe(0);
  });
});
