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
import { cn } from "../../lib/cn";
import { CanvasPage } from "../canvas/CanvasPage";
import { buildNodes, type ThreadNode } from "../../lib/buildNodes";
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

const BRANCH_FIELD_LIMIT = 2400;
const BRANCH_CONTEXT_LIMIT = 14000;
const AUTO_MATCH_MANUAL_SELECT_HINT =
  "Auto match could not choose a database. Please select a data source manually, then send again.";

function compactForBranchContext(text: string, limit = BRANCH_FIELD_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n...[truncated for branch context]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatNodeForBranchContext(node: ThreadNode): string {
  const parts: string[] = [];
  switch (node.kind) {
    case "question":
      parts.push(`User: ${compactForBranchContext(node.body)}`);
      break;
    case "thinking":
      parts.push(`Assistant reasoning: ${compactForBranchContext(node.body, 1200)}`);
      break;
    case "tool":
      parts.push(`Tool call: ${node.title ?? "tool"}`);
      if (node.summary) parts.push(`Purpose: ${compactForBranchContext(node.summary, 800)}`);
      if (node.reasoning) parts.push(`Reasoning: ${compactForBranchContext(node.reasoning, 1000)}`);
      if (node.body) parts.push(`Input:\n${compactForBranchContext(node.body, 1400)}`);
      if (node.result !== undefined) parts.push(`Result:\n${compactForBranchContext(node.result)}`);
      break;
    case "agent_question":
      parts.push(`Assistant asked user: ${compactForBranchContext(node.body)}`);
      break;
    case "user_answer":
      parts.push(`User answered: ${compactForBranchContext(node.body)}`);
      break;
    case "answer":
      parts.push("Assistant submitted final SQL:");
      if (node.body) parts.push(compactForBranchContext(node.body, 2000));
      if (node.result !== undefined) parts.push(`Execution result:\n${compactForBranchContext(node.result)}`);
      break;
    case "agent_text":
      parts.push(`Assistant: ${compactForBranchContext(node.body)}`);
      break;
  }
  return parts.join("\n");
}

function conversationTranscript(conv: Conversation, throughNodeId?: string | null): string {
  const nodes = buildNodes(conv.timeline, conv.title);
  const endIndex = throughNodeId ? nodes.findIndex((node) => node.id === throughNodeId) : -1;
  const included = endIndex >= 0 ? nodes.slice(0, endIndex + 1) : nodes;
  return [
    `Thread ${conv.id}`,
    `Database: ${conv.database}`,
    `Original user query: ${conv.title}`,
    ...included.map((node, index) => `\n[Card ${index + 1}: ${node.kind}${node.title ? `/${node.title}` : ""}]\n${formatNodeForBranchContext(node)}`),
  ].join("\n");
}

function buildBranchParentContext(conversations: Conversation[], target?: BranchTarget | null): string | undefined {
  if (!target) return undefined;
  const byId = new Map(conversations.map((conv) => [conv.id, conv]));
  const parent = byId.get(target.parentThreadId);
  if (!parent) return undefined;

  const chain: Conversation[] = [];
  const seen = new Set<string>();
  let current: Conversation | undefined = parent;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined;
  }

  const sections = chain.map((conv, index) =>
    conversationTranscript(conv, index === chain.length - 1 ? target.parentNodeId : null),
  );

  const context = [
    "The new user message starts a branch from an existing canvas thread.",
    `Branch anchor: thread ${target.parentThreadId}, card ${target.parentNodeId} (${target.label}).`,
    "Treat the next user message as a follow-up question from that exact branch anchor, not as an unrelated new task. Use the compact parent-thread transcript below as prior conversation context. Continue from the branch anchor and preserve user intent, assumptions, SQL exploration, tool results, and clarifications. Re-fetch schema or knowledge if the compact context is insufficient.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
  return compactForBranchContext(context, BRANCH_CONTEXT_LIMIT);
}

export function HomePage(props: {
  conversations: Conversation[];
  activeId: string | null;
  onNewFlow: () => void;
  onStartOverWorkspace: () => void;
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
  onAnswer: (id: string, text: string) => void;
  onStop: (id: string) => void;
  mode: QueryMode;
  onModeChange: (mode: QueryMode) => void;
  onOpenWorkspaceSetup: () => void;
  onOpenCanvas: (
    source: DataSource | null,
    expandRect?: { left: number; top: number; width: number; height: number } | null,
  ) => void;
  onOpenLlmConfig: () => void;
  dataConnectionVersion?: number;
  workspaceResetToken?: number;
  currentCanvasWorkId?: string | null;
}) {
  const { selectedId: modelId } = useModels();
  const workspaceMode = props.mode === "workspace";
  const [sources, setSources] = useState<DataSource[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [canvasPrefillDraft, setCanvasPrefillDraft] = useState<{ text: string; token: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [sourceMismatch, setSourceMismatch] = useState<SourceMismatch | null>(null);
  const [highlight, setHighlight] = useState(false);
  const [busy, setBusy] = useState(false);
  const startControllerRef = useRef<AbortController | null>(null);
  const miniCanvasRef = useRef<HTMLDivElement | null>(null);
  const selectedSource = sources.find((source) => source.id === selectedSourceId && source.ready) ?? null;
  const activeConversation = props.conversations.find((conversation) => conversation.id === props.activeId) ?? null;
  const workspaceConversations = props.conversations.filter((conversation) => conversation.mode === "workspace");
  const miniCanvasConversations = workspaceConversations.filter(
    (conversation) => props.currentCanvasWorkId && conversation.canvasWorkId === props.currentCanvasWorkId,
  );
  const connectedSourceIds = new Set(sources.filter((source) => source.ready).map((source) => source.id));
  const visibleTasks = tasks.filter((task) => connectedSourceIds.has(task.source_id));
  const taskDatabases = Array.from(new Set(visibleTasks.map((task) => task.database))).sort((a, b) => a.localeCompare(b));
  const workspaceActiveId =
    props.activeId && miniCanvasConversations.some((conversation) => conversation.id === props.activeId)
      ? props.activeId
      : miniCanvasConversations[0]?.id ?? null;

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

  function isDemoGroupId(id: string): id is DemoGroupId {
    return id === "bird" || id === "bird_interact_a";
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
            mode: props.mode,
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

  async function sourceForMiniCanvasQuery(
    query: string,
    branchTarget?: BranchTarget | null,
    parentContext?: string,
    canvasTone?: CanvasToneId,
  ): Promise<{ source: DataSource; mismatch: SourceMismatch | null }> {
    let resolved: Awaited<ReturnType<typeof bff.resolveDataSource>>;
    try {
      resolved = await bff.resolveDataSource(query, modelId);
    } catch (error) {
      if (selectedSource) {
        return { source: selectedSource, mismatch: null };
      }
      throw new Error(AUTO_MATCH_MANUAL_SELECT_HINT);
    }
    if (selectedSource && resolved.source.id !== selectedSource.id) {
      return {
        source: selectedSource,
        mismatch: {
          query,
          mode: "workspace",
          selectedSource,
          suggestedSource: resolved.source,
          reason: resolved.reason,
          branchTarget: branchTarget ?? null,
          parentContext,
          canvasTone,
          preserveView: true,
        },
      };
    }
    return { source: selectedSource ?? resolved.source, mismatch: null };
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
      await startWithSource(source, query, props.mode, controller.signal);
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

  function openCanvasMode(expandRect?: { left: number; top: number; width: number; height: number } | null) {
    props.onOpenCanvas(selectedSource, expandRect);
  }

  async function startMiniCanvasThread(
    _database: string,
    query: string,
    branchTarget?: BranchTarget | null,
    canvasTone?: CanvasToneId,
  ): Promise<boolean> {
    if (!modelId) {
      setHint("Please set up a model first from LLM Configure");
      return false;
    }
    if (!sources.some((source) => source.ready)) {
      setHint("Connect data before asking a question");
      if (sources.length > 0) {
        setHighlight(true);
        setTimeout(() => setHighlight(false), 1500);
      }
      return false;
    }
    setHint("Starting...");
    try {
      const parentContext = buildBranchParentContext(props.conversations, branchTarget);
      const parentConversation = branchTarget
        ? props.conversations.find((conversation) => conversation.id === branchTarget.parentThreadId)
        : null;
      const lockedSource = parentConversation?.source ?? null;
      if (lockedSource) {
        await startWithSource(lockedSource, query, "workspace", undefined, branchTarget ?? null, parentContext, {
          preserveView: true,
          canvasTone,
        });
        setHint(null);
        return true;
      }
      const { source, mismatch } = await sourceForMiniCanvasQuery(query, branchTarget, parentContext, canvasTone);
      if (mismatch) {
        setSourceMismatch(mismatch);
        setHint("Confirm the data source suggestion before sending this question.");
        return false;
      }
      await startWithSource(source, query, "workspace", undefined, branchTarget ?? null, parentContext, {
        preserveView: true,
        canvasTone,
      });
      setHint(null);
      return true;
    } catch (error) {
      setHint(errorMessage(error));
      return false;
    }
  }

  function handleExpandCanvas() {
    const rect = miniCanvasRef.current?.getBoundingClientRect();
    if (!rect) {
      openCanvasMode();
      return;
    }
    openCanvasMode({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }

  function renderEmbeddedCanvas() {
    return (
      <>
        <CanvasPage
          conversations={workspaceConversations}
          canvasDb={selectedSource?.display_name ?? selectedSource?.database ?? "Canvas"}
          activeId={workspaceActiveId}
          onStart={startMiniCanvasThread}
          onAnswer={props.onAnswer}
          onStop={props.onStop}
          onDeleteConversation={props.onDeleteConversation}
          onNewFlow={props.onNewFlow}
          onStartOverWorkspace={props.onStartOverWorkspace}
          workspaceResetToken={props.workspaceResetToken}
          embedded
          hideModeSwitch
          onExpandCanvas={handleExpandCanvas}
          onConnectData={props.onOpenWorkspaceSetup}
          onOpenLlmConfig={props.onOpenLlmConfig}
          hasDataSource={sources.some((source) => source.ready)}
          dataSources={sources}
          selectedDataSourceId={selectedSourceId}
          prefillDraft={canvasPrefillDraft}
          onSelectDataSource={selectSource}
          onSelectAutoDataSource={selectAutoSource}
          sourceMismatch={
            sourceMismatch
              ? {
                  selectedName: sourceMismatch.selectedSource.display_name,
                  suggestedName: sourceMismatch.suggestedSource.display_name,
                  reason: sourceMismatch.reason,
                }
              : null
          }
          onUseSuggestedDataSource={() => void startPendingMismatch(sourceMismatch!.suggestedSource)}
          onConfirmSelectedDataSource={() => void startPendingMismatch(sourceMismatch!.selectedSource)}
          onDisconnectDataGroup={(groupId) => {
            if (isDemoGroupId(groupId)) void handleDisconnectDemoGroup(groupId);
          }}
        />
        {hint && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-full border border-accent/30 bg-card/95 px-4 py-2 text-[13px] font-medium text-muted shadow-[0_14px_36px_rgba(15,23,42,0.12)]">
            {hint}
          </div>
        )}
      </>
    );
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
      <main
        className={cn(
          "flex min-w-0 flex-1 flex-col overflow-y-auto px-6 sm:px-8 lg:px-12",
          workspaceMode ? "py-4" : "py-6",
        )}
      >
        <div className="-ml-3 flex justify-start sm:-ml-4">
          <FlowModeSwitch
            mode={props.mode}
            onModeChange={props.onModeChange}
          />
        </div>
        <div
          className={cn(
            "mx-auto flex w-full flex-col transition-all duration-300 ease-out",
            workspaceMode ? "max-w-none pt-1" : "max-w-5xl pt-14 sm:pt-20",
          )}
        >
          <div className={cn("transition-all duration-300 ease-out", workspaceMode ? "mb-4" : "mb-12")}>
            <HomeHero variant={workspaceMode ? "top" : "default"} />
          </div>
          <div
            className={cn(
              "mx-auto w-full space-y-5 transition-all duration-300 ease-out",
              workspaceMode ? "max-w-none" : "max-w-4xl",
            )}
          >
            {workspaceMode ? (
              <>
                <div
                  ref={miniCanvasRef}
                  className="mini-canvas-surface-enter relative h-[min(620px,calc(100vh-286px))] min-h-[430px] overflow-hidden rounded-[28px] shadow-[0_24px_80px_rgba(24,32,28,0.08)]"
                >
                  {renderEmbeddedCanvas()}
                </div>
                {visibleTasks.length > 0 && (
                  <div className="px-3 pt-2">
                    <QuestionCards
                      tasks={visibleTasks}
                      onPick={(t) => {
                        setCanvasPrefillDraft({ text: t.amb_user_query, token: Date.now() });
                      }}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="relative w-full">
                <HomeComposer
                  value={draft}
                  onChange={setDraft}
                  onSend={handleSend}
                  onStop={handlePauseStart}
                  onOpenDataSetup={props.onOpenWorkspaceSetup}
                  mode={props.mode}
                  onModeChange={props.onModeChange}
                  onExpandCanvas={handleExpandCanvas}
                  busy={busy}
                  hasDataSource={sources.some((source) => source.ready)}
                  hint={hint}
                  onOpenLlmConfig={props.onOpenLlmConfig}
                />
              </div>
            )}
            {!workspaceMode && sources.length > 0 && (
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
          {!workspaceMode && (
            <div className="mt-20 transition-all duration-300 ease-out">
              <QuestionCards
                tasks={visibleTasks}
                onPick={(t) => {
                  setDraft(t.amb_user_query);
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
