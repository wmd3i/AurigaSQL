import { useCallback, useRef, useState } from "react";

type Options = {
  /** Initial width in px. */
  initial: number;
  min: number;
  max: number;
  /** Which edge hosts the drag handle. "right" grows when dragging right
   *  (left sidebar); "left" grows when dragging left (right sidebar). */
  edge: "left" | "right";
};

/** Drag-to-resize for a panel. Returns the live width plus the props to spread
 *  onto a thin handle element on the panel's edge. */
export function useResizable({ initial, min, max, edge }: Options) {
  const [width, setWidth] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setDragging(true);
      const startX = e.clientX;
      const startWidth = width;
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          const delta = ev.clientX - startX;
          const next = edge === "right" ? startWidth + delta : startWidth - delta;
          setWidth(Math.max(min, Math.min(max, next)));
        });
      };
      const onUp = (ev: PointerEvent) => {
        setDragging(false);
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {
          /* pointer may already be released */
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, min, max, edge],
  );

  return { width, dragging, onPointerDown };
}
