import type { MouseEvent } from "react";
import { Plus } from "lucide-react";
import { cn } from "../../lib/cn";

export type FollowUpPlusSide = "left" | "right" | "bottom";

const POSITION: Record<FollowUpPlusSide, string> = {
  left: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
  right: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
  bottom: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2",
};

const SIDE_TEXT: Record<FollowUpPlusSide, string> = { left: "on the left", right: "on the right", bottom: "below" };

/* Hover classes per scope, spelled out so Tailwind keeps them. */
const HOVER = {
  card: "group-hover:opacity-100",
  tool: "group-hover/tool:opacity-100",
};

const BADGE = "flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-none shadow-sm";
const RING = "flex items-center justify-center rounded-full border-[1.5px] border-ink bg-card text-ink shadow-[0_3px_10px_rgba(15,23,42,0.16)]";
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-accent";

function stop(handler: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

/**
 * Follow-up controls on one edge of a card. With no follow-ups yet: a plus,
 * hidden until the card is hovered, selected or focused. With follow-ups: a
 * count that collapses / expands them, plus a separate "+" that adds another.
 */
export function FollowUpPlus(props: {
  side: FollowUpPlusSide;
  available: boolean;
  selected: boolean;
  count?: number;
  collapsed?: boolean;
  hoverScope?: keyof typeof HOVER;
  onClick: () => void;
  onToggle?: () => void;
}) {
  const count = props.count ?? 0;
  const hover = HOVER[props.hoverScope ?? "card"];
  const addLabel = `Follow up ${SIDE_TEXT[props.side]}`;
  if (!props.available && count === 0) return null;

  // "group" on a button lets its own keyboard focus reveal the plus, like hovering the card does.
  const plus = (
    <button
      type="button"
      aria-label={addLabel}
      title={addLabel}
      onClick={stop(props.onClick)}
      className={cn("nodrag nopan group rounded-full", FOCUS)}
    >
      <span className={cn(RING, "h-[26px] w-[26px] transition-opacity", !props.selected && cn("opacity-0 group-focus-visible:opacity-100", hover))}>
        <Plus className="h-3.5 w-3.5" strokeWidth={2.6} aria-hidden="true" />
      </span>
    </button>
  );

  if (count === 0) return <span className={cn("absolute z-30 flex", POSITION[props.side])}>{plus}</span>;

  const countText = `${count} follow-up${count === 1 ? "" : "s"} ${SIDE_TEXT[props.side]}`;
  const countStyle = props.collapsed ? "border-[1.5px] border-ink bg-card text-ink" : "bg-invert text-invert-ink";
  const countBadge = props.onToggle ? (
    <button
      type="button"
      aria-label={`${props.collapsed ? "Show" : "Hide"} ${countText}`}
      title={`${props.collapsed ? "Show" : "Hide"} ${countText}`}
      data-collapsed={props.collapsed ? "true" : "false"}
      onClick={stop(props.onToggle)}
      className={cn("nodrag nopan", BADGE, countStyle, FOCUS)}
    >
      {count}
    </button>
  ) : (
    <span className={cn("pointer-events-none", BADGE, countStyle)}>{count}</span>
  );

  return (
    <span className={cn("absolute z-30 flex items-center gap-1", props.side === "left" && "flex-row-reverse", POSITION[props.side])}>
      {countBadge}
      {props.available && plus}
    </span>
  );
}
