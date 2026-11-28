import { CornerDownRight } from "lucide-react";

/** "From <card> · includes N earlier cards" under a follow-up draft's title. */
export function DraftContextLine(props: { anchorLabel: string; count: number }) {
  return (
    <span className="mt-0.5 inline-flex max-w-full items-center gap-1 text-[11px] text-muted">
      <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        From {props.anchorLabel} · includes {props.count} earlier {props.count === 1 ? "card" : "cards"}
      </span>
    </span>
  );
}
