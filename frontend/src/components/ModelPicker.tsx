import { useEffect, useRef, useState, type ComponentType } from "react";
import { Anthropic, Gemini, Minimax, OpenAI, XAI, ZAI } from "@lobehub/icons";
import { Check, ChevronDown, Plus, Settings2, Sparkles } from "lucide-react";
import { useModels } from "../state/modelContext";
import { cn } from "../lib/cn";

const PROVIDER_LOGO: Record<string, ComponentType<{ size: number }>> = {
  anthropic: Anthropic.Avatar,
  gemini: Gemini.Avatar,
  minimax: Minimax.Avatar,
  zai: ZAI.Avatar,
  openai: OpenAI.Avatar,
  xai: XAI.Avatar,
};

export function ModelPicker(props: {
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  settingsClassName?: string;
  showConfigButton?: boolean;
  variant?: "pill" | "inline";
  onOpenConfig?: () => void;
}) {
  const { models, selectedId, setSelectedId } = useModels();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = models.find((m) => m.id === selectedId) ?? models[0] ?? null;
  const SelectedLogo = selected ? PROVIDER_LOGO[selected.provider] : null;
  const variant = props.variant ?? "pill";

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative flex items-center gap-2", props.className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => selected && setOpen((value) => !value)}
        className={cn(
          variant === "inline"
            ? "flex min-w-[104px] items-center gap-2 rounded-full px-2 py-2 text-left text-[13.5px] transition hover:bg-hover"
            : "flex min-w-[180px] items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 text-left text-[12px] shadow-sm transition",
          variant === "inline"
            ? selected ? "text-ink" : "cursor-default opacity-95"
            : selected ? (open ? "border-accent/30 bg-card" : "hover:bg-hover") : "cursor-default opacity-95",
          props.buttonClassName,
        )}
      >
        <span className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-[5px]",
          variant === "inline" ? "h-[18px] w-[18px]" : "h-4 w-4",
        )}>
          {SelectedLogo ? <SelectedLogo size={variant === "inline" ? 18 : 16} /> : <Sparkles className={variant === "inline" ? "h-[15px] w-[15px]" : "h-3.5 w-3.5"} />}
        </span>
        <span className={cn(
          "min-w-0 flex-1 truncate",
          variant === "inline" ? "font-medium" : "font-semibold",
          variant === "inline" ? "text-muted" : selected ? "text-accent" : "text-muted",
        )}>
          {selected?.label ?? "Set up model"}
        </span>
        {selected && <ChevronDown className={cn(variant === "inline" ? "h-[15px] w-[15px]" : "h-3.5 w-3.5", "shrink-0 text-muted transition", open && "rotate-180")} />}
      </button>
      {(props.showConfigButton ?? true) && (
        <button
          type="button"
          onClick={props.onOpenConfig}
          aria-label="Open LLM Configure"
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-sm transition hover:bg-hover hover:text-ink",
            props.settingsClassName,
          )}
        >
          <Settings2 className="h-4 w-4" />
        </button>
      )}

      {open && selected && (
        <div className={cn(
          "absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-full overflow-hidden border border-line bg-card shadow-[0_18px_40px_rgba(24,32,28,0.14)]",
          variant === "inline" ? "rounded-[22px] p-2" : "rounded-3xl p-1.5",
          props.menuClassName,
        )}>
          <div role="listbox" aria-label="Model selection" className={cn("flex flex-col", variant === "inline" ? "gap-1" : "gap-1")}>
            {models.map((m) => {
              const Logo = PROVIDER_LOGO[m.provider];
              const active = m.id === selectedId;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={!m.available}
                  onClick={() => {
                    if (!m.available) return;
                    setSelectedId(m.id);
                    setOpen(false);
                  }}
                  title={m.available ? m.label : `${m.label} — no API key`}
                  className={cn(
                    "flex items-center gap-2 text-left transition",
                    variant === "inline"
                      ? "rounded-[16px] px-2.5 py-2 text-[13.5px]"
                      : "rounded-2xl px-3 py-2 text-[12px]",
                    active ? (variant === "inline" ? "bg-hover text-ink" : "bg-accent-soft text-accent") : "text-ink hover:bg-hover",
                    !m.available && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-ink",
                  )}
                >
                  <span className={cn(
                    "flex shrink-0 items-center justify-center overflow-hidden rounded-[5px]",
                    variant === "inline" ? "h-[18px] w-[18px]" : "h-4 w-4",
                  )}>
                    {Logo ? <Logo size={variant === "inline" ? 18 : 16} /> : <Sparkles className={variant === "inline" ? "h-[15px] w-[15px]" : "h-3.5 w-3.5"} />}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", variant === "inline" ? "font-medium" : "font-semibold")}>{m.label}</span>
                  {active && <Check className={cn("shrink-0", variant === "inline" ? "h-[15px] w-[15px]" : "h-3.5 w-3.5")} />}
                </button>
              );
            })}
            {props.onOpenConfig && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onOpenConfig?.();
                }}
                className={cn(
                  "mt-1 flex items-center gap-2 border-t border-line px-3 text-left font-semibold text-muted transition hover:text-ink",
                  variant === "inline" ? "px-2.5 py-2 pt-3 text-[13.5px] font-medium" : "py-2 pt-3 text-[12px]",
                )}
              >
                <Plus className={variant === "inline" ? "h-[15px] w-[15px]" : "h-3.5 w-3.5"} />
                Add Model
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
