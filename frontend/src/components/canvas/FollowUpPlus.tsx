import type { MouseEvent } from "react";
import { Plus } from "lucide-react";
import { cn } from "../../lib/cn";

export type FollowUpPlusSide = "left" | "right" | "bottom";

const POSITION: Record<FollowUpPlusSide, string> = {
  left: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
  right: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
  bottom: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2",
};

const LABEL: Record<FollowUpPlusSide, string> = {
  left: "Follow up on the left",
  right: "Follow up on the right",
  bottom: "Follow up below",
};

/* Hover classes per scope, spelled out so Tailwind keeps them. */
const HOVER = {
  card: { show: "group-hover:opacity-100", hide: "group-hover:hidden", flex: "group-hover:flex" },
  tool: { show: "group-hover/tool:opacity-100", hide: "group-hover/tool:hidden", flex: "group-hover/tool:flex" },
};

const BADGE = "h-[22px] min-w-[22px] items-center justify-center rounded-full bg-invert px-1.5 text-[11px] font-semibold leading-none text-invert-ink shadow-sm";
const RING = "items-center justify-center rounded-full border-[1.5px] border-ink bg-card text-ink shadow-[0_3px_10px_rgba(15,23,42,0.16)]";

/**
 * The plus button on one edge of a card. Hidden until the card is hovered or
 * selected; a side that already has branches always shows their count, which
 * turns into "+ N" on hover.
 */
export function FollowUpPlus(props: {
  side: FollowUpPlusSide;
  available: boolean;
  selected: boolean;
  count?: number;
  hoverScope?: keyof typeof HOVER;
  onClick: () => void;
}) {
  const count = props.count ?? 0;
  const hover = HOVER[props.hoverScope ?? "card"];
  if (!props.available && count === 0) return null;

  if (!props.available) {
    return <span className={cn("pointer-events-none absolute z-30 flex", POSITION[props.side], BADGE)}>{count}</span>;
  }

  const label = count > 0 ? `${LABEL[props.side]} (${count} already)` : LABEL[props.side];
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    props.onClick();
  };

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("nodrag nopan absolute z-30 flex", POSITION[props.side])}
    >
      {count > 0 ? (
        <>
          <span className={cn(BADGE, props.selected ? "hidden" : cn("flex", hover.hide))}>{count}</span>
          <span className={cn(RING, "h-[26px] gap-0.5 px-2 text-[11px] font-semibold", props.selected ? "flex" : cn("hidden", hover.flex))}>
            <Plus className="h-3 w-3" strokeWidth={2.6} aria-hidden="true" />
            {count}
          </span>
        </>
      ) : (
        <span className={cn(RING, "flex h-[26px] w-[26px] transition-opacity", !props.selected && cn("opacity-0", hover.show))}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2.6} aria-hidden="true" />
        </span>
      )}
    </button>
  );
}
