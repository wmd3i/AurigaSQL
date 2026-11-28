import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { DataSource, TaskItem } from "../../api/bff";
import { DialectIcon } from "./DialectIcon";

export function filterSampleTasks(
  tasks: TaskItem[],
  selectedSource: DataSource | null,
): { tasks: TaskItem[]; filteredBySourceName: string | null } {
  if (!selectedSource) {
    return { tasks, filteredBySourceName: null };
  }
  const matching = tasks.filter((task) => task.source_id === selectedSource.id);
  if (matching.length > 0) {
    return { tasks: matching, filteredBySourceName: selectedSource.display_name };
  }
  return { tasks, filteredBySourceName: null };
}

export function QuestionCards(props: {
  tasks: TaskItem[];
  sources?: DataSource[];
  filteredBySourceName?: string | null;
  onPick: (t: TaskItem) => void;
}) {
  const [batchIndex, setBatchIndex] = useState(0);
  const taskSignature = props.tasks.map((task) => task.instance_id).join("|");
  const batchSize = 3;
  const batchCount = Math.max(1, Math.ceil(props.tasks.length / batchSize));
  const safeBatchIndex = batchIndex % batchCount;
  const shown = Array.from(
    { length: Math.min(batchSize, props.tasks.length) },
    (_, index) => props.tasks[(safeBatchIndex * batchSize + index) % props.tasks.length],
  );
  const sourceById = new Map<string, DataSource>(
    (props.sources ?? []).map((source) => [source.id, source]),
  );

  useEffect(() => {
    setBatchIndex(0);
  }, [taskSignature]);

  if (shown.length === 0) return null;

  return (
    <section className="w-full" aria-label="Sample questions">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-[13.5px] font-semibold text-ink">Sample questions</h3>
          {props.filteredBySourceName && (
            <span className="truncate rounded-full border border-line bg-card/80 px-2.5 py-0.5 text-[11px] font-medium text-muted">
              {props.filteredBySourceName}
            </span>
          )}
        </div>
        {props.tasks.length > batchSize && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11.5px] tabular-nums text-faint">
              {safeBatchIndex + 1} / {batchCount}
            </span>
            <button
              type="button"
              onClick={() => setBatchIndex((current) => (current + 1) % batchCount)}
              className="group inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium text-muted transition hover:bg-hover hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-45" />
              Refresh
            </button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {shown.map((t) => {
          const source = sourceById.get(t.source_id);
          const dialect = source?.engine ?? "sqlite";
          const dbLabel = source?.display_name ?? t.database;
          return (
            <button
              key={t.instance_id}
              type="button"
              onClick={() => props.onPick(t)}
              className="group flex h-full flex-col justify-between gap-2 rounded-[18px] border border-line/75 bg-card/65 px-4 py-3 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-accent/45 hover:bg-card hover:shadow-sm"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line/70 bg-surface/70 px-2 py-0.5 text-[11px] font-medium text-muted">
                    <DialectIcon dialect={dialect} className="h-3 w-3 shrink-0" />
                    <span className="truncate">{dbLabel}</span>
                  </span>
                  {t.has_follow_up ? (
                    <span className="shrink-0 text-[10.5px] font-medium text-faint">Multi-turn</span>
                  ) : t.num_critical_ambiguity > 0 ? (
                    <span className="shrink-0 text-[10.5px] font-medium text-faint">Clarify</span>
                  ) : null}
                </div>
                <p className="line-clamp-3 text-[13px] leading-6 text-ink">{t.amb_user_query}</p>
              </div>
              <div className="flex items-center justify-end text-[11px] font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <span className="inline-flex items-center gap-1">
                  Use prompt
                  <ArrowUpRight className="h-3 w-3" />
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
