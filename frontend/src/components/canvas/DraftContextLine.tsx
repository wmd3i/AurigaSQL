import { CornerDownRight } from "lucide-react";

/**
 * "From <card> · includes N earlier cards" under a follow-up draft's title.
 * Hovering it lists the cards the new thread will inherit.
 */
export function DraftContextLine(props: { anchorLabel: string; lines: string[] }) {
  const count = props.lines.length;
  return (
    <span className="group/ctx relative mt-0.5 inline-flex max-w-full items-center gap-1 text-[11px] text-muted">
      <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate border-b border-dotted border-faint">
        From {props.anchorLabel} · includes {count} earlier {count === 1 ? "card" : "cards"}
      </span>
      <span className="pointer-events-none absolute left-0 top-full z-40 mt-1 hidden w-max max-w-[280px] flex-col gap-0.5 rounded-lg bg-invert px-2.5 py-2 text-[11px] leading-snug text-invert-ink shadow-lg group-hover/ctx:flex">
        {props.lines.map((line, index) => (
          <span key={index} className="truncate">{line}</span>
        ))}
      </span>
    </span>
  );
}
