import { cn } from "../lib/cn";

/** A thin, hover-highlighted drag strip sitting on a panel's edge. The parent
 *  panel must be `relative`. */
export function ResizeHandle({
  edge,
  dragging,
  onPointerDown,
}: {
  edge: "left" | "right";
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={cn(
        "group absolute inset-y-0 z-20 flex w-2 cursor-col-resize touch-none select-none items-stretch justify-center",
        edge === "right" ? "-right-1" : "-left-1",
      )}
    >
      <span
        className={cn(
          "w-px transition-colors group-hover:bg-accent/60",
          dragging ? "bg-accent" : "bg-transparent",
        )}
      />
    </div>
  );
}
