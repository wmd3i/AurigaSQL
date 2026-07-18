import { describe, expect, it } from "vitest";
import { resolveCanvasRowY, type CanvasLayoutBlocker } from "./canvasLayout";

const blocker = (top: number, bottom: number, left = 0, right = 300): CanvasLayoutBlocker => ({
  top,
  bottom,
  left,
  right,
});

describe("resolveCanvasRowY", () => {
  it("places a row below a chain of overlapping cards", () => {
    expect(resolveCanvasRowY(40, 90, 50, 0, 300, [blocker(20, 120), blocker(150, 250)])).toBe(300);
  });

  it("does not move for cards outside the row column", () => {
    expect(resolveCanvasRowY(40, 90, 50, 0, 300, [blocker(20, 120, 400, 700)])).toBe(40);
  });

  it("ignores invalid measurements instead of stalling layout", () => {
    expect(
      resolveCanvasRowY(40, Number.NaN, 50, 0, 300, [
        blocker(Number.NaN, Number.NaN),
        blocker(20, 120),
      ]),
    ).toBe(170);
  });
});
