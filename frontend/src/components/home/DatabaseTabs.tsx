import { AlertCircle, Sparkles, Trash2, Unplug } from "lucide-react";
import type { DemoGroupId, DataSource } from "../../api/bff";
import { cn } from "../../lib/cn";
import { DialectIcon, dialectLabel } from "./DialectIcon";

function demoGroupLabel(id: string): string {
  if (id === "user_connection") return "My Connections";
  if (id === "bird") return "BIRD";
  if (id === "bird_interact_a") return "BIRD-Interact (SQLite Edition)";
  return id;
}

function isDemoGroupId(id: string): id is DemoGroupId {
  return id === "bird" || id === "bird_interact_a";
}

export function DataSourceTabs(props: {
  sources: DataSource[];
  selectedSourceId: string | null;
  onSelectSource: (source: DataSource) => void;
  onSelectAutoSource?: () => void;
  sourceMismatch?: {
    selectedName: string;
    suggestedName: string;
    reason: string;
  } | null;
  onUseSuggestedSource?: () => void;
  onConfirmSelectedSource?: () => void;
  onDeleteConnection?: (source: DataSource) => void;
  onDisconnectDemoGroup?: (groupId: DemoGroupId) => void;
  highlight: boolean;
}) {
  const groups = props.sources.reduce<Record<string, DataSource[]>>((acc, source) => {
    (acc[source.source_group] ??= []).push(source);
    return acc;
  }, {});

  return (
    <section
      className={cn(
        "rounded-[22px] border border-line bg-card/92 p-3 shadow-sm backdrop-blur",
        props.highlight && "ring-2 ring-danger",
      )}
    >
      <div className="mb-3 flex items-center gap-2 px-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">Data Source</p>
      </div>
      {props.sources.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line bg-canvas/70 px-3 py-4 text-[12px] leading-5 text-muted">
          Connect a demo dataset or custom database from Workspace.
        </div>
      )}
      <div className="space-y-3 px-2 pb-1">
        {Object.entries(groups).map(([groupId, sources]) => {
          const showHeader = Object.keys(groups).length > 1 || groupId !== "bird";
          return (
            <div key={groupId}>
              {showHeader && (
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="text-[11px] font-medium text-muted">{demoGroupLabel(groupId)}</div>
                  {isDemoGroupId(groupId) && (
                    <button
                      type="button"
                      title={`Disconnect ${demoGroupLabel(groupId)}`}
                      onClick={() => props.onDisconnectDemoGroup?.(groupId)}
                      className="inline-flex h-6 items-center gap-1 rounded-lg px-2 text-[11px] text-faint transition hover:bg-danger-soft hover:text-danger"
                    >
                      <Unplug className="h-3 w-3" />
                      Disconnect
                    </button>
                  )}
                </div>
              )}
            <div className="flex flex-wrap gap-2">
              {Object.keys(groups)[0] === groupId && (
                <button
                  type="button"
                  title="Automatically choose the database for each question"
                  onClick={props.onSelectAutoSource}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                    props.selectedSourceId === null
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line bg-canvas text-muted hover:bg-hover",
                  )}
                >
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  <span>Auto</span>
                </button>
              )}
              {sources.map((source) => {
                const selected = props.selectedSourceId === source.id;
                const content = (
                  <>
                    {source.ready ? (
                      <DialectIcon dialect={source.engine} />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate">{source.display_name}</span>
                  </>
                );
                const buttonClass = cn(
                  "inline-flex max-w-full items-center gap-1.5 border px-3 py-1.5 text-[13px] transition-colors",
                  source.source_type === "user_connection" ? "rounded-l-full rounded-r-none" : "rounded-full",
                  selected
                    ? "border-accent bg-accent-soft text-accent"
                    : source.ready
                      ? "border-line bg-canvas text-muted hover:bg-hover"
                      : "cursor-not-allowed border-line/70 bg-canvas/60 text-faint",
                );
                if (source.source_type !== "user_connection") {
                  return (
                    <button
                      key={source.id}
                      type="button"
                      disabled={!source.ready}
                      title={source.ready ? `${demoGroupLabel(source.source_group)} · ${dialectLabel(source.engine)}` : source.reason}
                      onClick={() => props.onSelectSource(source)}
                      className={buttonClass}
                    >
                      {content}
                    </button>
                  );
                }
                return (
                  <span key={source.id} className="inline-flex max-w-full">
                    <button
                      type="button"
                      disabled={!source.ready}
                      title={source.ready ? `${source.db_path ?? source.display_name} · ${dialectLabel(source.engine)}` : source.reason}
                      onClick={() => props.onSelectSource(source)}
                      className={buttonClass}
                    >
                      {content}
                    </button>
                    <button
                      type="button"
                      title="Delete connection"
                      aria-label={`Delete ${source.display_name}`}
                      onClick={() => props.onDeleteConnection?.(source)}
                      className="inline-flex h-[33px] w-8 items-center justify-center rounded-r-full border border-l-0 border-line bg-canvas text-faint transition hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
          );
        })}
        {props.sourceMismatch && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-accent/30 bg-accent-soft/50 px-3 py-2 text-[12px] text-muted">
            <span>
              You may have selected the wrong database. AurigaSQL suggests{" "}
              <span className="font-semibold text-accent">{props.sourceMismatch.suggestedName}</span>.
            </span>
            <button
              type="button"
              onClick={props.onUseSuggestedSource}
              className="rounded-full border border-accent/40 bg-card px-2.5 py-1 font-semibold text-accent transition hover:bg-hover"
            >
              Use suggested
            </button>
            <button
              type="button"
              onClick={props.onConfirmSelectedSource}
              className="rounded-full border border-line bg-card px-2.5 py-1 font-semibold text-muted transition hover:bg-hover hover:text-ink"
            >
              Keep {props.sourceMismatch.selectedName}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
