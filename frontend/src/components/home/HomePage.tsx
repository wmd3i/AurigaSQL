import { useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { bff, type DemoGroupId, type DataSource, type TaskItem } from "../../api/bff";
import { useModels } from "../../state/modelContext";
import { CHAT_START_NAVIGATION, type Conversation } from "../../state/types";
import { HomeSidebar } from "./HomeSidebar";
import { HomeHero } from "./HomeHero";
import { HomeComposer } from "./HomeComposer";
import { DataSourceTabs } from "./DatabaseTabs";
import { QuestionCards } from "./QuestionCards";
import type { QueryMode } from "../../state/types";
import { FlowModeSwitch } from "../FlowModeSwitch";
import type { BranchTarget } from "../canvas/CanvasComposer";
import type { CanvasToneId } from "../../lib/canvasTones";
import { PendingChatMain } from "../result/PendingChatMain";
import { PendingChatsContext } from "../../state/pendingChatsContext";

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

type PendingChat = {
  id?: string;
  title: string;
  database?: string;
  showChatPreview?: boolean;
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
    options?: { preserveView?: boolean; canvasTone?: CanvasToneId; pendingId?: string },
  ) => Promise<void>;
  onOpenCanvas: (source: DataSource | null) => void;
  selectedDataSource?: DataSource | null;
  selectedSourceToken?: number;
  onOpenConnections?: () => void;
  onOpenLlmConfig: () => void;
  dataConnectionVersion?: number;
}) {
  const { selectedId: modelId } = useModels();
  const { dispatch } = useContext(PendingChatsContext)!;
  const [sources, setSources] = useState<DataSource[]>(() => props.selectedDataSource ? [props.selectedDataSource] : []);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(props.selectedDataSource?.id ?? null);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [sourceMismatch, setSourceMismatch] = useState<SourceMismatch | null>(null);
  const [highlight, setHighlight] = useState(false);
  const [pendingChat, setPendingChat] = useState<PendingChat | null>(null);
  const startControllerRef = useRef<AbortController | null>(null);
  const appliedSelectionTokenRef = useRef<number | undefined>(undefined);
  const busy = pendingChat !== null;
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

  async function sourceForQuery(query: string, signal: AbortSignal): Promise<{ source: DataSource; mismatch: SourceMismatch | null }> {
    const matching = new AbortController();
    const cancelMatching = () => {
      if (signal.reason !== CHAT_START_NAVIGATION) matching.abort(signal.reason);
    };
    if (signal.aborted) cancelMatching();
    else signal.addEventListener("abort", cancelMatching, { once: true });
    let resolved: Awaited<ReturnType<typeof bff.resolveDataSource>>;
    try {
      resolved = await bff.resolveDataSource(query, modelId, matching.signal);
    } catch (error) {
      if (matching.signal.aborted) throw error;
      if (selectedSource) {
        return { source: selectedSource, mismatch: null };
      }
      throw new Error(AUTO_MATCH_MANUAL_SELECT_HINT);
    } finally {
      signal.removeEventListener("abort", cancelMatching);
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
    options?: { preserveView?: boolean; canvasTone?: CanvasToneId; pendingId?: string },
  ) {
    if (!signal?.aborted) setSourceMismatch(null);
    await props.onStart(source, query, mode, signal, branchTarget, parentContext, options);
  }

  async function runPendingStart(
    pending: PendingChat,
    start: (signal: AbortSignal, pendingId: string) => Promise<void>,
  ) {
    if (startControllerRef.current) return;
    const controller = new AbortController();
    const id = crypto.randomUUID();
    startControllerRef.current = controller;
    setPendingChat({ ...pending, id });
    dispatch({ type: "PENDING_CHAT_STARTED", chat: { id, title: pending.title, database: pending.database, createdAt: Date.now() } });
    setHint(null);
    try {
      await start(controller.signal, id);
    } catch (error) {
      if (!controller.signal.aborted) setHint(errorMessage(error));
      else if (controller.signal.reason === CHAT_START_NAVIGATION) {
        toast.error(errorMessage(error), { description: pending.title });
      }
    } finally {
      dispatch({ type: "PENDING_CHAT_FINISHED", id });
      if (startControllerRef.current === controller) {
        startControllerRef.current = null;
        setPendingChat(null);
      }
    }
  }

  async function startPendingMismatch(source: DataSource) {
    if (!sourceMismatch) return;
    await runPendingStart({ title: sourceMismatch.query, database: source.display_name }, async (signal, pendingId) => {
      await startWithSource(
        source,
        sourceMismatch.query,
        sourceMismatch.mode,
        signal,
        sourceMismatch.branchTarget ?? null,
        sourceMismatch.parentContext,
        { preserveView: sourceMismatch.preserveView, canvasTone: sourceMismatch.canvasTone, pendingId },
      );
      if (!signal.aborted) setSelectedSourceId(source.id);
    });
  }

  function selectAutoSource() {
    setSelectedSourceId(null);
    setSourceMismatch(null);
  }

  useEffect(() => {
    if (props.selectedSourceToken !== undefined) {
      if (appliedSelectionTokenRef.current === props.selectedSourceToken) return;
      appliedSelectionTokenRef.current = props.selectedSourceToken;
      if (props.selectedDataSource?.id) {
        setSelectedSourceId(props.selectedDataSource.id);
        setSourceMismatch(null);
      }
      return;
    }
    if (props.selectedDataSource?.id) {
      setSelectedSourceId(props.selectedDataSource.id);
      setSourceMismatch(null);
    }
  }, [props.selectedSourceToken, props.selectedDataSource?.id]);

  useEffect(() => {
    refreshSources()
      .catch(() =>
        setHint("Cannot reach backend — run: bash backend/scripts/start_services.sh"),
      );
  }, [props.dataConnectionVersion]);

  useEffect(() => {
    bff.tasks(1000).then((r) => setTasks(r.tasks)).catch(() => {}); // dataset has ~300 tasks; default 200 dropped later DBs
  }, []);

  useEffect(() => () => {
    startControllerRef.current?.abort(CHAT_START_NAVIGATION);
    startControllerRef.current = null;
  }, []);

  async function handleSend() {
    const query = draft.trim();
    if (!query || busy) return;
    if (!modelId) {
      toast.error("Select a model before asking a question", {
        id: "model-not-selected",
        action: { label: "Select model", onClick: props.onOpenLlmConfig },
      });
      return;
    }

    if (!sources.some((source) => source.ready)) {
      toast.error("Connect data before asking a question", {
        id: "data-not-connected",
        action: props.onOpenConnections
          ? { label: "Connect data", onClick: props.onOpenConnections }
          : undefined,
      });
      if (sources.length > 0) {
        setHighlight(true);
        setTimeout(() => setHighlight(false), 1500);
      }
      return;
    }

    const pending = {
      title: query,
      database: selectedSource?.display_name,
      showChatPreview: !selectedSource,
    };
    await runPendingStart(pending, async (signal, pendingId) => {
      const { source, mismatch } = await sourceForQuery(query, signal);
      if (signal.aborted && signal.reason !== CHAT_START_NAVIGATION) return;
      if (mismatch) {
        if (signal.aborted) {
          toast.error("Confirm the data source before sending this question again", { description: query });
        } else {
          setSourceMismatch(mismatch);
        }
        return;
      }
      dispatch({ type: "PENDING_CHAT_DATABASE", id: pendingId, database: source.display_name });
      if (!signal.aborted) setPendingChat({ ...pending, id: pendingId, database: source.display_name });
      await startWithSource(source, query, "agent", signal, undefined, undefined, { pendingId });
    });
  }

  function handlePauseStart() {
    startControllerRef.current?.abort();
    startControllerRef.current = null;
    if (pendingChat?.id) dispatch({ type: "PENDING_CHAT_FINISHED", id: pendingChat.id });
    setPendingChat(null);
  }

  function leavePendingStart() {
    startControllerRef.current?.abort(CHAT_START_NAVIGATION);
    startControllerRef.current = null;
    setPendingChat(null);
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
    if (mode !== "workspace") return;
    leavePendingStart();
    props.onOpenCanvas(selectedSource);
  }

  return (
    <div className="app-shell-bg flex h-screen w-screen overflow-hidden text-ink">
      <HomeSidebar
        conversations={props.conversations}
        pendingChat={pendingChat}
        activeSection="chat"
        activeConversationId={props.activeId}
        onNewFlow={() => {
          leavePendingStart();
          setDraft("");
          props.onNewFlow();
        }}
        onOpen={props.onOpen}
        onDeleteConversation={props.onDeleteConversation}
        dataSources={sources}
        databases={taskDatabases}
        selectedDataSourceId={selectedSourceId ?? activeConversation?.source?.id ?? null}
        onSelectDataSource={selectSource}
        onOpenLlmConfig={props.onOpenLlmConfig}
      />
      {pendingChat?.showChatPreview ? (
        <PendingChatMain
          title={pendingChat.title}
          database={pendingChat.database}
          onStop={handlePauseStart}
          onModeChange={handleModeChange}
        />
      ) : (
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
                  mode="agent"
                  onModeChange={handleModeChange}
                  busy={busy}
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
      )}
    </div>
  );
}
