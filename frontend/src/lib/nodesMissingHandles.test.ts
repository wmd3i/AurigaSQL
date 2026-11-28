import { describe, expect, it } from "vitest";
import { nodesMissingHandles, type InternalNodeLike } from "./nodesMissingHandles";

function lookup(nodes: Record<string, InternalNodeLike | undefined>) {
  return (id: string) => nodes[id];
}

const bounds = { source: [], target: [] };

describe("nodesMissingHandles", () => {
  it("returns sized nodes whose handle bounds were dropped", () => {
    const get = lookup({
      a: { measured: { width: 320, height: 90 }, internals: { handleBounds: undefined } },
      b: { measured: { width: 320, height: 90 }, internals: { handleBounds: bounds } },
    });
    expect(nodesMissingHandles(["a", "b"], get)).toEqual(["a"]);
  });

  it("skips nodes React Flow has not measured yet (their first measurement sets the handles)", () => {
    const get = lookup({
      fresh: { measured: { width: undefined, height: undefined }, internals: { handleBounds: undefined } },
      half: { measured: { width: 320, height: undefined }, internals: { handleBounds: undefined } },
    });
    expect(nodesMissingHandles(["fresh", "half"], get)).toEqual([]);
  });

  it("skips hidden and unknown nodes", () => {
    const get = lookup({
      hidden: { hidden: true, measured: { width: 320, height: 90 }, internals: { handleBounds: undefined } },
    });
    expect(nodesMissingHandles(["hidden", "missing"], get)).toEqual([]);
  });
});
