import { useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { cn } from "../../lib/cn";
import type { Conversation } from "../../state/types";

export type BranchTarget = {
  parentThreadId: string;
  parentNodeId: string;
  label: string;
  mode?: "auto" | "manual";
  branchKind?: "follow_up" | "fork";
};

/** Docked at the bottom of the left rail — the canvas's action column. Plain
 *  send starts a new thread; when a pending question is targeted it answers it. */
export function CanvasComposer(props: {
  answerTarget: Conversation | null;
  onSend: (text: string) => void;
  onAnswer: (text: string) => void;
  onClearTarget: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const answering = props.answerTarget !== null;
  const inputScrollClass =
    "nodrag nopan nowheel overflow-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)]";

  function submit() {
    const text = draft.trim();
    if (!text) return;
    if (answering) props.onAnswer(text);
    else props.onSend(text);
    setDraft("");
    setExpanded(false);
  }

  return (
    <div className="w-full">
      {answering && (
        <div className="mb-2 flex">
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 text-[12px] text-accent">
            <span className="truncate">answering: {(props.answerTarget?.pendingQuestion ?? "").slice(0, 48)}</span>
            <button
              aria-label="Cancel answering"
              onClick={props.onClearTarget}
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      {!expanded && !answering ? (
        <button
          onClick={() => setExpanded(true)}
          className="flex w-full items-center rounded-[28px] bg-card/95 px-6 py-4 text-left shadow-[0_18px_40px_rgba(15,23,42,0.08)] ring-1 ring-line/60 transition-colors hover:bg-card"
        >
          <span className="truncate text-[15px] text-faint">Ask a new question...</span>
        </button>
      ) : (
        <div className="rounded-[28px] bg-card/95 p-4 shadow-[0_18px_40px_rgba(15,23,42,0.08)] ring-1 ring-line/60 focus-within:ring-accent/50">
          <textarea
            rows={3}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={answering ? "Type your answer…" : "Ask a new question…"}
            className={cn(inputScrollClass, "w-full resize-none border-0 bg-transparent text-[15px] leading-relaxed text-ink placeholder:text-faint focus:outline-none")}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
              {!answering && !draft.trim() && (
                <button
                  onClick={() => setExpanded(false)}
                  className="text-[11px] text-faint transition-colors hover:text-ink"
                >
                  Collapse
                </button>
              )}
                <button
                  aria-label="Send"
                  onClick={submit}
                  disabled={!draft.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-invert text-invert-ink hover:opacity-90 disabled:cursor-not-allowed disabled:bg-hover disabled:text-faint disabled:opacity-100 disabled:hover:opacity-100"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
          </div>
        </div>
      )}
    </div>
  );
}
