import { useLayoutEffect, useRef } from "react";
import { ArrowUp, Database, Maximize2, Pause } from "lucide-react";
import { cn } from "../../lib/cn";
import type { QueryMode } from "../../state/types";
import { ModelPicker } from "../ModelPicker";

const COMPOSER_MIN_HEIGHT = 72;
const COMPOSER_MAX_HEIGHT = 220;
const WORKSPACE_COMPOSER_MIN_HEIGHT = 120;
const WORKSPACE_COMPOSER_MAX_HEIGHT = 180;

export function HomeComposer(props: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onOpenDataSetup: () => void;
  mode?: QueryMode;
  onModeChange?: (mode: QueryMode) => void;
  onExpandCanvas?: () => void;
  busy: boolean;
  hasDataSource: boolean;
  onOpenLlmConfig: () => void;
  hint: string | null; // e.g. "Please select a database first" or backend-down message
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const workspaceMode = props.mode === "workspace";

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const minHeight = workspaceMode ? WORKSPACE_COMPOSER_MIN_HEIGHT : COMPOSER_MIN_HEIGHT;
    const maxHeight = workspaceMode ? WORKSPACE_COMPOSER_MAX_HEIGHT : COMPOSER_MAX_HEIGHT;
    textarea.style.height = `${minHeight}px`;
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, minHeight),
      maxHeight,
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [props.value, workspaceMode]);

  return (
    <div
      className={cn(
        "w-full border bg-card/96 shadow-[0_22px_70px_rgba(60,43,24,0.10)] backdrop-blur transition-[border-color,border-radius,box-shadow,padding] duration-300 ease-out",
        workspaceMode
          ? "rounded-[24px] border-line/80 p-3 shadow-[0_18px_46px_rgba(24,32,28,0.10)] sm:p-4"
          : "rounded-[30px] border-line p-4 sm:p-5",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">
          {workspaceMode ? "New workspace question" : "Question"}
        </p>
        {workspaceMode && props.onExpandCanvas && (
          <button
            type="button"
            aria-label="Expand canvas"
            title="Expand canvas"
            onClick={props.onExpandCanvas}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        )}
      </div>
      <textarea
        ref={textareaRef}
        rows={workspaceMode ? 6 : 2}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            props.onSend();
          }
        }}
        placeholder={workspaceMode ? "Ask a new question here..." : "Ask anything about your data..."}
        className={cn(
          "w-full resize-none border-0 bg-transparent text-ink placeholder:text-faint focus:outline-none",
          "transition-[height,min-height,max-height,font-size,line-height] duration-300 ease-out",
          workspaceMode
            ? "min-h-[120px] max-h-[180px] text-[14px] leading-6"
            : "min-h-[72px] max-h-[220px] text-[17px] leading-8",
        )}
      />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-[160px] flex-wrap items-center gap-2 text-[13px] text-muted">
          <button
            type="button"
            aria-label="Connect data"
            onClick={props.onOpenDataSetup}
            className={cn(
              "group relative inline-flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition",
              props.hasDataSource
                ? "border-accent/45 bg-accent-soft text-accent"
                : "border-line bg-canvas text-muted hover:bg-hover hover:text-ink",
            )}
          >
            <Database className="h-4 w-4" />
            <span className="pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded-xl bg-ink px-3 py-1.5 text-[12px] font-semibold text-invert-ink opacity-0 shadow-[0_10px_24px_rgba(24,32,28,0.18)] transition group-hover:opacity-100">
              Connect data
            </span>
          </button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-[13px] text-muted">
          <ModelPicker
            onOpenConfig={props.onOpenLlmConfig}
            showConfigButton={false}
            variant="inline"
            buttonClassName="h-10"
            menuClassName="left-auto right-0 w-52"
          />
          <button
            aria-label={props.busy ? "Pause" : "Send"}
            title={props.busy ? "Pause" : "Send"}
            onClick={props.busy ? props.onStop : props.onSend}
            disabled={!props.busy && !props.value.trim()}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-full transition-opacity hover:opacity-90",
              props.busy
                ? "bg-pause text-invert-ink"
                : props.value.trim()
                  ? "bg-invert text-invert-ink"
                  : "cursor-not-allowed bg-hover text-faint hover:opacity-100",
            )}
          >
            {props.busy ? <Pause className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {props.hint && <p className="mt-2 text-[12px] text-danger">{props.hint}</p>}
    </div>
  );
}
