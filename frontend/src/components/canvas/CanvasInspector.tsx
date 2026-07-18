import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { ResultArtifact } from "../result/ResultArtifact";
import { DetailBlock, ResultPreview, SqlCodeBlock } from "../result/ProcessTimeline";
import { RichText } from "../result/RichText";
import { VisualizationCard } from "../result/VisualizationCard";
import { stripSystemNote } from "../../lib/stripSystemNote";
import type { ThreadNode } from "../../lib/buildNodes";
import type { CardContent } from "./ThreadNodeCard";
import { cardKindMeta, cardLabel, toneText, toolActionLabel } from "./cardKind";

/** Kinds whose body is prose (markdown-ish) rather than SQL/JSON. */
const PROSE_KINDS = new Set<CardContent["kind"]>([
  "question",
  "thinking",
  "agent_question",
  "user_answer",
  "agent_text",
]);

function parseJsonCount(result?: string): number | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(stripSystemNote(result));
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === "object") return Object.keys(parsed).length;
  } catch {
    return null;
  }
  return null;
}

function toolObservation(tool: ThreadNode): string | null {
  const count = parseJsonCount(tool.result);
  switch (tool.title) {
    case "get_schema":
      return "";
    case "get_all_external_knowledge_names":
      return count !== null
        ? `You can see ${count} available domain topic${count === 1 ? "" : "s"} that may help interpret this database.`
        : "You can see the available domain topics that may help interpret this database.";
    case "get_all_knowledge_definitions":
    case "get_knowledge_definition":
      return "";
    case "get_all_column_meanings":
    case "get_column_meaning":
      return "";
    default:
      return null;
  }
}

function isSqlInputTool(name?: string) {
  return (
    name === "execute_sql" ||
    name === "run_sqlite_readonly" ||
    name === "run_duckdb_readonly" ||
    name === "run_postgres_readonly" ||
    name === "explain_sqlite_query" ||
    name === "explain_postgres_query" ||
    name === "validate_sql" ||
    name === "validate_sqlite_query" ||
    name === "validate_duckdb_query" ||
    name === "validate_postgres_query" ||
    name === "submit_sql" ||
    name === "submit"
  );
}

function ToolDetail(props: { tool: ThreadNode; index?: number; total?: number }) {
  const { tool, index, total } = props;
  const result = tool.result;
  const labelPrefix = index !== undefined && total !== undefined ? `${index + 1}/${total} · ` : "";
  const label = `${labelPrefix}${toolActionLabel(tool)}`;
  const observation = toolObservation(tool);
  const showSqlBody = tool.body && isSqlInputTool(tool.title);

  if (observation !== null) {
    return (
      <div className="space-y-1.5">
        {observation && <div className="text-[13px] font-medium leading-relaxed text-muted">{observation}</div>}
        <div className="flex flex-col gap-3">
          {result !== undefined && <ResultPreview result={result} toolName={tool.title ?? ""} />}
        </div>
      </div>
    );
  }

  return (
    <DetailBlock label={label}>
      <div className="flex flex-col gap-3">
        {showSqlBody ? (
          <>
            {result !== undefined && <ResultPreview result={result} toolName={tool.title} />}
            {tool.body && <SqlCodeBlock sql={stripSystemNote(tool.body)} showCopy />}
          </>
        ) : (
          <>
            {result !== undefined && <ResultPreview result={result} toolName={tool.title} />}
          </>
        )}
      </div>
    </DetailBlock>
  );
}

function CanvasFinalResultDetail(props: { result: string | null; sql: string | null }) {
  const { result, sql } = props;

  if (!result && !sql) return null;

  return (
    <div className="flex flex-col gap-6">
      {result && (
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Result table
          </div>
          <ResultArtifact result={result} sql={null} />
        </section>
      )}

      {result && (
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Plots
          </div>
          <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
            <VisualizationCard question="" sql={sql} result={result} size="rail" chrome={false} />
          </div>
        </section>
      )}

      {sql && (
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Final SQL
          </div>
          <ResultArtifact result={null} sql={sql} />
        </section>
      )}
    </div>
  );
}

/** Right-hand detail panel for the selected canvas card: shows the full body,
 *  SQL, and result table without the on-canvas height caps. */
export function CanvasInspector(props: {
  node: CardContent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contained?: boolean;
}) {
  const tn = props.node;
  const meta = tn ? cardKindMeta[tn.kind] : null;
  const result = tn && "result" in tn ? tn.result : undefined;

  const isProse = tn ? PROSE_KINDS.has(tn.kind) : false;

  return (
    <aside
      className={cn(
        "pointer-events-none inset-0 z-40",
        props.contained ? "canvas-inspector-compact absolute" : "fixed",
      )}
    >
      {props.open && tn && meta && (
        <section
          className={cn(
            "pointer-events-auto absolute flex flex-col overflow-hidden rounded-[24px] border border-line/80 bg-card shadow-[0_22px_70px_rgba(15,23,42,0.16)]",
            props.contained
              ? "right-4 top-14 max-h-[calc(100%-72px)] w-[320px] max-w-[calc(100%-32px)] rounded-[18px] shadow-[0_16px_46px_rgba(15,23,42,0.13)]"
              : "right-[15px] top-[68px] max-h-[calc(100vh-92px)] w-[560px] max-w-[calc(100vw-30px)]",
          )}
        >
          <div className={cn("min-h-0 flex-1 overflow-y-auto", props.contained ? "px-3.5 py-3.5" : "px-7 py-7")}>
            <div className={cn("flex items-center justify-between gap-4", props.contained ? "mb-4" : "mb-8")}>
              <div className={cn("flex min-w-0 items-center gap-2 font-semibold text-ink", props.contained ? "text-[12px]" : "text-[14px]")}>
                <meta.Icon className={cn(props.contained ? "h-3.5 w-3.5" : "h-4 w-4", "shrink-0", toneText[meta.tone])} />
                <span className="truncate">{cardLabel(tn)}</span>
              </div>
            </div>

            {tn.kind === "working" ? (
              <div className="flex items-center gap-2 text-[13px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                AurigaSQL is still working on this step…
              </div>
            ) : tn.kind === "error" ? (
              <pre className="whitespace-pre-wrap rounded-xl border border-danger bg-danger-soft p-3 font-sans text-[13px] leading-relaxed text-danger">
                {tn.body}
              </pre>
            ) : tn.kind === "answer" ? (
              <CanvasFinalResultDetail result={result ?? null} sql={tn.body || null} />
            ) : tn.kind === "tool_group" ? (
              <div className="flex flex-col gap-6">
                {tn.tools.map((tool, index) => (
                  <ToolDetail key={tool.id} tool={tool} index={index} total={tn.tools.length} />
                ))}
              </div>
            ) : tn.kind === "tool" ? (
              <div className="flex flex-col gap-6">
                <ToolDetail tool={tn} />
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {tn.body &&
                  (isProse ? (
                    <RichText
                      text={tn.body}
                      className={cn("leading-relaxed text-ink", props.contained ? "text-[13px]" : "text-[15px]")}
                    />
                  ) : (
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                        Arguments
                      </p>
                      <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-hover p-3 text-[12.5px] leading-relaxed text-ink">
                        {tn.body}
                      </pre>
                    </div>
                  ))}

                {tn.kind === "agent_question" && tn.answer && (
                  <DetailBlock label="You clarified">
                    <RichText
                      text={tn.answer}
                      className={cn("leading-relaxed text-ink", props.contained ? "text-[12.5px]" : "text-[14px]")}
                    />
                  </DetailBlock>
                )}

                {result !== undefined && <ResultArtifact result={result} sql={null} />}
              </div>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}
