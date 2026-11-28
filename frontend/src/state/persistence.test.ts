import { describe, expect, it } from "vitest";
import { readBranchSide } from "./persistence";

describe("readBranchSide", () => {
  it("keeps a stored side", () => {
    expect(readBranchSide({ parentThreadId: "p", canvasBranchSide: "left" })).toBe("left");
  });

  it("maps legacy follow_up to below", () => {
    expect(readBranchSide({ parentThreadId: "p", canvasBranchKind: "follow_up" })).toBe("below");
  });

  it("maps legacy fork to right", () => {
    expect(readBranchSide({ parentThreadId: "p", canvasBranchKind: "fork" })).toBe("right");
  });

  it("treats a kindless branch as right", () => {
    expect(readBranchSide({ parentThreadId: "p" })).toBe("right");
  });

  it("returns undefined for a root thread", () => {
    expect(readBranchSide({ parentThreadId: null })).toBeUndefined();
  });
});
