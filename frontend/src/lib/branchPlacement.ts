import type { CanvasBranchSide } from "../state/types";

export const BRANCH_MIN_X_OFFSET = 500;
export const BRANCH_X_PADDING = 180;
export const BRANCH_GAP_Y = 36;
export const BRANCH_SIBLING_Y = 132;
export const DRAFT_BELOW_GAP_Y = 94;

export type Rect = { x: number; y: number; width: number; height: number };

/** Top-left of a follow-up started from `parent` on `side`; siblings on the same side stack downwards. */
export function branchPosition(
  side: CanvasBranchSide,
  parent: Rect,
  childWidth: number,
  siblingIndex: number,
  belowGap = BRANCH_GAP_Y,
): { x: number; y: number } {
  if (side === "below") {
    return { x: parent.x + parent.width / 2 - childWidth / 2, y: parent.y + parent.height + belowGap };
  }
  const y = parent.y + siblingIndex * BRANCH_SIBLING_Y;
  if (side === "right") {
    return { x: parent.x + Math.max(BRANCH_MIN_X_OFFSET, parent.width + BRANCH_X_PADDING), y };
  }
  const gap = Math.max(BRANCH_MIN_X_OFFSET - parent.width, BRANCH_X_PADDING);
  return { x: parent.x - gap - childWidth, y };
}

/** Position of `id` among the branches that share its side (array order). */
export function sideSiblingIndex(siblings: Array<{ id: string; side: CanvasBranchSide }>, id: string): number {
  const side = siblings.find((sibling) => sibling.id === id)?.side;
  return siblings.filter((sibling) => sibling.side === side).findIndex((sibling) => sibling.id === id);
}

/** React Flow handle ids for a branch edge: leave from the clicked side, enter the facing side. */
export function branchHandles(
  side: CanvasBranchSide,
  subTool?: { toolId: string; groupOpen: boolean },
): { sourceHandle: string; targetHandle: string } {
  if (side === "below") return { sourceHandle: "bottom", targetHandle: "top" };
  if (side === "left") return { sourceHandle: "left", targetHandle: "right" };
  return { sourceHandle: subTool?.groupOpen ? `tool:${subTool.toolId}` : "right", targetHandle: "left" };
}

/**
 * Canvas id of the card a branch hangs from. A follow-up started from the
 * Error card hangs from it while it exists, then from the last real card.
 */
export function resolveAnchorCanvasId(
  parentThreadId: string,
  parentCardIds: string[],
  child: { parentNodeId: string; parentAnchorError?: boolean },
  mapNode: (nodeId: string) => string,
): string {
  const errorCardId = `${parentThreadId}:error`;
  if (child.parentAnchorError && parentCardIds.includes(errorCardId)) return errorCardId;
  return mapNode(child.parentNodeId);
}

export function toolBranchTotal(countsByTool: Record<string, number>): number {
  return Object.values(countsByTool).reduce((sum, count) => sum + count, 0);
}

export type BranchDraftKey = { parentCanvasNodeId: string; side: CanvasBranchSide; parentNodeId: string };

/** Add a draft unless one already exists for the same card, side and node; either way say which to select. */
export function upsertBranchDraft<T extends BranchDraftKey & { id: string }>(
  drafts: T[],
  next: T,
): { drafts: T[]; selectedId: string } {
  const existing = drafts.find(
    (draft) =>
      draft.parentCanvasNodeId === next.parentCanvasNodeId &&
      draft.side === next.side &&
      draft.parentNodeId === next.parentNodeId,
  );
  if (existing) return { drafts, selectedId: existing.id };
  return { drafts: [...drafts, next], selectedId: next.id };
}

/**
 * Threads hidden by collapsed follow-up groups. A key is `<anchor canvas id>|<side>`
 * for a card side, or `<anchor canvas id>|tool:<tool node id>` for a sub-tool.
 * A hidden thread's own follow-ups are hidden with it.
 */
export function collapsedThreadIds(
  branchesByAnchor: Map<string, Array<{ id: string; side: CanvasBranchSide; parentNodeId: string }>>,
  collapsedKeys: Set<string>,
): Set<string> {
  const hidden = new Set<string>();
  const queue: string[] = [];
  branchesByAnchor.forEach((branches, anchor) => {
    branches.forEach((branch) => {
      if (collapsedKeys.has(`${anchor}|${branch.side}`) || collapsedKeys.has(`${anchor}|tool:${branch.parentNodeId}`)) {
        queue.push(branch.id);
      }
    });
  });
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (hidden.has(id)) continue;
    hidden.add(id);
    branchesByAnchor.forEach((branches, anchor) => {
      if (anchor.startsWith(`${id}:`)) branches.forEach((branch) => queue.push(branch.id));
    });
  }
  return hidden;
}
