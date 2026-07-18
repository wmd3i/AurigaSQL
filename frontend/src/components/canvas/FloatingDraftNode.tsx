import { useEffect, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUp, Check, Copy, GripVertical, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { ModelPicker } from "../ModelPicker";
import { CANVAS_TONES, type CanvasToneId } from "../../lib/canvasTones";

export type FloatingDraftData = {
  onClose: () => void;
  onSubmit: (text: string, toneId: CanvasToneId) => boolean | void | Promise<boolean | void>;
  onOpenLlmConfig?: () => void;
  title?: string;
  placeholder?: string;
  initialText?: string;
  initialTextToken?: number;
};

export type FloatingDraftNodeT = Node<FloatingDraftData, "floatingDraft">;

const inputScrollClass =
  "nodrag nopan nowheel overflow-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)]";

export function FloatingDraftNode({ data, selected }: NodeProps<FloatingDraftNodeT>) {
  const [draft, setDraft] = useState(data.initialText ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toneId, setToneId] = useState<CanvasToneId>("green");
  const [copied, setCopied] = useState(false);
  const tone = CANVAS_TONES.find((item) => item.id === toneId) ?? CANVAS_TONES[0];

  useEffect(() => {
    if (data.initialText === undefined) return;
    setDraft(data.initialText);
    setSubmitting(false);
    setError(null);
  }, [data.initialText, data.initialTextToken]);

  useEffect(() => {
    setSubmitting(false);
    setError(null);
  }, [draft]);

  async function submit() {
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const submitted = await Promise.race([
        Promise.resolve(data.onSubmit(text, toneId)),
        new Promise<false>((resolve) => {
          window.setTimeout(() => {
            setError("Still starting. Please try again or check the data source.");
            resolve(false);
          }, 15000);
        }),
      ]);
      if (submitted === false) {
        return;
      }
      setDraft("");
      setError(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not start this question.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyContent() {
    const text = draft.trim() || "Workspace";
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("Could not copy content.");
    }
  }

  return (
    <div className="group relative w-[360px] pt-[56px]">
      <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <div
        className={cn(
          "nodrag nopan absolute left-1/2 top-0 z-30 flex -translate-x-1/2 items-center gap-2 rounded-[18px] border border-line/80 bg-card px-2.5 py-1.5 text-[13px] font-semibold text-ink shadow-[0_12px_28px_rgba(15,23,42,0.12)] transition-all",
          selected ? "opacity-100" : "opacity-0 translate-y-1 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-hover:translate-y-0",
        )}
      >
        <div className="flex items-center gap-1 border-r border-line/70 pr-2">
          {CANVAS_TONES.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={`Set ${item.label} card color`}
              onClick={(event) => {
                event.stopPropagation();
                setToneId(item.id);
              }}
              className="flex h-5 w-5 items-center justify-center rounded-full transition hover:bg-hover"
            >
              <span
                className="block h-3.5 w-3.5 rounded-full border-2 bg-transparent"
                style={{
                  borderColor: item.dot,
                  backgroundColor: toneId === item.id ? item.dot : "transparent",
                  boxShadow: toneId === item.id ? `0 0 0 3px ${item.glow}` : undefined,
                }}
              />
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void copyContent();
          }}
          className="flex h-8 items-center gap-1.5 rounded-full px-2 transition-colors hover:bg-hover"
          aria-label="Copy content"
        >
          {copied ? <Check className="h-4 w-4 text-accent" /> : <Copy className="h-4 w-4" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            data.onClose();
          }}
          className="flex h-8 items-center gap-1.5 rounded-full px-2 text-danger transition-colors hover:bg-danger-soft"
          aria-label="Delete draft"
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete</span>
        </button>
      </div>

      <div
        className="rounded-[24px] border bg-card px-5 pb-4 pt-4 shadow-[0_14px_32px_rgba(15,23,42,0.10)] transition-[border-color,box-shadow,background-color]"
        style={{
          borderColor: selected ? tone.border : "var(--line)",
          boxShadow: selected
            ? `0 0 0 4px ${tone.glow}, 0 14px 32px rgba(15,23,42,0.10)`
            : "0 12px 28px rgba(15,23,42,0.09)",
          backgroundColor: selected ? tone.fill : "rgba(255,255,255,0.96)",
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-muted">
            <GripVertical className="h-4 w-4" />
            {data.title ?? "Workspace"}
          </div>
        </div>

        <textarea
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={data.placeholder ?? "Ask a new question here..."}
          className={cn(inputScrollClass, "block min-h-[104px] w-full resize-none border-0 bg-transparent text-[16px] leading-relaxed text-ink placeholder:text-faint focus:outline-none")}
        />
        <div className="nodrag nopan nowheel mt-2 flex items-center justify-between gap-3">
          <ModelPicker
            onOpenConfig={data.onOpenLlmConfig}
            showConfigButton={false}
            variant="inline"
            className="nodrag nopan nowheel min-w-0"
            buttonClassName="h-8 min-w-0 max-w-[236px] px-1.5 py-1 text-[14px]"
            menuClassName="left-0 w-56"
          />
          <button
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              void submit();
            }}
            disabled={!draft.trim() || submitting}
            className="nodrag nopan nowheel flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hover text-muted transition hover:bg-invert hover:text-invert-ink disabled:cursor-not-allowed disabled:bg-hover disabled:text-faint disabled:opacity-100 disabled:hover:bg-hover disabled:hover:text-faint"
            aria-label={submitting ? "Starting thread" : "Send floating thread"}
            title={submitting ? "Starting..." : "Send"}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] leading-4 text-danger">{error}</p>}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent" />
    </div>
  );
}
