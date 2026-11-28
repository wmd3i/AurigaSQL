/** Header of a follow-up thread's first card: "Follow-up · ← <source card>", the source being a jump link. */
export function FollowUpOrigin(props: { label: string; onJump: () => void }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] font-medium">
      <span className="shrink-0 text-accent">Follow-up</span>
      <span className="shrink-0 text-faint" aria-hidden="true">·</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          props.onJump();
        }}
        aria-label={`Go to ${props.label}, where this follow-up started`}
        title={`Go to ${props.label}`}
        className="nodrag nopan min-w-0 truncate text-muted underline decoration-faint underline-offset-2 hover:text-ink"
      >
        ← {props.label}
      </button>
    </span>
  );
}
