import { useMemo } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { inferDataEngine } from "../../lib/databaseEngine";
import type { Conversation, ConversationStatus } from "../../state/types";
import { DialectIcon } from "../home/DialectIcon";

type CanvasWork = {
  id: string;
  conversations: Conversation[];
  primary: Conversation;
  latest: Conversation;
  status: ConversationStatus;
  turnInFlight: boolean;
};

function threadStatusLabel(status: ConversationStatus, turnInFlight = false) {
  if (status === "waiting_user") return "Needs input";
  if (status === "error") return "Error";
  if (status === "done") return "Done";
  if (status === "stopped") return "Stopped";
  if (turnInFlight || status === "starting" || status === "active") return "Running";
  return "Idle";
}

function threadStatusTone(status: ConversationStatus) {
  switch (status) {
    case "waiting_user":
      return "border-[rgba(0,133,117,0.18)] bg-accent-soft text-accent";
    case "done":
      return "border-line bg-card text-muted";
    case "error":
      return "border-danger/20 bg-danger-soft text-danger";
    case "stopped":
      return "border-line bg-card text-faint";
    case "starting":
    case "active":
      return "border-[rgba(0,133,117,0.18)] bg-[rgba(0,133,117,0.08)] text-accent";
    default:
      return "border-line bg-card text-muted";
  }
}

function canvasWorkKey(conversationsById: Map<string, Conversation>, conv: Conversation) {
  if (conv.canvasWorkId) return conv.canvasWorkId;
  let current: Conversation | undefined = conv;
  const seen = new Set<string>();
  while (current?.parentThreadId && !seen.has(current.id)) {
    seen.add(current.id);
    current = conversationsById.get(current.parentThreadId);
  }
  return current?.id ?? conv.id;
}

function aggregateStatus(conversations: Conversation[]): Pick<CanvasWork, "status" | "turnInFlight"> {
  const turnInFlight = conversations.some((c) => c.turnInFlight || c.status === "starting" || c.status === "active");
  if (turnInFlight) return { status: "active", turnInFlight: true };
  if (conversations.some((c) => c.status === "waiting_user")) return { status: "waiting_user", turnInFlight: false };
  if (conversations.some((c) => c.status === "error")) return { status: "error", turnInFlight: false };
  if (conversations.some((c) => c.status === "done")) return { status: "done", turnInFlight: false };
  if (conversations.some((c) => c.status === "stopped")) return { status: "stopped", turnInFlight: false };
  return { status: "active", turnInFlight: false };
}

function summarizeThreads(works: CanvasWork[]) {
  const total = works.length;
  const running = works.filter((work) => work.turnInFlight || work.status === "starting" || work.status === "active").length;
  const waiting = works.filter((work) => work.status === "waiting_user").length;
  const done = works.filter((work) => work.status === "done").length;
  const error = works.filter((work) => work.status === "error").length;
  return { total, running, waiting, done, error };
}

/** Floating thread browser for canvas mode. The canvas itself already shows the
 *  step graph, so this panel stays focused on thread-level switching only. */
export function CanvasRail(props: {
  conversations: Conversation[]; // newest first
  activeId: string | null;
  onSelectThread: (id: string) => void;
  onDeleteThread?: (id: string) => void;
}) {
  const works = useMemo<CanvasWork[]>(() => {
    const conversationsById = new Map(props.conversations.map((conversation) => [conversation.id, conversation]));
    const grouped = new Map<string, Conversation[]>();
    props.conversations.forEach((conversation) => {
      const key = canvasWorkKey(conversationsById, conversation);
      grouped.set(key, [...(grouped.get(key) ?? []), conversation]);
    });
    return [...grouped.entries()].map(([id, conversations]) => {
      const sortedNewest = [...conversations].sort((a, b) => b.createdAt - a.createdAt);
      const sortedOldest = [...conversations].sort((a, b) => a.createdAt - b.createdAt);
      const primary = sortedOldest.find((conversation) => !conversation.parentThreadId) ?? sortedOldest[0];
      const latest = sortedNewest[0];
      return {
        id,
        conversations: sortedNewest,
        primary,
        latest,
        ...aggregateStatus(conversations),
      };
    });
  }, [props.conversations]);
  const stats = summarizeThreads(works);
  const activeWork = works.find((work) => work.conversations.some((c) => c.id === props.activeId)) ?? null;
  const headline = useMemo(() => {
    if (stats.running > 0) return `${stats.running} running`;
    if (stats.waiting > 0) return `${stats.waiting} needs input`;
    if (stats.done > 0) return `${stats.done} done`;
    if (stats.error > 0) return `${stats.error} errors`;
    return `${stats.total} threads`;
  }, [stats.done, stats.error, stats.running, stats.total, stats.waiting]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Canvas Threads</p>
            {activeWork && (
              <p className="mt-1 text-[11px] text-faint">Focused: {threadStatusLabel(activeWork.status, activeWork.turnInFlight)}</p>
            )}
          </div>
          <span className="shrink-0 rounded-full bg-hover px-2 py-1 text-[11px] text-faint">{headline}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <section>
          <div className="flex flex-col gap-2">
            {works.length === 0 && <p className="px-1 text-[12px] text-faint">No threads yet.</p>}
            {works.map((work) => {
              const c = work.primary;
              const active = work.conversations.some((conversation) => conversation.id === props.activeId);
              const statusLabel = threadStatusLabel(work.status, work.turnInFlight);
              return (
                <div
                  key={work.id}
                  className={cn(
                    "group flex items-start gap-2.5 rounded-2xl px-3 py-3 transition-all",
                    active ? "bg-accent-soft ring-1 ring-accent/30 shadow-sm" : "hover:bg-card/80",
                  )}
                >
                  <button
                    onClick={() => props.onSelectThread(work.latest.id)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                  >
                  <span
                    className={cn(
                      "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                      work.status === "error"
                        ? "bg-danger"
                        : work.status === "waiting_user"
                          ? "bg-accent"
                          : work.status === "done"
                            ? "bg-muted/50"
                            : "bg-accent",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-[13px] font-medium", active ? "text-ink" : "text-ink/90")}>
                      {c.summary || c.title}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-faint">
                      <DialectIcon dialect={c.source?.engine ?? inferDataEngine(c.database)} className="h-3 w-3" />
                      <span className="truncate">{c.database}</span>
                      {work.conversations.length > 1 && <span className="shrink-0">· {work.conversations.length} runs</span>}
                    </span>
                  </span>
                  <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]", threadStatusTone(work.status))}>
                    {statusLabel}
                  </span>
                  </button>
                  {props.onDeleteThread && (
                    <button
                      type="button"
                      aria-label="Delete thread"
                      title="Delete thread"
                      onClick={(event) => {
                        event.stopPropagation();
                        work.conversations.forEach((conversation) => props.onDeleteThread?.(conversation.id));
                      }}
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-faint opacity-0 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
