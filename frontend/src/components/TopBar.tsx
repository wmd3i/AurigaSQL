import { Loader2, Plus } from "lucide-react";
import { cn } from "../lib/cn";
import type { ConversationStatus } from "../state/types";

const STATUS: Record<ConversationStatus, { label: string; cls: string; spin?: boolean }> = {
  starting: { label: "Starting", cls: "text-muted", spin: true },
  active: { label: "Working", cls: "text-accent", spin: true },
  waiting_user: { label: "Needs input", cls: "text-accent" },
  done: { label: "Done", cls: "text-accent" },
  stopped: { label: "Stopped", cls: "text-muted" },
  error: { label: "Error", cls: "text-danger" },
};

export function TopBar(props: {
  status?: ConversationStatus | null;
  onNewFlow: () => void;
}) {
  const s = props.status && props.status !== "waiting_user" ? STATUS[props.status] : null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 text-[13px]">
      <button
        aria-label="Home"
        onClick={props.onNewFlow}
        className="flex h-7 w-7 items-center justify-center rounded text-ink hover:bg-hover"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
          <path
            d="M5 5h14M5 12h10M5 19h14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>

      <span className="text-line">|</span>

      <div className="flex-1" />

      {s && (
        <span className={cn("flex items-center gap-1.5 text-[12px] font-medium", s.cls)}>
          {s.spin ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          )}
          {s.label}
        </span>
      )}

      <button
        onClick={props.onNewFlow}
        className="flex items-center gap-1.5 rounded-md border border-line bg-card px-3 py-1.5 text-[13px] font-medium text-ink shadow-sm hover:bg-hover"
      >
        <Plus className="h-3.5 w-3.5" />
        New query
      </button>
    </header>
  );
}
