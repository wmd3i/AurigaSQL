import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

const ZOOM_PRESETS = [50, 75, 90, 100, 125, 150, 175, 200];

export function CanvasZoomControl(props: {
  percent: number;
  embedded?: boolean;
  onChange: (percent: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const cancelled = useRef(false);

  useEffect(() => {
    if (!open) return;
    const options = menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]");
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (selected ?? options?.[0])?.focus();
    function dismiss(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function commit() {
    if (!cancelled.current && draft !== null) {
      const value = draft.trim().replace(/%$/, "").trim();
      if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
        const percent = Number(value);
        if (Number.isFinite(percent)) props.onChange(Math.min(200, Math.max(20, percent)));
      }
    }
    cancelled.current = false;
    setDraft(null);
  }

  return (
    <div
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      className={cn(
        "relative flex items-center rounded border border-transparent font-semibold text-ink focus-within:border-accent/40 focus-within:bg-accent/5",
        open && "border-line bg-hover",
        props.embedded ? "h-6 text-[12px]" : "h-7 text-[13px]",
      )}
    >
      <input
        aria-label="Canvas zoom percentage"
        title="Enter zoom percentage (20–200%)"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={draft ?? `${props.percent}%`}
        onFocus={(event) => {
          setOpen(false);
          cancelled.current = false;
          setDraft(`${props.percent}%`);
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            cancelled.current = event.key === "Escape";
            event.currentTarget.blur();
          }
        }}
        className="h-full w-[54px] rounded-l-lg bg-transparent px-1 py-0 text-center leading-normal tabular-nums outline-none"
      />
      <button
        ref={toggleRef}
        type="button"
        aria-label="Canvas zoom presets"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Choose zoom percentage"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
        className="flex h-full w-5 items-center justify-center rounded-r hover:bg-hover focus:outline-none"
      >
        <ChevronDown aria-hidden="true" className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Zoom percentages"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              toggleRef.current?.focus();
            }
            const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
            const index = options.indexOf(document.activeElement as HTMLButtonElement);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
              options[next]?.focus();
            }
          }}
          className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-full overflow-hidden rounded border border-line bg-white py-1 text-[13px] font-normal shadow-[0_3px_10px_rgba(0,0,0,0.16)]"
        >
          {ZOOM_PRESETS.map((percent) => (
            <button
              key={percent}
              type="button"
              role="menuitemradio"
              aria-checked={props.percent === percent}
              tabIndex={-1}
              onClick={() => {
                setDraft(null);
                props.onChange(percent);
                setOpen(false);
                toggleRef.current?.focus();
              }}
              className={cn(
                "block w-full px-3 py-2 text-left outline-none hover:bg-neutral-100 focus:bg-neutral-100",
                props.percent === percent && "bg-neutral-100",
              )}
            >
              {percent}%
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
