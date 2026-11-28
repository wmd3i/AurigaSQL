/** The parts of a React Flow internal node this check reads. */
export type InternalNodeLike = {
  hidden?: boolean;
  measured?: { width?: number; height?: number };
  internals: { handleBounds?: unknown };
};

/**
 * Ids of nodes that React Flow has sized but whose handle bounds are missing.
 *
 * Rebuilding the node list in quick succession can drop a node's handle bounds
 * after its first measurement. The card stays visible, but React Flow does not
 * measure it again until its size changes, so edges to it are not drawn.
 * Forcing `updateNodeInternals` on these ids restores the handles.
 */
export function nodesMissingHandles(
  ids: string[],
  getInternalNode: (id: string) => InternalNodeLike | undefined,
): string[] {
  return ids.filter((id) => {
    const node = getInternalNode(id);
    if (!node || node.hidden) return false;
    const sized = Boolean(node.measured?.width && node.measured?.height);
    return sized && !node.internals.handleBounds;
  });
}
