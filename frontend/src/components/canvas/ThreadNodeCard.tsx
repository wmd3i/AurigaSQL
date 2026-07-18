import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  ArrowUp,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Database,
  GitBranch,
  Loader2,
  RotateCcw,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import type { ThreadNode } from "../../lib/buildNodes";
import { formatCell, parseResultTable } from "../../lib/parseResultTable";
import { stripSystemNote } from "../../lib/stripSystemNote";
import { getCanvasTone, type CanvasToneId } from "../../lib/canvasTones";
import { DetailBlock, SqlCodeBlock } from "../result/ProcessTimeline";
import { useSelectedModelLabel } from "../../state/modelContext";
import { cardLabel, toolActionLabel, toolGroupButtonLabel } from "./cardKind";
import { ToolResultView } from "./ToolPresentation";

/** Real action nodes come from buildNodes; "working" (ghost while the agent
 *  runs) and "error" are synthesized per-thread by CanvasPage — every action
 *  and outcome is a visible node (transparency rule). */
export type CardContent =
  | ThreadNode
  | { id: string; kind: "tool_group"; title: string; tools: ThreadNode[] }
  | { id: string; kind: "working"; body: string }
  | { id: string; kind: "error"; body: string };

export type ThreadFooter = { state: "ended" } | null;

export type CardData = {
  tn: CardContent;
  pulse: boolean;       // waiting for the user's answer — click to target the composer
  footer: ThreadFooter; // "— ended —" under the LAST node of a finished thread
  onHeightChange?: (height: number) => void;
  onBranch?: (prompt: string) => void | Promise<void>;
  onBranchTool?: (tool: ThreadNode, prompt: string) => void | Promise<void>;
  onCreateBranchDraft?: (kind: "follow_up" | "fork") => void;
  onDeleteThread?: () => void;
  onRevert?: () => void;
  onAnswer?: (text: string) => void;
  onInspectTool?: (tool: ThreadNode, openDetail?: boolean) => void;
  branchOrigin?: { label: string; kind?: "follow_up" | "fork" };
  expandAllToken?: number;
  expandAllOpen?: boolean;
  compact?: boolean;
  canvasTone?: CanvasToneId;
};

export type CardNode = Node<CardData, "card">;

function branchOriginText(branchOrigin: NonNullable<CardData["branchOrigin"]>): string {
  if (branchOrigin.kind === "fork") {
    return `Parallel path from ${branchOrigin.label}`;
  }
  return `Continues from ${branchOrigin.label}`;
}

function withBranchStartTimeout(work: void | Promise<void>, timeoutMs = 15000): Promise<void> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<void>((_, reject) => {
      window.setTimeout(() => reject(new Error("Branch start timed out. Check that the backend services are running.")), timeoutMs);
    }),
  ]);
}

function ExpandableClamp(props: { children: ReactNode; collapsedHeight?: number }) {
  const { children, collapsedHeight = 320 } = props;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > collapsedHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children, collapsedHeight]);

  return (
    <div>
      <div
        ref={bodyRef}
        className={cn(
          "nopan nowheel overflow-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)]",
          !expanded && overflowing && `max-h-[${collapsedHeight}px]`,
        )}
        style={!expanded && overflowing ? { maxHeight: `${collapsedHeight}px` } : undefined}
        onDoubleClick={() => {
          if (overflowing) setExpanded((current) => !current);
        }}
        title={overflowing ? "Double-click to expand or collapse" : undefined}
      >
        {children}
      </div>
      {overflowing && (
        <button
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 text-[12px] font-medium text-muted hover:text-ink"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function ScrollableTextBlock(props: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "nopan nowheel max-h-[180px] overflow-auto overscroll-contain whitespace-pre-wrap break-words font-sans text-[13px] leading-snug text-ink [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)]",
        props.className,
      )}
    >
      {props.children}
    </pre>
  );
}

const scrollSurfaceClass =
  "nopan nowheel overflow-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)]";
const inputScrollClass =
  "nodrag nopan nowheel overflow-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)]";

/** Tabular results render as a real table; anything else falls back to plain text. */
function ResultBlock({ result }: { result: string }) {
  const table = parseResultTable(result);
  if (!table) {
    return (
      <pre className={cn(scrollSurfaceClass, "mt-2 max-h-[170px] whitespace-pre rounded-lg bg-hover p-2 text-[12px] leading-snug text-muted")}>
        {result}
      </pre>
    );
  }
  return (
    <div className={cn(scrollSurfaceClass, "mt-2 max-h-[200px] rounded-lg border border-line")}>
      <table className="min-w-max w-full border-collapse text-[12px]">
        <thead className="sticky top-0">
          <tr>
            {table.headers.map((h, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-line bg-hover px-2 py-1 text-right font-medium text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="even:bg-surface">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  title={cell}
                  className="whitespace-nowrap border-b border-line/50 px-2 py-1 text-right text-ink tabular-nums"
                >
                  {formatCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated && (
        <div className="bg-hover px-2 py-1 text-[11px] text-faint">result truncated…</div>
      )}
    </div>
  );
}

function FinalAnswerPreview(props: { result?: string }) {
  return (
    props.result ? (
      <ResultBlock result={props.result} />
    ) : (
      <div className="mt-2 rounded-xl border border-line bg-card px-3 py-2.5 text-[13px] text-muted shadow-sm">
        No result table was captured for the final answer.
      </div>
    )
  );
}

function cleanSqlIdentifier(value: string): string {
  return value
    .replace(/[`"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeSelectClause(sql: string): string | null {
  const match = sql.match(/\bselect\s+(distinct\s+)?([\s\S]+?)\s+\bfrom\b/i);
  if (!match) return null;
  const distinct = Boolean(match[1]);
  const rawColumns = match[2] ?? "";
  const columns = rawColumns
    .split(",")
    .map((column) => cleanSqlIdentifier(column.replace(/\bas\s+\w+$/i, "")))
    .filter(Boolean)
    .slice(0, 2);
  if (columns.length === 0) return null;
  return `${distinct ? "Checked distinct" : "Checked"} ${columns.join(" and ")}`;
}

function summarizeSqlPurpose(sql: string, fallback?: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback || "Checked query results.";

  const table = cleanSqlIdentifier(normalized.match(/\bfrom\s+([`"\w.\s]+?)(?:\s+\bwhere\b|\s+\bgroup\b|\s+\border\b|\s+\blimit\b|$)/i)?.[1] ?? "");
  const whereLiteral = cleanSqlIdentifier(normalized.match(/\bwhere\b[\s\S]*?=\s*('([^']+)'|"([^"]+)")/i)?.[2] ?? normalized.match(/\bwhere\b[\s\S]*?=\s*('([^']+)'|"([^"]+)")/i)?.[3] ?? "");
  const groupBy = cleanSqlIdentifier(normalized.match(/\bgroup\s+by\s+([\s\S]+?)(?:\s+\border\b|\s+\blimit\b|$)/i)?.[1] ?? "");
  const orderBy = cleanSqlIdentifier(normalized.match(/\border\s+by\s+([\s\S]+?)(?:\s+\blimit\b|$)/i)?.[1] ?? "");
  const selectSummary = summarizeSelectClause(normalized);
  const lower = normalized.toLowerCase();

  if (/\bcount\s*\(/i.test(normalized) && groupBy) {
    const subject = whereLiteral ? `${whereLiteral.toLowerCase()} ${table || "records"}` : table || "records";
    return `Counted ${subject} by ${groupBy}.`;
  }

  if (/\bwhere\b/i.test(normalized) && orderBy) {
    return `Filtered ${table || "records"} and sorted by ${orderBy}.`;
  }

  if (selectSummary && whereLiteral) return `${selectSummary} in ${whereLiteral}.`;
  if (selectSummary) return `${selectSummary}.`;
  if (/\bwhere\b/i.test(normalized)) return `Filtered ${table || "records"}.`;
  if (lower.includes("order by")) return `Sorted ${table || "records"} by ${orderBy || "the selected metric"}.`;
  return fallback ? `${fallback.replace(/\.$/, "")}.` : "Checked query results.";
}

function SqlPurposeCard(props: { sql?: string; summary?: string }) {
  const purpose = summarizeSqlPurpose(stripSystemNote(props.sql ?? ""), props.summary);
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
        Purpose
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink">{purpose}</p>
    </div>
  );
}

function hasInlineToolDetails(tool: ThreadNode) {
  return tool.title !== "get_knowledge_definition";
}

function isRunSqlTool(name?: string) {
  return (
    name === "execute_sql" ||
    name === "run_sqlite_readonly" ||
    name === "run_duckdb_readonly" ||
    name === "run_postgres_readonly" ||
    name === "run_mysql_readonly"
  );
}

function isSqlInputTool(name?: string) {
  return (
    isRunSqlTool(name) ||
    name === "explain_sqlite_query" ||
    name === "explain_postgres_query" ||
    name === "explain_mysql_query" ||
    name === "validate_sql" ||
    name === "validate_sqlite_query" ||
    name === "validate_duckdb_query" ||
    name === "validate_postgres_query" ||
    name === "validate_mysql_query" ||
    name === "submit_sql" ||
    name === "submit"
  );
}

function isValidationTool(name?: string) {
  return (
    name === "validate_sql" ||
    name === "validate_sqlite_query" ||
    name === "validate_duckdb_query" ||
    name === "validate_postgres_query" ||
    name === "validate_mysql_query"
  );
}

function ValidationStatusCard({ result }: { result?: string }) {
  let ok: boolean | null = null;
  if (result) {
    try {
      const parsed = JSON.parse(stripSystemNote(result));
      if (parsed && typeof parsed === "object" && "ok" in parsed) ok = (parsed as { ok?: unknown }).ok === true;
    } catch {
      ok = /\b(ok|passed|valid)\b/i.test(result) ? true : /\b(error|invalid|fail)\b/i.test(result) ? false : null;
    }
  }

  const label = ok === null ? "Ran validate sql" : ok ? "Validation passed" : "Needs revision";
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-accent/25 bg-accent-soft/45 px-3 py-2 text-[13px] text-ink">
      <span>{label}</span>
      {ok !== null && (
        <span className={cn("shrink-0 rounded-full border px-2 py-1 text-[11px] font-semibold", ok ? "border-accent/30 bg-accent-soft text-accent" : "border-danger/30 bg-danger-soft text-danger")}>
          {ok ? "Passed" : "Review"}
        </span>
      )}
    </div>
  );
}

function ToolInlineDetails(props: { tool: ThreadNode }) {
  const { tool } = props;
  if (!hasInlineToolDetails(tool)) return null;

  const reasoning = tool.reasoning?.trim() || tool.summary?.trim();

  return (
    <div className="space-y-3 border-t border-dashed border-accent/20 px-4 py-3">
      {isRunSqlTool(tool.title) ? (
        <SqlPurposeCard sql={tool.body} summary={tool.summary} />
      ) : (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Reasoning</div>
          {reasoning ? (
            <p className="mt-1 text-[13px] leading-relaxed text-ink">{reasoning}</p>
          ) : (
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              Open the details panel to inspect this lookup.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function toolGroupIcon(toolName?: string | null): LucideIcon {
  switch (toolName) {
    case "execute_sql":
      return Terminal;
    case "get_schema":
      return Database;
    case "get_knowledge_definition":
    case "get_all_knowledge_definitions":
    case "get_all_external_knowledge_names":
      return BookOpenText;
    case "get_column_meaning":
    case "get_all_column_meanings":
      return Columns3;
    default:
      return Wrench;
  }
}

function ToolGroupCard(props: {
  title: string;
  tools: ThreadNode[];
  open: boolean;
  onToggle: () => void;
  onInspectTool?: (tool: ThreadNode, openDetail?: boolean) => void;
  onBranchTool?: (tool: ThreadNode, prompt: string) => void;
}) {
  const itemHeight = 44;
  const itemGap = 8;
  const buttonWidth = 320;
  const buttonHeight = 44;
  const buttonCenterY = buttonHeight / 2;
  const connectorWidth = 44;
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [branchToolId, setBranchToolId] = useState<string | null>(null);
  const [branchSubmittingToolId, setBranchSubmittingToolId] = useState<string | null>(null);
  const [branchDraft, setBranchDraft] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [connectorLayout, setConnectorLayout] = useState<{ height: number; centers: Record<string, number> }>(() => ({
    height: props.tools.length * itemHeight + Math.max(0, props.tools.length - 1) * itemGap,
    centers: {},
  }));
  const buttonLabel = toolGroupButtonLabel(props.tools[0]?.title);
  const ButtonIcon = toolGroupIcon(props.tools[0]?.title);

  useLayoutEffect(() => {
    if (!props.open || !listRef.current) return;
    const listEl = listRef.current;
    const measure = () => {
      const listRect = listEl.getBoundingClientRect();
      const centers: Record<string, number> = {};
      props.tools.forEach((tool) => {
        const itemEl = listEl.querySelector<HTMLElement>(`[data-tool-card-id="${CSS.escape(tool.id)}"]`);
        if (!itemEl) return;
        const itemRect = itemEl.getBoundingClientRect();
        centers[tool.id] = itemRect.top - listRect.top + itemHeight / 2;
      });
      setConnectorLayout((current) => {
        const nextHeight = Math.max(itemHeight, listEl.offsetHeight);
        const sameHeight = current.height === nextHeight;
        const sameCenters =
          Object.keys(centers).length === Object.keys(current.centers).length &&
          props.tools.every((tool) => current.centers[tool.id] === centers[tool.id]);
        return sameHeight && sameCenters ? current : { height: nextHeight, centers };
      });
    };

    measure();
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(listEl);
    Array.from(listEl.children).forEach((child) => ro.observe(child));
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [branchToolId, expandedToolId, itemGap, itemHeight, props.open, props.tools]);

  async function submitToolBranch(tool: ThreadNode) {
    const text = branchDraft.trim();
    if (!text || !props.onBranchTool) return;
    setBranchSubmittingToolId(tool.id);
    setBranchError(null);
    try {
      await withBranchStartTimeout(props.onBranchTool(tool, text));
      setBranchDraft("");
      setBranchToolId(null);
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : "Could not start branch.");
    } finally {
      setBranchSubmittingToolId(null);
    }
  }

  return (
    <div className="relative flex items-start">
      <button
        onClick={props.onToggle}
        className="nopan flex h-11 w-[320px] shrink-0 items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-invert-ink shadow-[0_8px_18px_rgba(15,118,110,0.18)] transition-transform hover:scale-[1.02]"
        aria-label={props.open ? "Collapse tool group" : "Expand tool group"}
        title={props.title}
      >
        <ButtonIcon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold leading-none">{buttonLabel}</span>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", props.open && "rotate-180")} />
      </button>

      {props.open && (
        <>
          <svg
            className="pointer-events-none absolute top-0 z-0"
            style={{ left: buttonWidth, width: connectorWidth, height: connectorLayout.height }}
            viewBox={`0 0 ${connectorWidth} ${connectorLayout.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {props.tools.map((tool, index) => {
              const targetY = connectorLayout.centers[tool.id] ?? index * (itemHeight + itemGap) + itemHeight / 2;
              return (
                <path
                  key={tool.id}
                  d={`M 0 ${buttonCenterY} L ${connectorWidth} ${targetY}`}
                  fill="none"
                  stroke="var(--accent)"
                  strokeOpacity="0.45"
                  strokeWidth="1.5"
                  strokeDasharray="6 6"
                />
              );
            })}
          </svg>
          <div className="w-[340px] min-w-0 pl-11">
            <div ref={listRef} className="flex flex-col" style={{ gap: itemGap }}>
              {props.tools.map((tool) => (
                <div
                  key={tool.id}
                  data-tool-card-id={tool.id}
                  className="nodrag nopan group/tool relative z-10 overflow-visible rounded-2xl border border-dashed border-accent/30 bg-card/40 transition-colors hover:border-accent/50 hover:bg-card/70"
                >
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedToolId((current) =>
                        hasInlineToolDetails(tool) ? (current === tool.id ? null : tool.id) : null,
                      );
                      props.onInspectTool?.(tool, false);
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      setExpandedToolId(hasInlineToolDetails(tool) ? tool.id : null);
                      props.onInspectTool?.(tool, true);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3.5 text-left"
                    style={{ height: itemHeight }}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-[12px] font-medium leading-tight text-ink">
                        {toolActionLabel(tool)}
                      </span>
                    </div>
                  </button>
                  {expandedToolId === tool.id && <ToolInlineDetails tool={tool} />}
                  {props.onBranchTool && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (branchToolId === tool.id) {
                        setBranchToolId(null);
                        setBranchDraft("");
                        setBranchError(null);
                        return;
                      }
                      setBranchToolId(tool.id);
                      setBranchDraft("");
                      setBranchError(null);
                      }}
                      className={cn(
                        "absolute -right-4 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-card text-muted shadow-md transition-all",
                        branchToolId === tool.id ? "opacity-100 text-accent" : "opacity-0 group-hover/tool:opacity-100 hover:text-ink",
                      )}
                      aria-label="Branch from this tool"
                      title="Branch from this tool"
                    >
                      <GitBranch className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {branchToolId === tool.id && (
                    <div
                      className="absolute left-[calc(100%+16px)] top-1/2 z-30 w-[280px] -translate-y-1/2 rounded-2xl border border-line bg-card p-3 shadow-[0_18px_40px_rgba(15,23,42,0.12)]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-accent">
                        <GitBranch className="h-3.5 w-3.5" />
                        New branch
                        <button
                          onClick={() => {
                            setBranchToolId(null);
                            setBranchDraft("");
                            setBranchError(null);
                          }}
                          className="ml-auto rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
                          aria-label="Close branch prompt"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <textarea
                        rows={3}
                        value={branchDraft}
                        onChange={(event) => setBranchDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            submitToolBranch(tool);
                          }
                        }}
                        placeholder="Ask a follow-up from this tool..."
                        className={cn(inputScrollClass, "w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-faint focus:border-accent focus:outline-none")}
                      />
                      <div className="mt-2 flex items-center justify-end">
                        {branchError && (
                          <div className="mr-auto max-w-[205px] text-[11px] leading-snug text-danger">
                            {branchError}
                          </div>
                        )}
                        <button
                          onClick={() => submitToolBranch(tool)}
                          disabled={!branchDraft.trim() || branchSubmittingToolId === tool.id}
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-invert text-invert-ink hover:opacity-90 disabled:opacity-40"
                          aria-label="Send branch prompt"
                        >
                          {branchSubmittingToolId === tool.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ArrowUp className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function ThreadNodeCard({ data, selected }: NodeProps<CardNode>) {
  const { tn, pulse, footer, onHeightChange, onBranchTool, onAnswer, onInspectTool, onCreateBranchDraft, onDeleteThread, onRevert, branchOrigin, compact } = data;
  const modelLabel = useSelectedModelLabel();
  const [detailsOpen, setDetailsOpen] = useState(false); // fold level 1
  const [copied, setCopied] = useState(false);
  const [answerDraft, setAnswerDraft] = useState("");
  const [showRecoveryHint, setShowRecoveryHint] = useState(false);
  const [restartingBackend, setRestartingBackend] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const isMe = tn.kind === "question" || tn.kind === "user_answer";
  const isAnswer = tn.kind === "answer";
  const isTool = tn.kind === "tool" || tn.kind === "tool_group";
  const foldable = isTool || tn.kind === "thinking";
  const result = "result" in tn ? tn.result : undefined;
  const condensedToolDetails =
    tn.kind === "tool" &&
    (tn.title === "get_schema" ||
      tn.title === "get_knowledge_definition" ||
      tn.title === "get_all_knowledge_definitions" ||
      tn.title === "get_all_external_knowledge_names");
  const branchable = tn.kind === "tool" || tn.kind === "answer" || tn.kind === "agent_question" || tn.kind === "question";
  const cardWidthClass = isAnswer ? "w-[560px]" : tn.kind === "tool_group" ? (detailsOpen ? "w-[704px]" : "w-[320px]") : "w-[320px]";
  const canvasTone = tn.kind === "question" ? getCanvasTone(data.canvasTone) : undefined;
  const heightSignature =
    tn.kind === "tool_group"
      ? tn.tools.map((tool) => `${tool.id}:${tool.body.length}:${tool.result?.length ?? 0}`).join("|")
      : "body" in tn
        ? `${tn.body}:${"answer" in tn ? tn.answer ?? "" : ""}`
        : "";
  const groupTargetHandleStyle = tn.kind === "tool_group" ? { left: 160 } : undefined;
  const groupSourceHandleStyle =
    tn.kind === "tool_group" ? { bottom: "auto", left: 160, top: 44 } : undefined;
  const cardClassName =
    tn.kind === "tool_group"
      ? cn(cardWidthClass, "transition-shadow")
      : cn(
          cardWidthClass,
          "rounded-2xl border px-4 py-3 transition-shadow",
          isMe ? "border-line bg-card" : "border-accent/30 bg-card",
          isAnswer && "border-accent bg-accent-soft",
          tn.kind === "agent_question" && "border-accent/60 bg-accent-soft/60",
          detailsOpen ? "shadow-lg" : "shadow-sm",
          selected && "border-accent shadow-[0_0_0_4px_var(--accent-soft)]",
          pulse && "animate-pulse border-accent",
        );

  useEffect(() => {
    if (!foldable || !data.expandAllToken || data.expandAllOpen === undefined) return;
    setDetailsOpen(data.expandAllOpen);
  }, [data.expandAllOpen, data.expandAllToken, foldable]);

  useEffect(() => {
    if (tn.kind !== "working") {
      setShowRecoveryHint(false);
      setRestartingBackend(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowRecoveryHint(true), 45000);
    return () => window.clearTimeout(timeout);
  }, [tn.kind]);

  async function restartDesktopBackend() {
    const restartBackend = window.aurigaDesktop?.restartBackend;
    if (!restartBackend || restartingBackend) return;
    setRestartingBackend(true);
    try {
      await restartBackend();
    } finally {
      window.location.reload();
    }
  }

  async function copyCardContent() {
    const parts: string[] = [];
    if ("body" in tn && tn.body) parts.push(tn.body);
    if ("result" in tn && tn.result) parts.push(tn.result);
    if (tn.kind === "tool_group") {
      tn.tools.forEach((tool) => {
        parts.push([cardLabel(tool), tool.body, tool.result].filter(Boolean).join("\n"));
      });
    }
    const text = parts.join("\n\n").trim() || cardLabel(tn);
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  function submitAnswer() {
    const text = answerDraft.trim();
    if (!text || !onAnswer) return;
    onAnswer(text);
    setAnswerDraft("");
  }

  useLayoutEffect(() => {
    if (!rootRef.current || !onHeightChange) return;
    const rootEl = rootRef.current;
    const cardEl = cardRef.current;
    const emit = () => onHeightChange(rootEl.offsetHeight);

    emit();
    const rafA = requestAnimationFrame(() => {
      emit();
      requestAnimationFrame(emit);
    });

    const ro = new ResizeObserver(() => emit());
    ro.observe(rootEl);
    if (cardEl) ro.observe(cardEl);

    return () => {
      cancelAnimationFrame(rafA);
      ro.disconnect();
    };
  }, [detailsOpen, footer, heightSignature, onHeightChange, result, selected]);

  if (tn.kind === "working") {
    const canRestartBackend = Boolean(window.aurigaDesktop?.restartBackend);
    return (
      <div ref={rootRef} className="relative">
        <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent" />
        <div className="w-[340px] rounded-2xl border border-dashed border-accent/50 bg-card px-4 py-3 text-[13px] text-muted shadow-sm">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            AurigaSQL is working…
          </div>
          {showRecoveryHint && (
            <div className="nopan mt-3 rounded-xl border border-line bg-canvas px-3 py-2 text-[12px] leading-snug text-muted">
              <div className="font-medium text-ink">Still working?</div>
              <div className="mt-1">
                Use Pause in the toolbar, reload the window, or restart the bundled service.
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1 rounded-lg border border-line bg-card px-2 py-1 font-medium text-ink hover:bg-hover"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reload
                </button>
                {canRestartBackend && (
                  <button
                    type="button"
                    onClick={() => void restartDesktopBackend()}
                    disabled={restartingBackend}
                    className="inline-flex items-center gap-1 rounded-lg border border-line bg-card px-2 py-1 font-medium text-ink hover:bg-hover disabled:opacity-50"
                  >
                    {restartingBackend ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Restart service
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent" />
      </div>
    );
  }

  if (tn.kind === "error") {
    return (
      <div ref={rootRef} className="relative">
        <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent" />
        <div className="w-[320px] rounded-2xl border border-danger bg-danger-soft px-4 py-3 shadow-sm">
          <div className="mb-1 text-[11px] font-medium text-danger">Error</div>
          <pre className={cn(scrollSurfaceClass, "max-h-[180px] whitespace-pre font-sans text-[13px] leading-snug text-danger")}>
            {tn.body}
          </pre>
        </div>
        <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="nopan group relative">
      <Handle
        type="target"
        position={Position.Top}
        style={groupTargetHandleStyle}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />

      {selected && (
        <div
          className={cn(
            "nodrag nopan absolute left-1/2 top-0 z-30 flex -translate-x-1/2 items-center border border-line/80 bg-card/95 font-semibold text-ink shadow-[0_12px_30px_rgba(15,23,42,0.12)] backdrop-blur",
            compact
              ? "-translate-y-[calc(100%+7px)] gap-0.5 rounded-[14px] px-1 py-0.5 text-[9.5px]"
              : "-translate-y-[calc(100%+10px)] gap-1 rounded-[16px] px-1.5 py-1 text-[11px]",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => void copyCardContent()}
            className={cn(
              "flex items-center rounded-full transition-colors hover:bg-hover",
              compact ? "h-6 gap-1 px-1" : "h-[28px] gap-1 px-1.5",
            )}
            aria-label="Copy content"
          >
            <Copy className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
          {branchable && onCreateBranchDraft && (
            <button
              type="button"
              onClick={() => onCreateBranchDraft("fork")}
              className={cn(
                "flex items-center rounded-full transition-colors hover:bg-hover",
              compact ? "h-6 gap-1 px-1" : "h-[28px] gap-1 px-1.5",
              )}
              aria-label="Fork from this card"
            >
              <GitBranch className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
              <span>Fork</span>
            </button>
          )}
          {onRevert && (
            <button
              type="button"
              onClick={onRevert}
              className={cn(
                "flex items-center rounded-full transition-colors hover:bg-hover",
                compact ? "h-6 gap-1 px-1" : "h-[28px] gap-1 px-1.5",
              )}
              aria-label="Revert to previous step"
            >
              <RotateCcw className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
              <span>Revert</span>
            </button>
          )}
          {onDeleteThread && (
            <button
              type="button"
              onClick={onDeleteThread}
              className={cn(
                "flex items-center rounded-full text-danger transition-colors hover:bg-danger-soft",
                compact ? "h-6 gap-1 px-1" : "h-[28px] gap-1 px-1.5",
              )}
              aria-label="Delete thread"
            >
              <Trash2 className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
              <span>Delete</span>
            </button>
          )}
        </div>
      )}

      {selected && branchable && onCreateBranchDraft && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreateBranchDraft("follow_up");
          }}
          className={cn(
            "nodrag nopan absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 border border-line bg-card/95 font-semibold text-ink shadow-[0_14px_34px_rgba(15,23,42,0.12)] transition hover:bg-card",
            compact
              ? "top-[calc(100%+7px)] rounded-[13px] px-2.5 py-1 text-[11px]"
              : "top-[calc(100%+10px)] rounded-[15px] px-3 py-1.5 text-[13px]",
          )}
          aria-label="Follow up from this card"
        >
          <GitBranch className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
          Follow Up
          <span className="text-muted">F</span>
        </button>
      )}

      <div
        ref={cardRef}
        className={cardClassName}
        style={
          canvasTone
            ? {
                borderColor: canvasTone.border,
                boxShadow: selected
                  ? `0 0 0 4px ${canvasTone.glow}, 0 14px 32px rgba(15,23,42,0.10)`
                  : undefined,
                backgroundColor: canvasTone.fill,
              }
            : undefined
        }
      >
        {tn.kind === "tool_group" ? (
          <ToolGroupCard
            title={cardLabel(tn)}
            tools={tn.tools}
            open={detailsOpen}
            onToggle={() => setDetailsOpen(!detailsOpen)}
            onInspectTool={onInspectTool}
            onBranchTool={onBranchTool}
          />
        ) : foldable ? (
          <>
            {/* fold level 0: name only */}
            <button
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="flex w-full items-center justify-between gap-2 text-left"
            >
              <span className={cn("text-[11px] font-medium", isTool ? "text-accent" : "text-muted")}>
                {isTool ? cardLabel(tn) : "Thinking"}
              </span>
              <ChevronDown
                className={cn("h-3.5 w-3.5 text-faint transition-transform", detailsOpen && "rotate-180")}
              />
            </button>

            {detailsOpen && (
              <div className="mt-2">
                {/* fold level 1: human-readable */}
                {isTool ? (
                  <div className="space-y-3">
                    {isValidationTool(tn.title) ? (
                      <ValidationStatusCard result={result} />
                    ) : isRunSqlTool(tn.title) ? (
                      <SqlPurposeCard sql={tn.body} summary={tn.summary} />
                    ) : (
                      <>
                        {tn.body && isSqlInputTool(tn.title) && (
                          <DetailBlock label="SQL">
                            <ExpandableClamp collapsedHeight={320}>
                              <SqlCodeBlock sql={stripSystemNote(tn.body)} />
                            </ExpandableClamp>
                          </DetailBlock>
                        )}

                        {result !== undefined && condensedToolDetails ? (
                          <ExpandableClamp collapsedHeight={360}>
                            <ToolResultView toolName={tn.title ?? ""} result={result} compact />
                          </ExpandableClamp>
                        ) : result !== undefined ? (
                          <ExpandableClamp collapsedHeight={360}>
                            <ToolResultView toolName={tn.title ?? ""} result={result} compact />
                          </ExpandableClamp>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : tn.body ? (
                  <ScrollableTextBlock>{tn.body}</ScrollableTextBlock>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <>
            {tn.kind === "question" && (
              <div className="mb-1">
                <div className="text-[11px] font-medium text-accent">
                  {branchOrigin ? (branchOrigin.kind === "fork" ? "Fork" : "Follow-up") : "You asked"}
                </div>
                {branchOrigin && (
                  <div className="mt-0.5 truncate text-[10.5px] font-medium text-faint">
                    {branchOriginText(branchOrigin)}
                  </div>
                )}
              </div>
            )}
            {isAnswer && <div className="mb-1 text-[11px] font-medium text-accent">Final Result</div>}
            {tn.kind === "agent_question" && (
              <div className="mb-1 text-[11px] font-medium text-accent">
                AurigaSQL asks{pulse && " — reply here"}
              </div>
            )}

            {isAnswer ? (
              <FinalAnswerPreview result={result} />
            ) : (
              result !== undefined && <ResultBlock result={result} />
            )}

            {!isAnswer && tn.body && <ScrollableTextBlock>{tn.body}</ScrollableTextBlock>}

            {tn.kind === "agent_question" && tn.answer && (
              <div className="mt-3 rounded-xl border border-line bg-card px-3 py-2 shadow-sm">
                <div className="mb-1.5 text-[11px] font-medium text-faint">You clarified</div>
                <ScrollableTextBlock>{tn.answer}</ScrollableTextBlock>
              </div>
            )}

            {tn.kind === "agent_question" && pulse && onAnswer && (
              <div className="mt-3 rounded-2xl border border-accent/25 bg-card/90 p-3">
                <textarea
                  rows={3}
                  value={answerDraft}
                  onChange={(e) => setAnswerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitAnswer();
                    }
                  }}
                  placeholder="Type your answer here..."
                  className="w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-faint focus:border-accent focus:outline-none"
                />
                <div className="mt-2 flex items-center justify-end">
                  <button
                    onClick={submitAnswer}
                    disabled={!answerDraft.trim()}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-invert text-invert-ink hover:opacity-90 disabled:opacity-40"
                    aria-label="Send answer"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {tn.kind !== "agent_question" && tn.kind !== "question" && !isAnswer && (
              <div className="mt-2 flex items-center gap-1 text-[11px] text-faint">
                {tn.kind === "agent_text" && <Sparkles className="h-3 w-3 text-accent" />}
                {isMe ? "Me" : isAnswer ? "✓ Final result" : modelLabel}
              </div>
            )}
          </>
        )}
      </div>

      {footer && <div className="mt-2 text-center text-[12px] text-faint">— ended —</div>}

      <Handle
        type="source"
        position={Position.Bottom}
        style={groupSourceHandleStyle}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
    </div>
  );
}
