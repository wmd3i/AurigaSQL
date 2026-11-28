import { useState } from "react";
import { Ban } from "lucide-react";
import { cn } from "../../lib/cn";
import { setHistoryIconStyle, useHistoryIconStyle, type HistoryIconStyle } from "../../lib/historyIcons";
import { HISTORY_AVATAR_COUNTS, HistoryAvatar } from "../home/HistoryAvatar";

/* Each set's name and the icon that stands for it on its tile. */
const OPTIONS: Array<{ id: HistoryIconStyle; label: string; sample: number }> = [
  { id: "retroPets", label: "Retro Pets", sample: 0 },
  { id: "pets", label: "Pets", sample: 0 },
  { id: "starSketch", label: "Star Sketch", sample: 4 },
  { id: "starSeal", label: "Star Seal", sample: 0 },
  { id: "retroData", label: "Retro Data", sample: 0 },
  { id: "retroBlobs", label: "Retro Blobs", sample: 0 },
  { id: "off", label: "Off", sample: 0 },
];

/** Settings › General › History icons: pick the set that marks History entries.
 *  Hovering (or focusing) a tile previews that set's full range below the row. */
export function HistoryIconPicker() {
  const style = useHistoryIconStyle();
  const [previewing, setPreviewing] = useState<HistoryIconStyle | null>(null);
  const shown = OPTIONS.find((option) => option.id === (previewing ?? style)) ?? OPTIONS[0];

  return (
    <div className="space-y-3" onMouseLeave={() => setPreviewing(null)}>
      {/* Seven equal tiles span the full width, matching the preview box below. */}
      <div role="radiogroup" aria-label="History icons" className="grid grid-cols-7 gap-2">
        {OPTIONS.map((option) => {
          const active = style === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.label}
              onClick={() => setHistoryIconStyle(option.id)}
              onMouseEnter={() => setPreviewing(option.id)}
              onFocus={() => setPreviewing(option.id)}
              onBlur={() => setPreviewing(null)}
              className={cn(
                "group relative flex aspect-square items-center justify-center rounded-2xl border transition",
                active ? "border-accent bg-accent-soft" : "border-line hover:bg-hover",
              )}
            >
              {option.id === "off" ? (
                <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-faint text-faint">
                  <Ban className="h-5 w-5" />
                </span>
              ) : (
                <HistoryAvatar seed="" set={option.id} index={option.sample} className="h-11 w-11 text-muted" />
              )}
              {/* Instant name on hover / keyboard focus, like the accent swatches. */}
              <span
                aria-hidden
                className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-invert px-2 py-0.5 text-[11.5px] font-medium text-invert-ink opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                {option.label}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex min-h-[60px] items-center rounded-2xl border border-line bg-surface px-3.5 py-3">
        {shown.id === "off" ? (
          <p className="text-[12px] text-faint">No icons.</p>
        ) : (
          <div className="flex w-full flex-wrap justify-between gap-y-1.5" aria-label={`${shown.label} icons`}>
            {Array.from({ length: HISTORY_AVATAR_COUNTS[shown.id] }, (_, i) => (
              <HistoryAvatar key={i} seed="" set={shown.id as Exclude<HistoryIconStyle, "off">} index={i} className="h-9 w-9 text-muted" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
