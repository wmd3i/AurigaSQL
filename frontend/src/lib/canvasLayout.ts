export type CanvasLayoutBlocker = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

function isFiniteBlocker(blocker: CanvasLayoutBlocker) {
  return (
    Number.isFinite(blocker.top) &&
    Number.isFinite(blocker.bottom) &&
    Number.isFinite(blocker.left) &&
    Number.isFinite(blocker.right) &&
    blocker.bottom >= blocker.top &&
    blocker.right >= blocker.left
  );
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

export function resolveCanvasRowY(
  desiredY: number,
  rowHeight: number,
  rowGap: number,
  rowLeft: number,
  rowRight: number,
  blockers: CanvasLayoutBlocker[],
) {
  const safeDesiredY = Number.isFinite(desiredY) ? desiredY : 0;
  const safeRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const safeRowGap = Number.isFinite(rowGap) && rowGap >= 0 ? rowGap : 0;
  if (!Number.isFinite(rowLeft) || !Number.isFinite(rowRight) || rowRight < rowLeft) {
    return safeDesiredY;
  }

  const ordered = blockers
    .filter(
      (blocker) =>
        isFiniteBlocker(blocker) &&
        rangesOverlap(rowLeft, rowRight, blocker.left, blocker.right),
    )
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom);

  let rowY = safeDesiredY;
  for (const blocker of ordered) {
    if (blocker.bottom <= rowY - safeRowGap) continue;
    if (blocker.top >= rowY + safeRowHeight + safeRowGap) break;
    rowY = blocker.bottom + safeRowGap;
  }
  return rowY;
}
