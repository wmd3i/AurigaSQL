import { useEffect, useReducer, useRef, useState } from "react";
import { HomePage } from "./components/home/HomePage";
import { WorkspaceSetupPage } from "./components/workspace/WorkspaceSetupPage";
import { CanvasPage } from "./components/canvas/CanvasPage";
import { AgentResultPage } from "./components/result/AgentResultPage";
import { LlmConfigModal } from "./components/settings/LlmConfigModal";
import { DataConnectionModal } from "./components/home/DataConnectionModal";
import { reducer } from "./state/reducer";
import { initialState, type QueryMode } from "./state/types";
import { useChat } from "./state/useChat";
import { bff, type DemoGroupId, type DataSource, type ModelInfo } from "./api/bff";
import { ModelContext } from "./state/modelContext";
import { loadAppState, saveAppState } from "./state/persistence";
import { buildNodes, type ThreadNode } from "./lib/buildNodes";
import { cn } from "./lib/cn";
import type { Conversation } from "./state/types";
import type { BranchTarget } from "./components/canvas/CanvasComposer";
import type { CanvasToneId } from "./lib/canvasTones";

const BRANCH_FIELD_LIMIT = 2400;
const BRANCH_CONTEXT_LIMIT = 14000;
const CANVAS_TRANSITION_MS = 520;
const CANVAS_EXPAND_MOUNT_DELAY_MS = 650;
const CANVAS_EXPAND_HIDE_DELAY_MS = 920;
type CanvasTransitionPhase = "enter" | "exit" | null;
type CanvasExpandRect = { left: number; top: number; width: number; height: number };
type CanvasSourceMismatch = {
  query: string;
  branchTarget: BranchTarget | null;
  parentContext?: string;
  canvasTone?: CanvasToneId;
  selectedSource: DataSource;
  suggestedSource: DataSource;
  reason: string;
};

function createCanvasWorkId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `canvas_${crypto.randomUUID()}`;
  }
  return `canvas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function canvasWorkIdForConversation(conversations: Conversation[], conv: Conversation): string {
  if (conv.canvasWorkId) return conv.canvasWorkId;
  const byId = new Map(conversations.map((item) => [item.id, item]));
  let current: Conversation | undefined = conv;
  const seen = new Set<string>();
  while (current?.parentThreadId && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentThreadId);
  }
  return current?.id ?? conv.id;
}

function canvasWorkIdForStart(
  conversations: Conversation[],
  currentCanvasWorkId: string | null,
  branchTarget?: BranchTarget | null,
) {
  if (branchTarget) {
    const parent = conversations.find((conversation) => conversation.id === branchTarget.parentThreadId);
    return parent ? canvasWorkIdForConversation(conversations, parent) : branchTarget.parentThreadId;
  }
  return currentCanvasWorkId ?? createCanvasWorkId();
}

function compactForBranchContext(text: string, limit = BRANCH_FIELD_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n...[truncated for branch context]`;
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

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, loadAppState);
  const chat = useChat(dispatch);
  const [workspaceSource, setWorkspaceSource] = useState<DataSource | null>(null);
  const [workspaceSources, setWorkspaceSources] = useState<DataSource[]>([]);
  const [canvasSourceMismatch, setCanvasSourceMismatch] = useState<CanvasSourceMismatch | null>(null);
  const [canvasTransitionPhase, setCanvasTransitionPhase] = useState<CanvasTransitionPhase>(null);
  const [canvasExpandRect, setCanvasExpandRect] = useState<CanvasExpandRect | null>(null);
  const [canvasExpandFull, setCanvasExpandFull] = useState(false);
  const [workspaceResetToken, setWorkspaceResetToken] = useState(0);
  const canvasTransitionTimeoutRef = useRef<number | null>(null);
  const canvasExpandFrameRef = useRef<number | null>(null);
  const canvasExpandTimeoutRef = useRef<number | null>(null);
  const canvasExpandMountTimeoutRef = useRef<number | null>(null);

  // App-wide model selection (shared by the home picker + canvas/result bylines).
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [llmConfigOpen, setLlmConfigOpen] = useState(false);
  const [dataConnectionOpen, setDataConnectionOpen] = useState(false);
  const [dataConnectionVersion, setDataConnectionVersion] = useState(0);

  async function refreshModels(preferredModelId?: string) {
    const r = await bff.models();
    setModels(r.models);
    setModelId((prev) => {
      if (preferredModelId && r.models.some((m) => m.id === preferredModelId && m.available)) {
        return preferredModelId;
      }
      const stillValid = prev && r.models.some((m) => m.id === prev && m.available);
      if (stillValid) return prev;
      const defaultModel = r.default && r.models.some((m) => m.id === r.default && m.available) ? r.default : "";
      return defaultModel || r.models.find((m) => m.available)?.id || "";
    });
  }

  useEffect(() => {
    refreshModels().catch(() => {}); // picker just shows the fallback label if /models is unreachable
  }, []);

  async function refreshWorkspaceSources() {
    const response = await bff.dataSources();
    setWorkspaceSources(response.sources);
    setWorkspaceSource((current) => {
      if (!current) return null;
      return response.sources.find((source) => source.id === current.id && source.ready) ?? null;
    });
    return response.sources;
  }

  useEffect(() => {
    refreshWorkspaceSources().catch(() => {});
  }, [dataConnectionVersion]);

  const connectedSidebarSources = workspaceSources;

  useEffect(() => {
    return () => {
      if (canvasTransitionTimeoutRef.current !== null) window.clearTimeout(canvasTransitionTimeoutRef.current);
      if (canvasExpandTimeoutRef.current !== null) window.clearTimeout(canvasExpandTimeoutRef.current);
      if (canvasExpandMountTimeoutRef.current !== null) window.clearTimeout(canvasExpandMountTimeoutRef.current);
      if (canvasExpandFrameRef.current !== null) window.cancelAnimationFrame(canvasExpandFrameRef.current);
    };
  }, []);

  useEffect(() => {
    saveAppState(state);
  }, [state]);

  useEffect(() => {
    state.conversations
      .filter(
        (conversation) =>
          !conversation.id.startsWith("local_") &&
          (conversation.status === "starting" ||
            conversation.status === "active" ||
            conversation.status === "waiting_user"),
      )
      .forEach((conversation) => chat.subscribe(conversation.id));
  }, [chat.subscribe, state.conversations]);

  const activeConversation = state.conversations.find((c) => c.id === state.activeId) ?? null;
  const canvasConversations =
    state.canvasScope === "active"
      ? activeConversation
        ? [activeConversation]
        : []
      : state.conversations.filter(
          (conversation) =>
            conversation.mode === "workspace" &&
            state.currentCanvasWorkId &&
            canvasWorkIdForConversation(state.conversations, conversation) === state.currentCanvasWorkId,
        );

  // Both modes start a real agent thread immediately; canvas mode simply opens
  // that thread on the canvas instead of the answer-first result page.
  const onStart = (
    source: DataSource,
    query: string,
    mode: QueryMode,
    signal?: AbortSignal,
    branchTarget?: BranchTarget | null,
    parentContext?: string,
    options?: { preserveView?: boolean; canvasTone?: CanvasToneId },
  ) =>
    {
      const canvasWorkId =
        mode === "workspace"
          ? canvasWorkIdForStart(state.conversations, state.currentCanvasWorkId, branchTarget)
          : null;
      return chat.startConversation(
        source,
        query,
        mode,
        modelId,
        branchTarget ? { ...branchTarget, parentContext } : null,
        mode === "workspace" ? (branchTarget ? "all" : "active") : undefined,
        signal,
        { ...options, canvasWorkId },
      );
    };

  const onDeleteConversation = (id: string) => {
    void chat.deleteConversation(id);
  };

  const clearCanvasTransitionTimer = () => {
    if (canvasTransitionTimeoutRef.current !== null) {
      window.clearTimeout(canvasTransitionTimeoutRef.current);
      canvasTransitionTimeoutRef.current = null;
    }
  };

  const clearCanvasExpandTimers = () => {
    if (canvasExpandTimeoutRef.current !== null) {
      window.clearTimeout(canvasExpandTimeoutRef.current);
      canvasExpandTimeoutRef.current = null;
    }
    if (canvasExpandMountTimeoutRef.current !== null) {
      window.clearTimeout(canvasExpandMountTimeoutRef.current);
      canvasExpandMountTimeoutRef.current = null;
    }
    if (canvasExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(canvasExpandFrameRef.current);
      canvasExpandFrameRef.current = null;
    }
  };

  const showWorkspaceCanvas = (source: DataSource | null, preserveActiveThread = false) => {
    clearCanvasTransitionTimer();
    setCanvasTransitionPhase("enter");
    setWorkspaceSource(source);
    dispatch({ type: "OPEN_WORKSPACE", database: source?.display_name ?? "Canvas", preserveActiveThread });
    canvasTransitionTimeoutRef.current = window.setTimeout(() => {
      setCanvasTransitionPhase(null);
      canvasTransitionTimeoutRef.current = null;
    }, CANVAS_TRANSITION_MS + 80);
  };

  const openWorkspace = (source: DataSource | null, expandRect?: CanvasExpandRect | null) => {
    clearCanvasTransitionTimer();
    clearCanvasExpandTimers();
    setWorkspaceSource(source);

    if (!expandRect) {
      setCanvasExpandRect(null);
      setCanvasExpandFull(false);
      showWorkspaceCanvas(source);
      return;
    }

    setCanvasExpandRect(expandRect);
    setCanvasExpandFull(false);
    canvasExpandFrameRef.current = window.requestAnimationFrame(() => {
      canvasExpandFrameRef.current = null;
      setCanvasExpandFull(true);
    });

    canvasExpandMountTimeoutRef.current = window.setTimeout(() => {
      canvasExpandMountTimeoutRef.current = null;
      showWorkspaceCanvas(source, true);
    }, CANVAS_EXPAND_MOUNT_DELAY_MS);

    canvasExpandTimeoutRef.current = window.setTimeout(() => {
      canvasExpandTimeoutRef.current = null;
      setCanvasExpandRect(null);
      setCanvasExpandFull(false);
    }, CANVAS_EXPAND_HIDE_DELAY_MS);
  };

  const collapseWorkspaceCanvas = () => {
    clearCanvasTransitionTimer();
    clearCanvasExpandTimers();
    setCanvasExpandRect(null);
    setCanvasExpandFull(false);
    setCanvasTransitionPhase("exit");
    canvasTransitionTimeoutRef.current = window.setTimeout(() => {
      dispatch({ type: "SET_ENTRY_MODE", mode: "workspace" });
      dispatch({ type: "SET_VIEW", view: "home" });
      setCanvasTransitionPhase(null);
      canvasTransitionTimeoutRef.current = null;
    }, CANVAS_TRANSITION_MS - 40);
  };

  const startOverWorkspace = (view: "home" | "canvas" = "home") => {
    setWorkspaceResetToken((token) => token + 1);
    dispatch({ type: "START_OVER_WORKSPACE", view, canvasWorkId: createCanvasWorkId() });
  };

  const openWorkspaceSetup = () => {
    setDataConnectionOpen(true);
  };

  const handleDataConnectionChanged = async (source?: DataSource) => {
    if (source?.ready) {
      setWorkspaceSource(source);
    } else if (!workspaceSource) {
      try {
        await refreshWorkspaceSources();
      } catch {
        // Home and the modal surface the backend error; this fallback is best effort.
      }
    }
    setDataConnectionVersion((version) => version + 1);
  };

  async function resolveWorkspaceSource(query: string): Promise<DataSource> {
    const resolved = await bff.resolveDataSource(query, modelId);
    return resolved.source;
  }

  function startCanvasConversationWithSource(
    source: DataSource,
    query: string,
    branchTarget?: BranchTarget | null,
    parentContext?: string,
    canvasTone?: CanvasToneId,
  ) {
    setCanvasSourceMismatch(null);
    const canvasWorkId = canvasWorkIdForStart(state.conversations, state.currentCanvasWorkId, branchTarget);
    return chat.startConversation(
      source,
      query,
      "workspace",
      modelId,
      branchTarget ? { ...branchTarget, parentContext } : null,
      branchTarget ? "all" : "active",
      undefined,
      { canvasTone, canvasWorkId },
    );
  }

  async function startPendingCanvasMismatch(source: DataSource) {
    if (!canvasSourceMismatch) return;
    setWorkspaceSource(source);
    await startCanvasConversationWithSource(
      source,
      canvasSourceMismatch.query,
      canvasSourceMismatch.branchTarget,
      canvasSourceMismatch.parentContext,
      canvasSourceMismatch.canvasTone,
    );
  }

  async function handleDisconnectWorkspaceDataGroup(groupId: string) {
    if (groupId !== "bird" && groupId !== "bird_interact_a") return;
    await bff.disconnectDemoGroup(groupId as DemoGroupId);
    await refreshWorkspaceSources();
    setDataConnectionVersion((version) => version + 1);
  }

  let content: React.ReactNode;
  if (state.view === "result" && activeConversation) {
    content = (
      <AgentResultPage
        conversation={activeConversation}
        conversations={state.conversations}
        onShowProcess={() => dispatch({ type: "SET_VIEW", view: "canvas", canvasScope: "active" })}
        onNewFlow={() => dispatch({ type: "NEW_FLOW" })}
        onOpen={(id) => dispatch({ type: "OPEN_CONVERSATION", id })}
        onDeleteConversation={onDeleteConversation}
        onRevertConversation={chat.revertConversationToNode}
        onOpenWorkspaceSetup={openWorkspaceSetup}
        onAnswer={chat.answerPending}
        onFollowUp={(_database, query) =>
          Promise.resolve(chat.sendMessage(activeConversation.id, query, modelId))
        }
        onStop={chat.cancel}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
        dataSources={connectedSidebarSources}
      />
    );
  } else if (state.view === "workspace_setup") {
    content = (
      <WorkspaceSetupPage
        conversations={state.conversations}
        onNewFlow={() => dispatch({ type: "NEW_FLOW" })}
        onBack={() => dispatch({ type: "SET_VIEW", view: "home" })}
        onOpen={(id) => dispatch({ type: "OPEN_CONVERSATION", id })}
        onDeleteConversation={onDeleteConversation}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
      />
    );
  } else if (state.view === "canvas" && state.canvasDb) {
    content = (
      <CanvasPage
        conversations={canvasConversations}
        canvasDb={state.canvasDb}
        activeId={state.activeId}
        onDeleteConversation={onDeleteConversation}
        onRevertConversation={chat.revertConversationToNode}
        backToResult={
          activeConversation?.mode === "agent"
            ? () => dispatch({ type: "SET_VIEW", view: "result" })
            : undefined
        }
        onStart={(database, query, branchTarget, canvasTone) => {
          const parentContext = buildBranchParentContext(state.conversations, branchTarget);
          const parentConversation = branchTarget
            ? state.conversations.find((conversation) => conversation.id === branchTarget.parentThreadId)
            : null;
          const lockedSource = parentConversation?.source ?? activeConversation?.source ?? null;
          if (lockedSource) return startCanvasConversationWithSource(lockedSource, query, branchTarget, parentContext, canvasTone);
          if (workspaceSource) {
            return bff.resolveDataSource(query, modelId).then((resolved) => {
              if (resolved.source.id !== workspaceSource.id) {
                setCanvasSourceMismatch({
                  query,
                  branchTarget: branchTarget ?? null,
                  parentContext,
                  canvasTone,
                  selectedSource: workspaceSource,
                  suggestedSource: resolved.source,
                  reason: resolved.reason,
                });
                return;
              }
              return startCanvasConversationWithSource(workspaceSource, query, branchTarget, parentContext, canvasTone);
            });
          }
          if (!workspaceSources.some((item) => item.ready)) {
            return Promise.reject(new Error("Connect data before asking a question."));
          }
          return resolveWorkspaceSource(query).then((source) =>
            startCanvasConversationWithSource(source, query, branchTarget, parentContext, canvasTone),
          );
        }}
        onAnswer={chat.answerPending}
        onStop={chat.cancel}
        onNewFlow={() => dispatch({ type: "NEW_FLOW" })}
        onStartOverWorkspace={() => startOverWorkspace("canvas")}
        workspaceResetToken={workspaceResetToken}
        transitionPhase={canvasTransitionPhase}
        onCollapseCanvas={collapseWorkspaceCanvas}
        onConnectData={openWorkspaceSetup}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
        hasDataSource={Boolean(activeConversation?.source ?? workspaceSource) || connectedSidebarSources.some((source) => source.ready)}
        dataSources={connectedSidebarSources}
        selectedDataSourceId={workspaceSource?.id ?? null}
        onSelectDataSource={(source) => {
          setWorkspaceSource(source);
          setCanvasSourceMismatch(null);
        }}
        onSelectAutoDataSource={() => {
          setWorkspaceSource(null);
          setCanvasSourceMismatch(null);
        }}
        sourceMismatch={
          canvasSourceMismatch
            ? {
                selectedName: canvasSourceMismatch.selectedSource.display_name,
                suggestedName: canvasSourceMismatch.suggestedSource.display_name,
                reason: canvasSourceMismatch.reason,
              }
            : null
        }
        onUseSuggestedDataSource={() => void startPendingCanvasMismatch(canvasSourceMismatch!.suggestedSource)}
        onConfirmSelectedDataSource={() => void startPendingCanvasMismatch(canvasSourceMismatch!.selectedSource)}
        onDisconnectDataGroup={handleDisconnectWorkspaceDataGroup}
      />
    );
  } else {
    content = (
      <HomePage
        conversations={state.conversations}
        activeId={state.activeId}
        onNewFlow={() => dispatch({ type: "NEW_FLOW" })}
        onStartOverWorkspace={() => startOverWorkspace("home")}
        workspaceResetToken={workspaceResetToken}
        currentCanvasWorkId={state.currentCanvasWorkId}
        onOpen={(id) => dispatch({ type: "OPEN_CONVERSATION", id })}
        onDeleteConversation={onDeleteConversation}
        onStart={onStart}
        onAnswer={chat.answerPending}
        onStop={chat.cancel}
        mode={state.entryMode}
        onModeChange={(mode) => dispatch({ type: "SET_ENTRY_MODE", mode })}
        onOpenWorkspaceSetup={openWorkspaceSetup}
        onOpenCanvas={openWorkspace}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
        dataConnectionVersion={dataConnectionVersion}
      />
    );
  }

  return (
    <ModelContext.Provider value={{ models, selectedId: modelId, setSelectedId: setModelId }}>
      {content}
      <LlmConfigModal
        open={llmConfigOpen}
        onClose={() => setLlmConfigOpen(false)}
        onModelsChanged={refreshModels}
      />
      <DataConnectionModal
        open={dataConnectionOpen}
        onClose={() => setDataConnectionOpen(false)}
        onChanged={handleDataConnectionChanged}
      />
      {canvasExpandRect && (
        <div
          aria-hidden="true"
          className={cn(
            "canvas-expand-card canvas-dot-background pointer-events-none fixed z-[80] overflow-hidden transition-[transform,border-radius,border-color,box-shadow] duration-[620ms] ease-[cubic-bezier(0.2,0.9,0.18,1)] will-change-transform",
            canvasExpandFull && "canvas-expand-card-open",
          )}
          style={{
            left: canvasExpandRect.left,
            top: canvasExpandRect.top,
            width: `${canvasExpandRect.width}px`,
            height: `${canvasExpandRect.height}px`,
            borderRadius: canvasExpandFull ? 0 : 28,
            transform: canvasExpandFull
              ? `translate3d(${-canvasExpandRect.left}px, ${-canvasExpandRect.top}px, 0) scale(${window.innerWidth / canvasExpandRect.width}, ${window.innerHeight / canvasExpandRect.height})`
              : "translate3d(0, 0, 0) scale(1)",
          }}
        >
          <div className="h-full w-full" />
        </div>
      )}
    </ModelContext.Provider>
  );
}
