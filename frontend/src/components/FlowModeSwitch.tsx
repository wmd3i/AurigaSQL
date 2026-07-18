import { MessageCircle, Workflow } from "lucide-react";
import { cn } from "../lib/cn";
import type { QueryMode } from "../state/types";

const OPTIONS: Array<{ mode: QueryMode; label: string; icon: typeof MessageCircle }> = [
  { mode: "agent", label: "Chat", icon: MessageCircle },
  { mode: "workspace", label: "Canvas", icon: Workflow },
];

export function FlowModeSwitch(props: {
  mode: QueryMode;
  onModeChange: (mode: QueryMode) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border border-line/70 bg-card/75 p-0.5 shadow-[0_3px_12px_rgba(24,32,28,0.13)] backdrop-blur transition-all duration-300 ease-out",
        props.className,
      )}
      aria-label="Switch flow mode"
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = props.mode === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            aria-pressed={active}
            onClick={() => props.onModeChange(option.mode)}
            className={cn(
              "inline-flex h-8 min-w-[78px] items-center justify-center gap-1.5 rounded-full px-3 text-[14px] font-semibold transition-all duration-300 ease-out",
              active
                ? "bg-canvas text-ink shadow-[0_2px_10px_rgba(24,32,28,0.10)]"
                : "text-muted hover:bg-hover/70 hover:text-ink",
            )}
          >
            <Icon className="h-4 w-4" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
