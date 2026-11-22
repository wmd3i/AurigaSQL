import { useEffect, useRef, useState } from "react";
import { bff, type DemoGroupId, type DataSource, type TaskItem } from "../../api/bff";
import { useModels } from "../../state/modelContext";
import type { Conversation } from "../../state/types";
import { HomeSidebar } from "./HomeSidebar";
import { HomeHero } from "./HomeHero";
import { HomeComposer } from "./HomeComposer";
import { DataSourceTabs } from "./DatabaseTabs";
import { QuestionCards } from "./QuestionCards";
import type { QueryMode } from "../../state/types";
import { FlowModeSwitch } from "../FlowModeSwitch";
import type { BranchTarget } from "../canvas/CanvasComposer";
import type { CanvasToneId } from "../../lib/canvasTones";

type SourceMismatch = {
  query: string;
  mode: QueryMode;
  selectedSource: DataSource;
  suggestedSource: DataSource;
  reason: string;
  branchTarget?: BranchTarget | null;
  parentContext?: string;
  canvasTone?: CanvasToneId;
  preserveView?: boolean;
};

const AUTO_MATCH_MANUAL_SELECT_HINT =
  "Auto match could not choose a database. Please select a data source manually, then send again.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function HomePage(props: {
  conversations: Conversation[];
  activeId: string | null;
  onNewFlow: () => void;
  onOpen: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onStart: (
    source: DataSource,
    query: string,
    mode: QueryMode,
    signal?: AbortSignal,
    branchTarget?: BranchTarget | null,
    parentContext?: string,
    options?: { preserveView?: boolean; canvasTone?: CanvasToneId },
  ) => Promise<void>;
  onOpenWorkspaceSetup: () => void;
  onOpenCanvas: (source: DataSource | null) => void;
  selectedDataSource?: DataSource | null;
  onOpenLlmConfig: () => void;
  dataConnectionVersion?: number;
}) {
  const { selectedId: modelId } = useModels();
  const [sources, setSources] = useState<DataSource[]>(() => props.selectedDataSource ? [props.selectedDataSource] : []);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(props.selectedDataSource?.id ?? null);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [sourceMismatch, setSourceMismatch] = useState<SourceMismatch | null>(null);
  const [highlight, setHighlight] = useState(false);
  const [busy, setBusy] = useState(false);
  const startControllerRef = useRef<AbortController | null>(null);
  const selectedSource = sources.find((source) => source.id === selectedSourceId && source.ready) ?? null;
  const activeConversation = props.conversations.find((conversation) => conversation.id === props.activeId) ?? null;
  const connectedSourceIds = new Set(sources.filter((source) => source.ready).map((source) => source.id));
  const visibleTasks = tasks.filter((task) => connectedSourceIds.has(task.source_id));
  const taskDatabases = Array.from(new Set(visibleTasks.map((task) => task.database))).sort((a, b) => a.localeCompare(b));

  async function refreshSources(selectId?: string | null) {
    const response = await bff.dataSources();
    setSources(response.sources);
    setSelectedSourceId((current) => {
      if (selectId) return selectId;
      if (current && response.sources.some((source) => source.id === current && source.ready)) return current;
      return null;
    });
    return response.sources;
  }

  function selectSource(source: DataSource) {
    if (!source.ready) return;
    setSelectedSourceId(source.id);
    setSourceMismatch(null);
  }

  async function sourceForQuery(query: string): Promise<{ source: DataSource; mismatch: SourceMismatch | null }> {
    let resolved: Awaited<ReturnType<typeof bff.resolveDataSource>>;
    try {
      resolved = await bff.resolveDataSource(query, modelId);
    } catch (error) {
      if (selectedSource) {
        return { source: selectedSource, mismatch: null };
      }
      throw new Error(AUTO_MATCH_MANUAL_SELECT_HINT);
    }
    if (selectedSource) {
      if (resolved.source.id !== selectedSource.id) {
        return {
          source: selectedSource,
          mismatch: {
            query,
            mode: "agent",
            selectedSource,
            suggestedSource: resolved.source,
            reason: resolved.reason,
          },
        };
      }
      return { source: selectedSource, mismatch: null };
    }
    return { source: resolved.source, mismatch: null };
  }

  async function startWithSource(
    source: DataSource,
    query: string,
    mode: QueryMode,
    signal?: AbortSignal,
    branchTarget?: BranchTarget | null,
    parentContext?: string,
    options?: { preserveView?: boolean; canvasTone?: CanvasToneId },
  ) {
    setSourceMismatch(null);
    await props.onStart(source, query, mode, signal, branchTarget, parentContext, options);
  }

  async function startPendingMismatch(source: DataSource) {
    if (!sourceMismatch || busy) return;
    setBusy(true);
    setHint(null);
    try {
      await startWithSource(
        source,
        sourceMismatch.query,
        sourceMismatch.mode,
        undefined,
        sourceMismatch.branchTarget ?? null,
        sourceMismatch.parentContext,
        { preserveView: sourceMismatch.preserveView, canvasTone: sourceMismatch.canvasTone },
      );
      setSelectedSourceId(source.id);
    } catch (error) {
      setHint(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function selectAutoSource() {
    setSelectedSourceId(null);
    setSourceMismatch(null);
  }

  useEffect(() => {
    refreshSources()
      .catch(() =>
        setHint("Cannot reach backend — run: bash backend/scripts/start_services.sh"),
      );
  }, [props.dataConnectionVersion]);

  useEffect(() => {
    bff.tasks(1000).then((r) => setTasks(r.tasks)).catch(() => {}); // dataset has ~300 tasks; default 200 dropped later DBs
  }, []);

  async function handleSend() {
    const query = draft.trim();
    if (!query || busy) return;
    if (!modelId) {
      setHint("Please set up a model first from LLM Configure");
      return;
    }

    if (!sources.some((source) => source.ready)) {
      setHint("Connect data before asking a question");
      if (sources.length > 0) {
        setHighlight(true);
        setTimeout(() => setHighlight(false), 1500);
      }
      return;
    }

    setBusy(true);
    setHint(null);
    const controller = new AbortController();
    startControllerRef.current = controller;
    try {
      const { source, mismatch } = await sourceForQuery(query);
      if (mismatch) {
        setSourceMismatch(mismatch);
        return;
      }
      await startWithSource(source, query, "agent", controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return;
      setHint(errorMessage(e));
    } finally {
      if (startControllerRef.current === controller) {
        startControllerRef.current = null;
        setBusy(false);
      }
    }
  }

  function handlePauseStart() {
    startControllerRef.current?.abort();
    startControllerRef.current = null;
    setBusy(false);
  }

  async function handleDeleteConnection(source: DataSource) {
    if (!source.connection_id) return;
    const confirmed = window.confirm(`Delete connection "${source.display_name}"?`);
    if (!confirmed) return;
    try {
      await bff.deleteDatabaseConnection(source.connection_id);
      await refreshSources(selectedSourceId === source.id ? null : undefined);
    } catch (error) {
      setHint(`Failed to delete connection: ${errorMessage(error)}`);
    }
  }

  async function handleDisconnectDemoGroup(groupId: DemoGroupId) {
    const confirmed = window.confirm(`Disconnect ${groupId.replaceAll("_", "-")} data sources?`);
    if (!confirmed) return;
    try {
      await bff.disconnectDemoGroup(groupId);
      await refreshSources();
    } catch (error) {
      setHint(`Failed to disconnect data source: ${errorMessage(error)}`);
    }
  }

  function handleModeChange(mode: QueryMode) {
    if (mode === "workspace") props.onOpenCanvas(selectedSource);
  }

  return (
    <div className="app-shell-bg flex h-screen w-screen overflow-hidden text-ink">
      <HomeSidebar
        conversations={props.conversations}
        activeSection="chat"
        activeConversationId={props.activeId}
        onNewFlow={props.onNewFlow}
        onOpenWorkspaceSetup={props.onOpenWorkspaceSetup}
        onOpen={props.onOpen}
        onDeleteConversation={props.onDeleteConversation}
        dataSources={sources}
        databases={taskDatabases}
        selectedDataSourceId={selectedSourceId ?? activeConversation?.source?.id ?? null}
        onSelectDataSource={selectSource}
        onOpenLlmConfig={props.onOpenLlmConfig}
      />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6 sm:px-8 lg:px-12">
        <div className="-ml-3 flex justify-start sm:-ml-4">
          <FlowModeSwitch mode="agent" onModeChange={handleModeChange} />
        </div>
        <div className="mx-auto flex w-full max-w-5xl flex-col pt-14 sm:pt-20">
          <div className="mb-12">
            <HomeHero variant="default" />
          </div>
          <div className="mx-auto w-full max-w-4xl space-y-5">
            <div className="relative w-full">
              <HomeComposer
                value={draft}
                onChange={setDraft}
                onSend={handleSend}
                onStop={handlePauseStart}
                onOpenDataSetup={props.onOpenWorkspaceSetup}
                mode="agent"
                onModeChange={handleModeChange}
                busy={busy}
                hasDataSource={sources.some((source) => source.ready)}
                hint={hint}
                onOpenLlmConfig={props.onOpenLlmConfig}
              />
            </div>
            {sources.length > 0 && (
              <DataSourceTabs
                sources={sources}
                selectedSourceId={selectedSourceId}
                onSelectSource={selectSource}
                onSelectAutoSource={selectAutoSource}
                sourceMismatch={
                  sourceMismatch
                    ? {
                        selectedName: sourceMismatch.selectedSource.display_name,
                        suggestedName: sourceMismatch.suggestedSource.display_name,
                        reason: sourceMismatch.reason,
                      }
                    : null
                }
                onUseSuggestedSource={() => void startPendingMismatch(sourceMismatch!.suggestedSource)}
                onConfirmSelectedSource={() => void startPendingMismatch(sourceMismatch!.selectedSource)}
                onDeleteConnection={handleDeleteConnection}
                onDisconnectDemoGroup={handleDisconnectDemoGroup}
                highlight={highlight}
              />
            )}
          </div>
          <div className="mt-20 transition-all duration-300 ease-out">
            <QuestionCards
              tasks={visibleTasks}
              onPick={(t) => {
                setDraft(t.amb_user_query);
              }}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
