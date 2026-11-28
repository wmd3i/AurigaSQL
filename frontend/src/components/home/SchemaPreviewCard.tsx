import { useMemo } from "react";
import { ArrowRight, GitBranch, KeyRound, Link2, Loader2, Sparkles, Table2, Workflow } from "lucide-react";
import { cn } from "../../lib/cn";
import { parseSchemaGraph, primaryKeyColumns } from "../../lib/schemaGraph";

const TRUNCATION_THRESHOLD = 3900;

export function SchemaPreviewCard(props: {
  schemaText: string | null;
  loading?: boolean;
  error?: string | null;
  databaseName?: string;
  canAct?: boolean;
  onUseInChat?: () => void;
  onOpenInCanvas?: () => void;
  className?: string;
}) {
  const graph = useMemo(() => {
    if (!props.schemaText?.trim()) return null;
    return parseSchemaGraph(props.schemaText);
  }, [props.schemaText]);

  const truncated = Boolean(props.schemaText && props.schemaText.length >= TRUNCATION_THRESHOLD);

  const declaredFkSet = useMemo(() => {
    const keys = new Set<string>();
    graph?.relations.forEach((rel) => {
      if (!rel.inferred) keys.add(`${rel.fromTable}:${rel.fromColumn}`);
    });
    return keys;
  }, [graph]);

  const inferredFkSet = useMemo(() => {
    const keys = new Set<string>();
    graph?.relations.forEach((rel) => {
      if (rel.inferred) keys.add(`${rel.fromTable}:${rel.fromColumn}`);
    });
    return keys;
  }, [graph]);

  const hasActions = Boolean(props.canAct && (props.onUseInChat || props.onOpenInCanvas));
  const hasSchemaContent = Boolean(props.schemaText?.trim());

  if (!props.loading && !props.error && !hasSchemaContent && !hasActions) {
    return null;
  }

  return (
    <section className={cn("rounded-2xl border border-line bg-surface/70 p-4", props.className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Table2 className="h-3.5 w-3.5" />
          </div>
          <div>
            <h4 className="text-[12.5px] font-semibold text-ink">
              {props.databaseName ? `${props.databaseName} · Schema Preview` : "Schema Preview"}
            </h4>
            {props.loading ? (
              <p className="text-[11px] text-muted">Inspecting tables and relationships...</p>
            ) : props.error ? (
              <p className="text-[11px] text-danger">Schema preview unavailable</p>
            ) : graph ? (
              <p className="text-[11px] text-muted">
                {graph.tables.length} {graph.tables.length === 1 ? "table" : "tables"}
                {" · "}
                {graph.relations.length} {graph.relations.length === 1 ? "relation" : "relations"}
                {truncated ? " (truncated preview)" : ""}
              </p>
            ) : hasSchemaContent ? (
              <p className="text-[11px] text-muted">
                Raw schema detected{truncated ? " (truncated preview)" : ""}
              </p>
            ) : (
              <p className="text-[11px] text-muted">No tables found yet — ready to query</p>
            )}
          </div>
        </div>

        {hasActions && (
          <div className="flex flex-wrap items-center gap-1.5">
            {props.onUseInChat && (
              <button
                type="button"
                onClick={props.onUseInChat}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-[11.5px] font-medium text-ink transition hover:bg-hover"
              >
                <Sparkles className="h-3 w-3 text-accent" />
                Use in Chat
              </button>
            )}
            {props.onOpenInCanvas && (
              <button
                type="button"
                onClick={props.onOpenInCanvas}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11.5px] font-medium text-accent-ink transition hover:opacity-90"
              >
                <Workflow className="h-3 w-3" />
                Open in Canvas
                <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {props.loading && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span>Loading schema metadata...</span>
        </div>
      )}

      {!props.loading && props.error && (
        <div className="mt-3 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {props.error}
        </div>
      )}

      {!props.loading && !props.error && hasSchemaContent && (
        graph && graph.tables.length > 0 ? (
          <div className="mt-3 space-y-3">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {graph.tables.slice(0, 6).map((table) => {
                const pkColumns = primaryKeyColumns(table);
                return (
                  <div
                    key={table.name}
                    className="rounded-xl border border-line bg-card p-3 shadow-[0_2px_10px_rgba(0,0,0,0.03)]"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2 border-b border-line/70 pb-1.5">
                      <span className="truncate font-mono text-[12px] font-semibold text-ink">{table.name}</span>
                      <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">
                        {table.columns.length} cols
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {table.columns.slice(0, 6).map((col) => {
                        const colKey = `${table.name}:${col.name}`;
                        const isFk = declaredFkSet.has(colKey);
                        const isInferredFk = !isFk && inferredFkSet.has(colKey);
                        const isPk = pkColumns.has(col.name);
                        return (
                          <li key={col.name} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="flex min-w-0 items-center gap-1.5 font-mono text-ink">
                              {isPk ? (
                                <KeyRound className="h-3 w-3 shrink-0 text-accent" />
                              ) : isFk || isInferredFk ? (
                                <Link2 className="h-3 w-3 shrink-0 text-muted" />
                              ) : (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint/60" />
                              )}
                              <span className="truncate">{col.name}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                              {isPk && (
                                <span className="rounded bg-accent-soft px-1 py-px text-[9px] font-semibold text-accent">
                                  PK
                                </span>
                              )}
                              {isFk && (
                                <span className="rounded bg-hover px-1 py-px text-[9px] font-semibold text-muted">
                                  FK
                                </span>
                              )}
                              {isInferredFk && (
                                <span
                                  title="Inferred from *_id column name"
                                  className="rounded bg-hover px-1 py-px text-[9px] font-medium text-faint"
                                >
                                  FK?
                                </span>
                              )}
                              <span className="font-mono text-[10px] text-faint">{col.type}</span>
                            </span>
                          </li>
                        );
                      })}
                      {table.columns.length > 6 && (
                        <li className="pt-0.5 text-[10.5px] text-faint">
                          +{table.columns.length - 6} more columns
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
            {graph.tables.length > 6 && (
              <p className="text-[11px] text-muted">Showing 6 of {graph.tables.length} tables.</p>
            )}
            {graph.relations.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-muted">
                  <GitBranch className="h-3 w-3 text-accent" />
                  Relations:
                </span>
                {graph.relations.slice(0, 6).map((rel) => (
                  <span
                    key={`${rel.fromTable}.${rel.fromColumn}->${rel.toTable}.${rel.toColumn}`}
                    className="rounded-full border border-line bg-card px-2 py-0.5 font-mono text-[10.5px] text-muted"
                  >
                    {rel.fromTable}.{rel.fromColumn} → {rel.toTable}.{rel.toColumn}
                    {rel.inferred ? " (inferred)" : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <pre className="mt-3 max-h-40 overflow-auto rounded-xl border border-line bg-card p-3 font-mono text-[11px] text-muted">
            {props.schemaText}
          </pre>
        )
      )}
    </section>
  );
}
