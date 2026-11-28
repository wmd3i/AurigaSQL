import { useEffect, useRef, useState } from "react";
import { Database, Loader2, Plus, Trash2, Unplug, X } from "lucide-react";
import {
  bff,
  type DataSource,
  type DemoConnection,
  type DemoGroupId,
  type UserConnection,
} from "../../api/bff";
import { cn } from "../../lib/cn";
import type { EmbeddedHeader } from "../settings/LlmConfigModal";
import { DatabaseConnectionPanel } from "./DatabaseConnectionPanel";
import { DialectIcon, dialectLabel } from "./DialectIcon";

const SCROLLBAR =
  "overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)] hover:[&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.5)]";

const DEMO_GROUP_IDS: DemoGroupId[] = ["bird", "bird_interact_a"];

export function DataConnectionModal(props: {
  open: boolean;
  embedded?: boolean;
  onHeaderChange?: (header: EmbeddedHeader | null) => void;
  onClose: () => void;
  onChanged: (source?: DataSource) => Promise<void> | void;
  onSelectAndClose?: (source: DataSource) => void;
  onOpenInCanvas?: (source: DataSource) => void;
}) {
  const [connections, setConnections] = useState<UserConnection[]>([]);
  const [demoConnections, setDemoConnections] = useState<DemoConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoBusyId, setDemoBusyId] = useState<DemoGroupId | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const refreshSeqRef = useRef(0);

  async function refreshAll(preferConnectionId?: string | null) {
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    setError("");
    const [connResult, demoResult] = await Promise.allSettled([
      bff.connections(),
      bff.demoConnections(),
    ]);
    if (seq !== refreshSeqRef.current) return;

    const errors: string[] = [];
    if (connResult.status === "fulfilled") {
      const nextConnections = connResult.value.connections;
      setConnections(nextConnections);
      if (preferConnectionId !== undefined) {
        setSelectedConnectionId(preferConnectionId);
      } else {
        setSelectedConnectionId((current) =>
          current && nextConnections.some((c) => c.id === current) ? current : null,
        );
      }
    } else {
      errors.push(String(connResult.reason));
    }

    if (demoResult.status === "fulfilled") {
      setDemoConnections(demoResult.value.connections);
    } else {
      errors.push(String(demoResult.reason));
    }

    if (errors.length > 0) setError(errors.join(" · "));
    setLoading(false);
  }

  async function handleCreated(source: DataSource) {
    await refreshAll(source.connection_id ?? null);
    await props.onChanged(source);
  }

  async function handleUpdated(source: DataSource) {
    await refreshAll(source.connection_id ?? selectedConnectionId);
    await props.onChanged(source);
  }

  async function handleDeleteConnection(conn: UserConnection) {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const confirmed = window.confirm(`Delete connection "${conn.name}"?`);
      if (!confirmed) return;
    }
    setDeletingIds((prev) => new Set(prev).add(conn.id));
    setError("");
    try {
      await bff.deleteDatabaseConnection(conn.id);
      setSelectedConnectionId((current) => (current === conn.id ? null : current));
      await refreshAll();
      await props.onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(conn.id);
        return next;
      });
    }
  }

  async function handleToggleDemoGroup(group: DemoConnection) {
    setDemoBusyId(group.source_group);
    setError("");
    let toggleError: string | null = null;
    try {
      if (group.connected) {
        await bff.disconnectDemoGroup(group.source_group);
      } else {
        await bff.connectDemoGroup(group.source_group);
      }
    } catch (err) {
      toggleError = String(err);
    }
    try {
      // refreshAll() clears `error` first, so the toggle error is set after it.
      await refreshAll();
      await props.onChanged();
    } catch (err) {
      toggleError = toggleError ?? String(err);
    } finally {
      setDemoBusyId(null);
      if (toggleError) setError((current) => (current ? `${toggleError} · ${current}` : toggleError!));
    }
  }

  useEffect(() => {
    if (!props.open) return;
    void refreshAll();
  }, [props.open]);

  useEffect(() => {
    if (!props.open || props.embedded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.embedded, props.onClose]);

  const editingConnection =
    connections.find((conn) => conn.id === selectedConnectionId) ?? null;

  const { onHeaderChange } = props;
  useEffect(() => {
    if (!props.embedded || !onHeaderChange) return;
    onHeaderChange({
      title: editingConnection ? `Connections · ${editingConnection.name}` : "Connections",
      onBack: editingConnection ? () => setSelectedConnectionId(null) : undefined,
    });
  }, [props.embedded, onHeaderChange, editingConnection]);

  useEffect(() => () => onHeaderChange?.(null), [onHeaderChange]);

  if (!props.open) return null;

  const demoList: DemoConnection[] = DEMO_GROUP_IDS.map(
    (groupId) =>
      demoConnections.find((item) => item.source_group === groupId) ?? {
        source_group: groupId,
        label: groupId === "bird" ? "BIRD SQLite" : "BIRD-Interact (SQLite)",
        engine: "sqlite",
        description: "Bundled SQLite demo databases",
        connected: false,
        ready_count: 0,
        reason: "",
      },
  );

  const innerContent = (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row",
        !props.embedded &&
          "h-[min(800px,94vh)] w-full max-w-[980px] rounded-[28px] border border-line bg-card shadow-[0_32px_100px_rgba(11,18,14,0.22)]",
      )}
    >
      {/* Left Rail: Saved Connections + Demo Datasets */}
      <aside
        className={cn(
          "flex max-h-[38%] w-full shrink-0 flex-col border-b border-line/70 bg-surface/65 p-4 md:max-h-none md:border-b-0 md:border-r",
          props.embedded ? "md:w-[250px]" : "md:w-[285px] md:p-5",
          SCROLLBAR,
        )}
      >
        {!props.embedded && (
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Database className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">Data Connections</h2>
                <p className="text-[11.5px] text-muted">Manage databases & schemas</p>
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-card text-muted transition hover:bg-hover hover:text-ink md:hidden"
              aria-label="Close data connections"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <button
          type="button"
          aria-pressed={selectedConnectionId === null}
          onClick={() => setSelectedConnectionId(null)}
          className={cn(
            "mb-4 flex h-9 w-full shrink-0 items-center justify-center gap-1.5 rounded-xl border text-[12.5px] font-medium transition",
            selectedConnectionId === null
              ? "border-accent bg-accent text-accent-ink shadow-sm"
              : "border-line bg-card text-ink hover:bg-hover",
          )}
        >
          <Plus className="h-4 w-4" />
          New Connection
        </button>

        <div className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">
                My Connections
              </span>
              <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] font-medium text-muted">
                {connections.length}
              </span>
            </div>

            {connections.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-card/60 px-3 py-3 text-[11.5px] leading-relaxed text-muted">
                No custom connections yet. Add PostgreSQL, MySQL, DuckDB, or SQLite on the right.
              </div>
            ) : (
              <div className="space-y-1.5">
                {connections.map((conn) => {
                  const selected = selectedConnectionId === conn.id;
                  const deleting = deletingIds.has(conn.id);
                  const subtitle = conn.host
                    ? `${conn.host}:${conn.port ?? ""}/${conn.database}`
                    : conn.location || conn.path;
                  return (
                    <div
                      key={conn.id}
                      className={cn(
                        "group flex items-start gap-2 rounded-xl border p-2.5 transition",
                        selected
                          ? "border-accent bg-accent-soft/70"
                          : "border-line/80 bg-card hover:border-accent/40 hover:bg-hover/60",
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelectedConnectionId(conn.id)}
                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                      >
                        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface">
                          <DialectIcon dialect={conn.engine} className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-semibold text-ink">{conn.name}</span>
                            <span
                              title={conn.ready ? "Ready" : conn.reason || "Offline"}
                              className={cn(
                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                conn.ready ? "bg-accent" : "bg-danger",
                              )}
                            />
                          </div>
                          <div className="truncate font-mono text-[10.5px] text-muted" title={subtitle}>
                            {subtitle || dialectLabel(conn.engine)}
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${conn.name}`}
                        title="Delete connection"
                        disabled={deleting}
                        onClick={() => void handleDeleteConnection(conn)}
                        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint opacity-70 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100 disabled:opacity-40"
                      >
                        {deleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 px-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">
              Demo Datasets
            </div>
            <div className="space-y-1.5">
              {demoList.map((group) => {
                const busy = demoBusyId === group.source_group;
                const shortLabel = group.source_group === "bird" ? "BIRD" : "BIRD-Interact";
                const statusText = group.connected
                  ? group.ready_count > 0
                    ? `${group.ready_count} databases ready`
                    : group.reason || "0 databases ready"
                  : "SQLite demo pack";
                return (
                  <div
                    key={group.source_group}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-[12px] transition",
                      group.connected
                        ? group.ready_count > 0
                          ? "border-accent/50 bg-accent-soft/60 text-ink"
                          : "border-danger/40 bg-danger-soft/40 text-ink"
                        : "border-line/80 bg-card text-muted",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            group.connected
                              ? group.ready_count > 0
                                ? "bg-accent"
                                : "bg-danger"
                              : "bg-faint/50",
                          )}
                        />
                        <span className="truncate font-medium text-ink">{shortLabel}</span>
                      </div>
                      <div
                        className={cn(
                          "truncate text-[10.5px]",
                          group.connected && group.ready_count === 0 ? "text-danger" : "text-muted",
                        )}
                        title={statusText}
                      >
                        {statusText}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={demoBusyId !== null}
                      aria-label={group.connected ? `Disconnect ${shortLabel}` : `Connect ${shortLabel}`}
                      onClick={() => void handleToggleDemoGroup(group)}
                      className={cn(
                        "inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition disabled:opacity-50",
                        group.connected
                          ? "border-line bg-card text-muted hover:bg-danger-soft hover:text-danger"
                          : "border-accent/40 bg-card text-accent hover:bg-accent-soft",
                      )}
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : group.connected ? (
                        <>
                          <Unplug className="h-3 w-3" />
                          Disconnect
                        </>
                      ) : (
                        "Connect"
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      {/* Right Main Pane */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!props.embedded && (
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line/70 px-6 pb-4 pt-5 md:px-8">
            <div className="min-w-0">
              <h3 className="truncate text-[19px] font-semibold tracking-[-0.02em] text-ink">
                {editingConnection ? `Connection · ${editingConnection.name}` : "Add a Data Source"}
              </h3>
              <p className="mt-0.5 text-[12px] text-muted">
                {editingConnection
                  ? "Inspect schema, test connectivity, or update parameters."
                  : "Connect PostgreSQL, MySQL, DuckDB, or SQLite — or paste a connection URL."}
              </p>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-card text-muted transition hover:bg-hover hover:text-ink md:flex"
              aria-label="Close data connections"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className={cn("flex min-h-0 flex-1 flex-col px-5 py-4 md:px-6", SCROLLBAR)}>
          {error && (
            <div role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger-soft px-4 py-2.5 text-[12.5px] text-danger">
              {error}
            </div>
          )}

          {loading && connections.length === 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-[12.5px] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading data sources...
            </div>
          )}

          <div className="max-w-2xl">
            <DatabaseConnectionPanel
              editingConnection={editingConnection}
              onCancelEdit={() => setSelectedConnectionId(null)}
              onCreated={handleCreated}
              onUpdated={handleUpdated}
              showDemoOption={false}
              onUseSource={(source) => {
                props.onSelectAndClose?.(source);
                if (!props.onSelectAndClose) props.onClose();
              }}
              onOpenInCanvas={(source) => {
                props.onOpenInCanvas?.(source);
              }}
              className="border-0 bg-transparent p-0 shadow-none backdrop-blur-0"
            />
          </div>
        </div>
      </section>
    </div>
  );

  if (props.embedded) {
    return innerContent;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Data Connections"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
    >
      {innerContent}
    </div>
  );
}
