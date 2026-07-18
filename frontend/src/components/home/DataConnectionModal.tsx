import { useEffect, useState } from "react";
import { Database, X } from "lucide-react";
import { bff, type DemoConnection, type DataSource } from "../../api/bff";
import { cn } from "../../lib/cn";
import { DatabaseConnectionPanel } from "./DatabaseConnectionPanel";

const SCROLLBAR =
  "overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)] hover:[&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.5)]";

export function DataConnectionModal(props: {
  open: boolean;
  onClose: () => void;
  onChanged: (source?: DataSource) => Promise<void> | void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function refreshSources() {
    setLoading(true);
    setError("");
    try {
      await bff.dataSources();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreated(source: DataSource) {
    await refreshSources();
    await props.onChanged(source);
  }

  async function handleDemoGroupChanged(_connection: DemoConnection) {
    await refreshSources();
    await props.onChanged();
  }

  useEffect(() => {
    if (!props.open) return;
    refreshSources();
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,16,12,0.32)] p-4 backdrop-blur-sm">
      <div className="relative flex h-[min(760px,94vh)] w-full max-w-[860px] overflow-hidden rounded-[34px] border border-line bg-[#fbfbf8] shadow-[0_32px_100px_rgba(11,18,14,0.18)]">
        <button
          type="button"
          onClick={props.onClose}
          className="absolute right-10 top-7 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-card text-muted transition hover:bg-hover hover:text-ink"
          aria-label="Close data connections"
        >
          <X className="h-6 w-6" />
        </button>

        <section className={cn("flex min-w-0 flex-1 flex-col p-10", SCROLLBAR)}>
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Database className="h-5 w-5" />
              </div>
              <h2 className="text-[28px] font-semibold tracking-[-0.03em] text-ink">Data Connections</h2>
            </div>
          </div>

          {error && (
            <div className="mb-5 rounded-[18px] border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {error}
            </div>
          )}

          {loading && (
            <div className="mb-5 rounded-[18px] border border-line bg-card px-4 py-3 text-[13px] text-muted">
              Loading data sources...
            </div>
          )}

          <div className="max-w-3xl">
            <DatabaseConnectionPanel
              onCreated={handleCreated}
              onDemoGroupConnected={handleDemoGroupChanged}
              className="border-0 bg-transparent p-0 shadow-none backdrop-blur-0"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
