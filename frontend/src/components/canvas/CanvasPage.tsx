import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Panel,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getViewportForBounds,
  useNodesState,
  useReactFlow,
  useViewport,
  type Edge,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, ChevronsDown, ChevronsUp, Clock3, Database, Home, Maximize2, Minimize2, Pause, Plus, RotateCcw, Scan, Settings2, Sparkles, Unplug } from "lucide-react";
import { CanvasRail } from "./CanvasRail";
import { CanvasInspector } from "./CanvasInspector";
import { CanvasSchemaPanel } from "./CanvasSchemaPanel";
import { FlowModeSwitch } from "../FlowModeSwitch";
import { DialectIcon, dialectLabel } from "../home/DialectIcon";
import { buildNodes } from "../../lib/buildNodes";
import type { ThreadNode } from "../../lib/buildNodes";
import { cardLabel } from "./cardKind";
import { cn } from "../../lib/cn";
import type { DataSource } from "../../api/bff";
import type { Conversation } from "../../state/types";
import { ThreadNodeCard, type CardContent, type CardData, type CardNode } from "./ThreadNodeCard";
import { FloatingDraftNode, type FloatingDraftNodeT } from "./FloatingDraftNode";
import type { BranchTarget } from "./CanvasComposer";
import type { CanvasToneId } from "../../lib/canvasTones";
import { resolveCanvasRowY } from "../../lib/canvasLayout";

const COLUMN_W = 384;
const GAP_Y = 50;
const BRANCH_MIN_X_OFFSET = 500;
const BRANCH_X_PADDING = 180;
const BRANCH_GAP_Y = 36;
const BRANCH_SIBLING_Y = 132;
const MINI_RAIL_W = 56;
const LEFT_PANEL_BASE_X = 96;
const DEFAULT_LEFT_PANEL_W = 520;
const MIN_LEFT_PANEL_W = 320;
const MAX_LEFT_PANEL_W = 760;
const DEFAULT_LEFT_PANEL_H = 390;
const MIN_LEFT_PANEL_H = 260;
const MAX_LEFT_PANEL_H = 980;
const CARD_W = 320;
const FLOATING_DRAFT_W = 360;
const FLOATING_DRAFT_H = 178;
const ANSWER_CARD_W = 560;
const TOOL_GROUP_BUTTON_W = 320;
const TOOL_GROUP_CARD_W = 704;
const TOOL_GROUP_ITEM_H = 44;
const TOOL_GROUP_ITEM_GAP = 8;
const DEFAULT_THREAD_FOCUS = { padding: 0.38, maxZoom: 0.9, upperBias: 0 };
const THREAD_FOCUS = { padding: 0.3, maxZoom: 1, upperBias: 0 };
const NODE_FOCUS = { padding: 0.48, maxZoom: 1, upperBias: 0.18 };
const DEFAULT_FIT_VIEW = { padding: DEFAULT_THREAD_FOCUS.padding, maxZoom: DEFAULT_THREAD_FOCUS.maxZoom };

type CanvasNode = CardNode | FloatingDraftNodeT;
type LeftPanel = "threads" | "schema" | "data" | null;
type BranchDraftKind = "follow_up" | "fork";
type BranchDraft = {
  id: string;
  x: number;
  y: number;
  parentCanvasNodeId: string;
  target: BranchTarget;
  kind: BranchDraftKind;
};
type ResizeEdge =
  | "right"
  | "top"
  | "bottom"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight"
  | null;

const nodeTypes = {
  card: ThreadNodeCard,
  floatingDraft: FloatingDraftNode,
};

const ZOOM_PRESETS = [60, 75, 80, 90, 100, 110, 125, 150];

function canvasWorkKey(conversationsById: Map<string, Conversation>, conv: Conversation) {
  if (conv.canvasWorkId) return conv.canvasWorkId;
  let current: Conversation | undefined = conv;
  const seen = new Set<string>();
  while (current?.parentThreadId && !seen.has(current.id)) {
    seen.add(current.id);
    current = conversationsById.get(current.parentThreadId);
  }
  return current?.id ?? conv.id;
}

function estimateHeight(tn: CardContent): number {
  switch (tn.kind) {
    case "question":
    case "user_answer":
      return 90;
    case "agent_question":
      return tn.answer ? 170 : 120;
    case "agent_text":
      return 140;
    case "thinking":
    case "tool":
    case "working":
      return 56;
    case "tool_group":
      return tn.tools.length * TOOL_GROUP_ITEM_H + Math.max(0, tn.tools.length - 1) * TOOL_GROUP_ITEM_GAP;
    case "error":
      return 100;
    case "answer":
      return 120 + (tn.result !== undefined ? 190 : 0);
  }
}

function cardWidth(tn: CardContent) {
  if (tn.kind === "tool_group") return TOOL_GROUP_CARD_W;
  return tn.kind === "answer" ? ANSWER_CARD_W : CARD_W;
}

function cardAlignWidth(tn: CardContent) {
  if (tn.kind === "tool_group") return TOOL_GROUP_BUTTON_W;
  return cardWidth(tn);
}

function cardPositionForCenter(tn: CardContent, centerX: number) {
  return centerX - cardAlignWidth(tn) / 2;
}

function groupCardContent(nodes: CardContent[]): CardContent {
  if (nodes.length <= 1) return nodes[0]!;
  const tools = nodes.filter((node): node is CardContent & { kind: "tool" } => node.kind === "tool");
  if (tools.length !== nodes.length || tools.length === 0) return nodes[0]!;
  return {
    id: tools[tools.length - 1]!.id,
    kind: "tool_group",
    title: tools[0]!.title ?? "tool",
    tools,
  };
}

function stripSqlFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:sql)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? trimmed).trim();
}

function isRedundantFinalTextNode(node: CardContent, nodes: CardContent[]): boolean {
  if (node.kind !== "agent_text") return false;
  const text = node.body.trim();
  if (!/^```(?:sql)?\s*[\s\S]*```$/i.test(text)) return false;
  const sql = stripSqlFence(text);
  return nodes.some((candidate) => candidate.kind === "answer" && stripSqlFence(candidate.body) === sql);
}

function canvasNodeIdForThreadNode(threadId: string, groups: ThreadGroup[], nodeId: string) {
  const group = groups.find((item) => item.nodes.some((node) => node.id === nodeId));
  if (!group) return `${threadId}:${nodeId}`;
  return `${threadId}:${groupCardContent(group.nodes).id}`;
}

type ThreadGroup = {
  nodes: CardContent[];
};

function buildThreadGroups(nodes: CardContent[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    if (current.kind !== "tool" || !current.title) {
      groups.push({ nodes: [current] });
      continue;
    }
    const run = [current];
    while (i + 1 < nodes.length) {
      const next = nodes[i + 1];
      if (next.kind !== "tool" || next.title !== current.title) break;
      run.push(next);
      i += 1;
    }
    groups.push({ nodes: run });
  }
  return groups;
}

function isCardNode(node: CanvasNode): node is CardNode {
  return node.type === "card";
}

function opensInspector(tn: CardContent) {
  return tn.kind !== "user_answer";
}

function syntheticTail(conv: Conversation): CardContent | null {
  if (conv.status === "error") return { id: "error", kind: "error", body: conv.error ?? "error" };
  const terminal = conv.status === "done" || conv.status === "stopped";
  if (!terminal && conv.turnInFlight && !conv.pendingQuestion) return { id: "working", kind: "working", body: "" };
  return null;
}

function isRunningConversation(conv: Conversation) {
  return conv.status !== "done" && conv.status !== "stopped" && (conv.turnInFlight || conv.status === "starting");
}

function demoGroupLabel(id: string): string {
  if (id === "user_connection") return "My Connections";
  if (id === "bird_interact_a") return "BIRD-Interact (SQLite Edition)";
  if (id === "bird") return "BIRD";
  return id;
}

function CanvasDataSourcePanel(props: {
  sources: DataSource[];
  selectedSourceId: string | null;
  onSelectSource?: (source: DataSource) => void;
  onSelectAutoSource?: () => void;
  sourceMismatch?: {
    selectedName: string;
    suggestedName: string;
    reason: string;
  } | null;
  onUseSuggestedSource?: () => void;
  onConfirmSelectedSource?: () => void;
  onConnectData?: () => void;
  onDisconnectDataGroup?: (groupId: string) => void;
}) {
  const groups = props.sources.reduce<Record<string, DataSource[]>>((acc, source) => {
    (acc[source.source_group] ??= []).push(source);
    return acc;
  }, {});
  const disconnectableDemoGroupId = Object.keys(groups).find((groupId) => groupId !== "user_connection");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">Data source</p>
          <h2 className="mt-1 text-[16px] font-semibold text-ink">Choose database</h2>
        </div>
        {props.onDisconnectDataGroup && disconnectableDemoGroupId && (
          <button
            type="button"
            onClick={() => props.onDisconnectDataGroup?.(disconnectableDemoGroupId)}
            className="mt-5 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-faint transition hover:bg-danger-soft hover:text-danger"
          >
            <Unplug className="h-3 w-3" />
            Disconnect
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {props.sources.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-canvas/70 px-4 py-5 text-[13px] leading-5 text-muted">
            Connect data to choose a database for this canvas.
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(groups).map(([groupId, sources]) => (
              <section key={groupId}>
                {(Object.keys(groups).length > 1 || groupId !== "bird") && (
                  <div className="mb-2 flex items-center justify-between gap-3 px-1">
                    <div className="text-[11px] font-medium text-muted">
                      {demoGroupLabel(groupId)}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {Object.keys(groups)[0] === groupId && (
                    <button
                      type="button"
                      title="Automatically choose the database for each question"
                      onClick={props.onSelectAutoSource}
                      className={cn(
                        "inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
                        props.selectedSourceId === null
                          ? "border-accent bg-accent-soft text-accent"
                          : "border-line bg-card text-muted hover:bg-hover hover:text-ink",
                      )}
                    >
                      <Sparkles className="h-3 w-3" />
                      <span>Auto</span>
                    </button>
                  )}
                  {sources.map((source) => {
                    const selected = props.selectedSourceId === source.id;
                    return (
                      <button
                        key={source.id}
                        type="button"
                        disabled={!source.ready}
                        title={source.ready ? `${source.display_name} · ${dialectLabel(source.engine)}` : source.reason}
                        onClick={() => props.onSelectSource?.(source)}
                        className={cn(
                          "inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
                          selected
                            ? "border-accent bg-accent-soft text-accent"
                            : source.ready
                              ? "border-line bg-card text-muted hover:bg-hover hover:text-ink"
                              : "cursor-not-allowed border-line/70 bg-card/60 text-faint",
                        )}
                      >
                        <DialectIcon dialect={source.engine} className="h-3 w-3" />
                        <span className="truncate">{source.display_name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
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
        )}
      </div>
      <div className="mt-auto px-4 pb-4 pt-2">
        <button
          type="button"
          onClick={props.onConnectData}
          className="flex h-10 w-full items-center justify-center rounded-full border border-line bg-card text-[13px] font-semibold text-muted transition hover:bg-hover hover:text-ink"
        >
          Connect data
        </button>
      </div>
    </div>
  );
}

function CanvasInner(props: {
  conversations: Conversation[];
  canvasDb: string;
  activeId: string | null;
  onStart: (database: string, query: string, branchTarget?: BranchTarget | null, canvasTone?: CanvasToneId) => Promise<boolean | void>;
  onAnswer: (id: string, text: string) => void;
  onStop: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onRevertConversation?: (id: string, nodeId: string) => void;
  onNewFlow: () => void;
  onStartOverWorkspace?: () => void;
  workspaceResetToken?: number;
  backToResult?: () => void;
  embedded?: boolean;
  hideModeSwitch?: boolean;
  transitionPhase?: "enter" | "exit" | null;
  onExpandCanvas?: () => void;
  onCollapseCanvas?: () => void;
  onConnectData?: () => void;
  onOpenLlmConfig?: () => void;
  hasDataSource?: boolean;
  dataSources?: DataSource[];
  selectedDataSourceId?: string | null;
  prefillDraft?: { text: string; token: number } | null;
  onSelectDataSource?: (source: DataSource) => void;
  onSelectAutoDataSource?: () => void;
  sourceMismatch?: {
    selectedName: string;
    suggestedName: string;
    reason: string;
  } | null;
  onUseSuggestedDataSource?: () => void;
  onConfirmSelectedDataSource?: () => void;
  onDisconnectDataGroup?: (groupId: string) => void;
}) {
  const [nodes, setNodes] = useNodesState<CanvasNode>([]);
  const nodesRef = useRef<CanvasNode[]>([]);
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const initiallyFocusedThreadIdsRef = useRef<Set<string>>(new Set());
  const baseCardPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const manualCardPositionIdsRef = useRef<Set<string>>(new Set());
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(null);
  const [leftPanelLeft, setLeftPanelLeft] = useState(LEFT_PANEL_BASE_X);
  const [leftPanelWidth, setLeftPanelWidth] = useState(DEFAULT_LEFT_PANEL_W);
  const [leftPanelHeight, setLeftPanelHeight] = useState(DEFAULT_LEFT_PANEL_H);
  const [resizeEdge, setResizeEdge] = useState<ResizeEdge>(null);
  const [pendingFloatingSpawn, setPendingFloatingSpawn] = useState<{ x: number; y: number } | null>(null);
  const [floatingThreadPositions, setFloatingThreadPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [floatingDrafts, setFloatingDrafts] = useState<Array<{ id: string; x: number; y: number; initialText?: string; initialTextToken?: number }>>([]);
  const [branchDrafts, setBranchDrafts] = useState<BranchDraft[]>([]);
  const [selectedBranchDraftId, setSelectedBranchDraftId] = useState<string | null>(null);
  const [allCardsExpanded, setAllCardsExpanded] = useState(false);
  const [expandAllToken, setExpandAllToken] = useState(0);
  const [inspectedTool, setInspectedTool] = useState<{ parentId: string; tool: ThreadNode } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [canvasHint, setCanvasHint] = useState<string | null>(null);
  const seededEmptyDraftRef = useRef(false);
  const lastActiveFocusRef = useRef<string | null>(null);
  const lastWorkspaceResetTokenRef = useRef(props.workspaceResetToken);
  const canvasHostRef = useRef<HTMLElement | null>(null);

  const threadNodes = useCallback((conv: Conversation): CardContent[] => {
    const base = buildNodes(conv.timeline, conv.title);
    const tail = syntheticTail(conv);
    const nodes = [...base, ...(tail ? [tail] : [])];
    return nodes.filter((node) => !isRedundantFinalTextNode(node, nodes));
  }, []);

  const columnIndex = useCallback((_conv: Conversation, fallback: number) => fallback, []);

  const [focusThreadId, setFocusThreadId] = useState<string | null>(props.activeId);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    setFocusThreadId(props.activeId);
  }, [props.activeId]);

  useEffect(() => {
    if (lastWorkspaceResetTokenRef.current === props.workspaceResetToken) return;
    lastWorkspaceResetTokenRef.current = props.workspaceResetToken;
    setFocusThreadId(null);
    setPendingFloatingSpawn(null);
    setBranchDrafts([]);
    setSelectedBranchDraftId(null);
    setInspectedTool(null);
    setDetailOpen(false);
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    seededEmptyDraftRef.current = false;
  }, [props.workspaceResetToken, setNodes]);

  const allConversationById = useMemo(
    () => new Map(props.conversations.map((conv) => [conv.id, conv])),
    [props.conversations],
  );

  const focusedConversation = useMemo(
    () => (focusThreadId ? props.conversations.find((c) => c.id === focusThreadId) ?? null : null),
    [props.conversations, focusThreadId],
  );

  const visibleConversations = useMemo(() => {
    if (!focusedConversation) return [];

    const workId = canvasWorkKey(allConversationById, focusedConversation);
    return props.conversations.filter((conv) => canvasWorkKey(allConversationById, conv) === workId);
  }, [allConversationById, focusedConversation, props.conversations]);

  const ordered = useMemo(() => [...visibleConversations].reverse(), [visibleConversations]);

  const activeConv = useMemo(
    () => visibleConversations.find((c) => c.id === focusThreadId) ?? visibleConversations[0] ?? null,
    [visibleConversations, focusThreadId],
  );
  const runningConversation = useMemo(() => {
    if (activeConv && isRunningConversation(activeConv)) return activeConv;
    if (props.activeId) {
      const active = visibleConversations.find((conv) => conv.id === props.activeId);
      if (active && isRunningConversation(active)) return active;
    }
    return visibleConversations.find(isRunningConversation) ?? null;
  }, [activeConv, props.activeId, visibleConversations]);

  const selectedNode = useMemo(
    () => (nodes.find((n) => n.selected && n.type === "card") as CardNode | undefined) ?? null,
    [nodes],
  );
  const inspectorNode =
    selectedNode && opensInspector(selectedNode.data.tn)
      ? inspectedTool?.parentId === selectedNode.id
        ? inspectedTool.tool
        : selectedNode.data.tn
      : null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const createDraft = selectedNode?.data.onCreateBranchDraft;
      if (!createDraft) return;
      event.preventDefault();
      createDraft("follow_up");
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedNode]);

  const zoomPercent = Math.round(zoom * 100);
  const zoomOptions = useMemo(
    () => (ZOOM_PRESETS.includes(zoomPercent) ? ZOOM_PRESETS : [...ZOOM_PRESETS, zoomPercent].sort((a, b) => a - b)),
    [zoomPercent],
  );

  useEffect(() => {
    if (!pendingFloatingSpawn) return;
    const floating = visibleConversations.find(
      (conv) =>
        conv.id === props.activeId &&
        conv.mode === "workspace" &&
        conv.parentThreadId === null &&
        conv.parentNodeId === null &&
        !(conv.id in floatingThreadPositions),
    );
    if (!floating) return;

    setFloatingThreadPositions((current) => ({
      ...current,
      [floating.id]: pendingFloatingSpawn,
    }));
    setPendingFloatingSpawn(null);
  }, [floatingThreadPositions, pendingFloatingSpawn, props.activeId, visibleConversations]);

  const isDataPanelOpen = leftPanel === "data";
  const effectiveLeftPanelWidth = props.embedded ? Math.min(leftPanelWidth, 400) : leftPanelWidth;
  const effectiveLeftPanelHeight = props.embedded ? Math.min(leftPanelHeight, 360) : leftPanelHeight;
  const effectiveLeftPanelLeft = props.embedded ? 72 : leftPanelLeft;
  const leftPanelResizable = Boolean(leftPanel);
  const hasCanvasDataSources = (props.dataSources?.length ?? 0) > 0;
  const hasStartableDataSource = props.hasDataSource ?? true;
  const leftChromeWidth = leftPanel ? effectiveLeftPanelWidth + 40 : 0;
  const rightChromeWidth = detailOpen && inspectorNode ? (props.embedded ? 352 : 600) : 0;

  const showConnectDataHint = useCallback(() => {
    setCanvasHint("Connect data before asking a question.");
    if (hasCanvasDataSources) {
      setLeftPanel("data");
    }
    window.setTimeout(() => setCanvasHint(null), 3600);
  }, [hasCanvasDataSources]);

  const startCanvasQuestion = useCallback(
    async (query: string, branchTarget?: BranchTarget | null, canvasTone?: CanvasToneId): Promise<boolean> => {
      if (!hasStartableDataSource) {
        showConnectDataHint();
        return false;
      }
      setCanvasHint(null);
      const started = await props.onStart(props.canvasDb, query, branchTarget ?? null, canvasTone);
      return started !== false;
    },
    [hasStartableDataSource, props.canvasDb, props.onStart, showConnectDataHint],
  );

  useEffect(() => {
    if (!resizeEdge) return;

    const onMove = (event: MouseEvent) => {
      const currentRight = leftPanelLeft + leftPanelWidth;

      const resizeHeightFromCursor = () => {
        const centerY = window.innerHeight / 2;
        const distanceFromCenter = Math.abs(event.clientY - centerY);
        const nextHeight = Math.min(
          MAX_LEFT_PANEL_H,
          Math.max(MIN_LEFT_PANEL_H, distanceFromCenter * 2),
        );
        setLeftPanelHeight(nextHeight);
      };

      const resizeFromRight = () => {
        const nextWidth = Math.min(
          MAX_LEFT_PANEL_W,
          Math.max(MIN_LEFT_PANEL_W, event.clientX - leftPanelLeft),
        );
        setLeftPanelWidth(nextWidth);
      };

      const resizeFromLeft = () => {
        const nextLeft = Math.min(currentRight - MIN_LEFT_PANEL_W, Math.max(88, event.clientX));
        const nextWidth = Math.min(MAX_LEFT_PANEL_W, Math.max(MIN_LEFT_PANEL_W, currentRight - nextLeft));
        setLeftPanelLeft(currentRight - nextWidth);
        setLeftPanelWidth(nextWidth);
      };

      if (resizeEdge === "right") {
        resizeFromRight();
        return;
      }

      if (resizeEdge === "topLeft" || resizeEdge === "bottomLeft") {
        resizeFromLeft();
        resizeHeightFromCursor();
        return;
      }

      if (resizeEdge === "topRight" || resizeEdge === "bottomRight") {
        resizeFromRight();
        resizeHeightFromCursor();
        return;
      }

      resizeHeightFromCursor();
    };

    const onUp = () => setResizeEdge(null);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftPanelLeft, leftPanelWidth, resizeEdge]);

  function getFloatingDraftPosition() {
    const viewport = rf.getViewport();
    const sidebarSpace = leftChromeWidth;
    const hostRect = canvasHostRef.current?.getBoundingClientRect();
    const viewportWidth = hostRect?.width ?? window.innerWidth;
    const viewportHeight = hostRect?.height ?? window.innerHeight;
    const chromePaddingX = props.embedded ? 88 : 120;
    const chromePaddingY = props.embedded ? 88 : 120;
    const visibleWidth = Math.max(420, viewportWidth - sidebarSpace - rightChromeWidth - chromePaddingX);
    const visibleHeight = Math.max(320, viewportHeight - chromePaddingY);
    const visibleLeftScreen = sidebarSpace + chromePaddingX / 2;
    const visibleTopScreen = chromePaddingY / 2;
    const cardWidth = FLOATING_DRAFT_W;
    const cardHeight = FLOATING_DRAFT_H;
    const centerX = (visibleLeftScreen + visibleWidth / 2 - viewport.x) / viewport.zoom - cardWidth / 2;
    const upperCenterY = (visibleTopScreen + visibleHeight * 0.18 - viewport.y) / viewport.zoom - cardHeight / 2;
    const occupied = floatingDrafts.length + Object.keys(floatingThreadPositions).length;
    const cascadeOffset = Math.min(occupied, 4) * 18;
    return {
      x: centerX + cascadeOffset,
      y: upperCenterY + cascadeOffset,
    };
  }

  function addFloatingDraft() {
    const pos = getFloatingDraftPosition();
    setFloatingDrafts((current) => [
      ...current,
      { id: `draft-thread:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, ...pos },
    ]);
  }

  useEffect(() => {
    const text = props.prefillDraft?.text.trim();
    const token = props.prefillDraft?.token;
    if (!text) return;
    let selectedDraftId: string | null = null;
    setFloatingDrafts((current) => {
      const target = current[0];
      if (target) {
        selectedDraftId = target.id;
        return [
          { ...target, initialText: text, initialTextToken: token },
          ...current.slice(1),
        ];
      }
      const pos = getFloatingDraftPosition();
      const id = `draft-thread:sample:${Date.now()}`;
      selectedDraftId = id;
      seededEmptyDraftRef.current = true;
      return [{ id, ...pos, initialText: text, initialTextToken: token }];
    });
    window.setTimeout(() => {
      if (!selectedDraftId) return;
      setNodes((current) =>
        current.map((node) => ({
          ...node,
          selected: node.id === selectedDraftId,
        })),
      );
    }, 0);
  }, [props.prefillDraft?.token, setNodes]);

  const addBranchDraft = useCallback(
    (parentCanvasNodeId: string, target: BranchTarget, kind: BranchDraftKind) => {
      const parentNode = nodesRef.current.find((node) => node.id === parentCanvasNodeId && node.type === "card") as CardNode | undefined;
      if (!parentNode) return;
      const parentWidth = cardWidth(parentNode.data.tn);
      const parentHeight = nodeHeights[parentCanvasNodeId] ?? estimateHeight(parentNode.data.tn);
      const draftId = `branch-draft:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const x =
        kind === "fork"
          ? parentNode.position.x + Math.max(BRANCH_MIN_X_OFFSET, parentWidth + BRANCH_X_PADDING)
          : parentNode.position.x + parentWidth / 2 - FLOATING_DRAFT_W / 2;
      const y =
        kind === "fork"
          ? parentNode.position.y
          : parentNode.position.y + parentHeight + 94;

      setBranchDrafts((current) => [
        ...current.filter((draft) => !(draft.parentCanvasNodeId === parentCanvasNodeId && draft.kind === kind)),
        { id: draftId, x, y, parentCanvasNodeId, target, kind },
      ]);
      setSelectedBranchDraftId(draftId);
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === draftId })));
    },
    [nodeHeights, setNodes],
  );

  const emptyWorkspace = visibleConversations.length === 0;

  useEffect(() => {
    if (!emptyWorkspace) {
      seededEmptyDraftRef.current = false;
      return;
    }
    setBranchDrafts([]);
    setSelectedBranchDraftId(null);
    setInspectedTool(null);
    setDetailOpen(false);
    if (seededEmptyDraftRef.current || floatingDrafts.length > 0) return;
    seededEmptyDraftRef.current = true;
    const pos = getFloatingDraftPosition();
    setFloatingDrafts([{ id: `draft-thread:initial:${Date.now()}`, ...pos }]);
  }, [emptyWorkspace, floatingDrafts.length]);

  function toggleAllCardsExpanded() {
    setAllCardsExpanded((current) => !current);
    setExpandAllToken((current) => current + 1);
  }

  const branchCounts = useMemo(() => {
    const out = new Map<string, number>();
    visibleConversations.forEach((conv) => {
      if (!conv.parentThreadId || !conv.parentNodeId) return;
      const parent = allConversationById.get(conv.parentThreadId);
      const key = parent
        ? canvasNodeIdForThreadNode(conv.parentThreadId, buildThreadGroups(threadNodes(parent)), conv.parentNodeId)
        : `${conv.parentThreadId}:${conv.parentNodeId}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    });
    return out;
  }, [allConversationById, threadNodes, visibleConversations]);

  const conversationById = useMemo(
    () => new Map(visibleConversations.map((conv) => [conv.id, conv])),
    [visibleConversations],
  );

  const childThreadsByAnchor = useMemo(() => {
    const out = new Map<string, string[]>();
    visibleConversations.forEach((conv) => {
      if (!conv.parentThreadId || !conv.parentNodeId) return;
      const parent = allConversationById.get(conv.parentThreadId);
      const key = parent
        ? canvasNodeIdForThreadNode(conv.parentThreadId, buildThreadGroups(threadNodes(parent)), conv.parentNodeId)
        : `${conv.parentThreadId}:${conv.parentNodeId}`;
      out.set(key, [...(out.get(key) ?? []), conv.id]);
    });
    return out;
  }, [allConversationById, threadNodes, visibleConversations]);

  const collectFollowerCardIds = useCallback(
    (canvasNodeId: string) => {
      const [threadId, nodeId] = canvasNodeId.split(":");
      const conv = conversationById.get(threadId);
      if (!conv || !nodeId) return new Set<string>();

      const thread = threadNodes(conv);
      const startIndex = thread.findIndex((node) => canvasNodeIdForThreadNode(threadId, buildThreadGroups(thread), node.id) === canvasNodeId);
      if (startIndex < 0) return new Set<string>();

      const ids = new Set<string>();

      const collectThreadTree = (targetThreadId: string) => {
        const targetConv = conversationById.get(targetThreadId);
        if (!targetConv) return;
        threadNodes(targetConv).forEach((node) => {
          const id = canvasNodeIdForThreadNode(targetThreadId, buildThreadGroups(threadNodes(targetConv)), node.id);
          ids.add(id);
          (childThreadsByAnchor.get(id) ?? []).forEach(collectThreadTree);
        });
      };

      thread.slice(startIndex + 1).forEach((node) => {
        ids.add(canvasNodeIdForThreadNode(threadId, buildThreadGroups(thread), node.id));
      });

      thread.slice(startIndex).forEach((node) => {
        const id = canvasNodeIdForThreadNode(threadId, buildThreadGroups(thread), node.id);
        (childThreadsByAnchor.get(id) ?? []).forEach(collectThreadTree);
      });

      ids.delete(canvasNodeId);
      return ids;
    },
    [childThreadsByAnchor, conversationById, threadNodes],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      changes.forEach((change) => {
        if (change.type !== "position" || !change.position || !change.dragging) return;
        if (change.id.startsWith("draft-thread:") || change.id.startsWith("branch-draft:")) return;
        const node = nodesRef.current.find((item) => item.id === change.id);
        if (node && isCardNode(node)) {
          manualCardPositionIdsRef.current.add(change.id);
        }
      });

      setNodes((current) => {
        const explicitMoves = new Set(
          changes.filter((change) => change.type === "position").map((change) => change.id),
        );
        const followerOffsets = new Map<string, { dx: number; dy: number }>();

        changes.forEach((change) => {
          if (change.type !== "position" || !change.position || !change.dragging) return;
          if (change.id.startsWith("draft-thread:") || change.id.startsWith("branch-draft:")) return;
          const dragged = current.find((node) => node.id === change.id);
          if (!dragged || !isCardNode(dragged)) return;

          const dx = change.position.x - dragged.position.x;
          const dy = change.position.y - dragged.position.y;
          if (dx === 0 && dy === 0) return;

          collectFollowerCardIds(change.id).forEach((id) => {
            if (explicitMoves.has(id)) return;
            const prev = followerOffsets.get(id) ?? { dx: 0, dy: 0 };
            followerOffsets.set(id, { dx: prev.dx + dx, dy: prev.dy + dy });
          });
        });

        const shifted =
          followerOffsets.size === 0
            ? current
            : current.map((node) => {
                const offset = followerOffsets.get(node.id);
                if (!offset) return node;
                return {
                  ...node,
                  position: {
                    x: node.position.x + offset.dx,
                    y: node.position.y + offset.dy,
                  },
                };
              });

        changes.forEach((change) => {
          if (change.type === "position" && change.dragging) return;
          if (change.type === "position" && change.id.startsWith("draft-thread:") && change.position) {
            setFloatingDrafts((currentDrafts) =>
              currentDrafts.map((draft) =>
                draft.id === change.id ? { ...draft, x: change.position!.x, y: change.position!.y } : draft,
              ),
            );
          }
          if (change.type === "position" && change.id.startsWith("branch-draft:") && change.position) {
            setBranchDrafts((currentDrafts) =>
              currentDrafts.map((draft) =>
                draft.id === change.id ? { ...draft, x: change.position!.x, y: change.position!.y } : draft,
              ),
            );
          }
        });
        return applyNodeChanges(
          changes.filter((change) => change.type !== "remove"),
          shifted,
        );
      });
    },
    [collectFollowerCardIds, setNodes],
  );

  const focusCanvasNodes = useCallback(
    (ids: string[], opts?: { padding?: number; minZoom?: number; maxZoom?: number; duration?: number; upperBias?: number }) => {
      if (ids.length === 0) return;
      const bounds = rf.getNodesBounds(ids);
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || (bounds.width === 0 && bounds.height === 0)) {
        return;
      }

      const sidebarSpace = leftChromeWidth;
      const hostRect = canvasHostRef.current?.getBoundingClientRect();
      const viewportWidth = hostRect?.width ?? window.innerWidth;
      const viewportHeight = hostRect?.height ?? window.innerHeight;
      const chromePaddingX = props.embedded ? 88 : 120;
      const chromePaddingY = props.embedded ? 88 : 120;
      const visibleWidth = Math.max(360, viewportWidth - sidebarSpace - rightChromeWidth - chromePaddingX);
      const visibleHeight = Math.max(260, viewportHeight - chromePaddingY);
      const viewport = getViewportForBounds(
        bounds,
        visibleWidth,
        visibleHeight,
        opts?.minZoom ?? 0.2,
        opts?.maxZoom ?? 1.2,
        opts?.padding ?? 0.2,
      );
      const visibleLeftScreen = sidebarSpace + chromePaddingX / 2;
      const desiredX = viewport.x + visibleLeftScreen;
      const minTopInset = props.embedded ? 24 : 40;
      const desiredY = viewport.y - visibleHeight * (opts?.upperBias ?? (props.embedded ? 0 : 0.18));
      const topScreenY = bounds.y * viewport.zoom + desiredY;
      const clampedY = topScreenY < minTopInset ? desiredY + (minTopInset - topScreenY) : desiredY;

      void rf.setViewport(
        {
          ...viewport,
          x: desiredX,
          y: clampedY,
        },
        { duration: opts?.duration ?? 400 },
      );
    },
    [leftChromeWidth, props.embedded, rf, rightChromeWidth],
  );

  const focusedCanvasThreadId = focusThreadId ?? props.activeId ?? null;
  const focusedThreadNodeIds = useMemo(
    () =>
      focusedCanvasThreadId
        ? nodes.filter((n) => n.id.startsWith(`${focusedCanvasThreadId}:`) && n.type === "card").map((n) => n.id)
        : [],
    [focusedCanvasThreadId, nodes],
  );
  const focusedThreadSignature = useMemo(
    () => focusedThreadNodeIds.join("|"),
    [focusedThreadNodeIds],
  );
  const allCardNodeIds = useMemo(
    () => nodes.filter((n) => n.type === "card").map((n) => n.id),
    [nodes],
  );

  const onCardHeightChange = useCallback((id: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    setNodeHeights((current) => {
      if (current[id] === height) return current;
      return { ...current, [id]: height };
    });
  }, []);

  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      const out: CanvasNode[] = [];
      const autoCardPositions = new Map<string, { x: number; y: number }>();

      floatingDrafts.forEach((draft) => {
        out.push({
          id: draft.id,
          type: "floatingDraft",
          position: { x: draft.x, y: draft.y },
          data: {
            onOpenLlmConfig: props.onOpenLlmConfig,
            onClose: () => setFloatingDrafts((currentDrafts) => currentDrafts.filter((item) => item.id !== draft.id)),
            initialText: draft.initialText,
            initialTextToken: draft.initialTextToken,
            onSubmit: async (text: string, toneId: CanvasToneId) => {
              const started = await startCanvasQuestion(text, null, toneId);
              if (!started) return false;
              setPendingFloatingSpawn({ x: draft.x, y: draft.y });
              setFloatingDrafts((currentDrafts) => currentDrafts.filter((item) => item.id !== draft.id));
            },
          },
          selected: byId.get(draft.id)?.selected,
        });
      });

      branchDrafts.forEach((draft) => {
        out.push({
          id: draft.id,
          type: "floatingDraft",
          position: { x: draft.x, y: draft.y },
          data: {
            title: draft.kind === "fork" ? "Fork question" : "Follow-up question",
            placeholder: draft.kind === "fork" ? "Explore a parallel direction..." : "Ask a follow-up from this card...",
            onOpenLlmConfig: props.onOpenLlmConfig,
            onClose: () => {
              setBranchDrafts((currentDrafts) => currentDrafts.filter((item) => item.id !== draft.id));
              setSelectedBranchDraftId((current) => (current === draft.id ? null : current));
            },
            onSubmit: async (text: string, toneId: CanvasToneId) => {
              const started = await startCanvasQuestion(text, { ...draft.target, branchKind: draft.kind }, toneId);
              if (!started) return false;
              setBranchDrafts((currentDrafts) => currentDrafts.filter((item) => item.id !== draft.id));
              setSelectedBranchDraftId((current) => (current === draft.id ? null : current));
            },
          },
          selected: byId.get(draft.id)?.selected ?? selectedBranchDraftId === draft.id,
        });
      });

      ordered.forEach((conv, ci) => {
        const groups = buildThreadGroups(threadNodes(conv));
        if (groups.length === 0) return;

        const parentForCanvasNode = conv.parentThreadId ? allConversationById.get(conv.parentThreadId) : null;
        const parentCanvasNodeId =
          conv.parentThreadId && conv.parentNodeId && parentForCanvasNode
            ? canvasNodeIdForThreadNode(conv.parentThreadId, buildThreadGroups(threadNodes(parentForCanvasNode)), conv.parentNodeId)
            : conv.parentThreadId && conv.parentNodeId
              ? `${conv.parentThreadId}:${conv.parentNodeId}`
              : null;
        const parentCandidate = parentCanvasNodeId ? byId.get(parentCanvasNodeId) : null;
        const parentNode = parentCandidate?.type === "card" ? parentCandidate as CardNode : null;
        const parentAnchorNode =
          parentForCanvasNode && conv.parentNodeId
            ? threadNodes(parentForCanvasNode).find((node) => node.id === conv.parentNodeId) ?? null
            : null;
        const branchOrigin = parentAnchorNode ? { label: cardLabel(parentAnchorNode), kind: conv.canvasBranchKind } : null;
        const siblingCount = parentCanvasNodeId ? branchCounts.get(parentCanvasNodeId) ?? 1 : 0;
        const branchIndex =
          parentCanvasNodeId && siblingCount > 0
            ? ordered
                .filter((c) => {
                  if (!c.parentThreadId || !c.parentNodeId || c.parentThreadId !== conv.parentThreadId) return false;
                  const parent = allConversationById.get(c.parentThreadId);
                  if (!parent) return false;
                  return canvasNodeIdForThreadNode(c.parentThreadId, buildThreadGroups(threadNodes(parent)), c.parentNodeId) === parentCanvasNodeId;
                })
                .findIndex((c) => c.id === conv.id)
            : -1;
        const floatingPosition =
          !parentCanvasNodeId ? floatingThreadPositions[conv.id] : undefined;
        const isFollowUpBranch = conv.canvasBranchKind === "follow_up";
        const parentWidth = parentNode ? cardWidth(parentNode.data.tn) : CARD_W;
        const parentHeight = parentNode
          ? nodeHeights[parentNode.id] ?? estimateHeight(parentNode.data.tn)
          : 0;
        const branchOffsetX = parentNode
          ? Math.max(BRANCH_MIN_X_OFFSET, cardWidth(parentNode.data.tn) + BRANCH_X_PADDING)
          : COLUMN_W;
        const baseY = parentNode
          ? isFollowUpBranch
            ? parentNode.position.y + parentHeight + BRANCH_GAP_Y
            : parentNode.position.y + Math.max(0, branchIndex) * BRANCH_SIBLING_Y
          : floatingPosition?.y ?? 40;
        const baseX = parentNode
          ? isFollowUpBranch
            ? parentNode.position.x + parentWidth / 2 - CARD_W / 2
            : parentNode.position.x + branchOffsetX
          : floatingPosition?.x ?? columnIndex(conv, ci) * COLUMN_W + 40;
        const rowGapY = parentNode ? BRANCH_GAP_Y : GAP_Y;
        let threadCenterX = parentNode
          ? isFollowUpBranch
            ? parentNode.position.x + parentWidth / 2
            : baseX + CARD_W / 2
          : baseX + CARD_W / 2;

        let cursorY = baseY;
        groups.forEach((group, gi) => {
          const lastGroup = gi === groups.length - 1;
          const tn = groupCardContent(group.nodes);
          const id = `${conv.id}:${tn.id}`;
          const rowHeight = nodeHeights[id] ?? estimateHeight(tn);
          const rowX = cardPositionForCenter(tn, threadCenterX);
          const rowY = resolveCanvasRowY(
            cursorY,
            rowHeight,
            rowGapY,
            rowX,
            rowX + cardWidth(tn),
            out.flatMap((node) => {
              if (node.type !== "card") return [];
              const blockerTop = node.position.y;
              return [{
                top: blockerTop,
                bottom: blockerTop + (nodeHeights[node.id] ?? estimateHeight(node.data.tn)),
                left: node.position.x,
                right: node.position.x + cardWidth(node.data.tn),
              }];
            }),
          );

          const existing = byId.get(id);
          const isLast = lastGroup;
          const computedPosition = {
            x: cardPositionForCenter(tn, threadCenterX),
            y: rowY,
          };
          autoCardPositions.set(id, computedPosition);
          const manuallyPositioned = manualCardPositionIdsRef.current.has(id);
          const position = manuallyPositioned && existing ? existing.position : computedPosition;
          const node: CardNode = {
            id,
            type: "card",
            position,
            selected: existing?.selected,
            data: {
              tn,
              pulse: tn.kind === "agent_question" && conv.pendingQuestion !== null && isLast,
              footer: isLast && conv.status === "done" ? { state: "ended" } : null,
              branchOrigin: gi === 0 && branchOrigin ? branchOrigin : undefined,
              canvasTone: gi === 0 && tn.kind === "question" ? conv.canvasTone : undefined,
              onHeightChange: (height) => onCardHeightChange(id, height),
              compact: props.embedded,
              onCreateBranchDraft:
                tn.kind === "tool" || tn.kind === "answer" || tn.kind === "agent_question" || tn.kind === "question"
                  ? (kind) =>
                      addBranchDraft(id, {
                        parentThreadId: conv.id,
                        parentNodeId: tn.id,
                        label: cardLabel(tn),
                        mode:
                          tn.kind === "question" || (tn.kind === "answer" && conv.parentThreadId === null)
                            ? "auto"
                            : "manual",
                        branchKind: kind,
                      }, kind)
                  : undefined,
              onDeleteThread: () => props.onDeleteConversation(conv.id),
              onRevert:
                !props.onRevertConversation || (gi === 0 && tn.kind === "question" && !branchOrigin)
                  ? undefined
                  : () => props.onRevertConversation?.(conv.id, tn.id),
              onBranchTool:
                tn.kind === "tool_group"
                  ? async (tool, prompt) => {
                      await startCanvasQuestion(prompt, {
                        parentThreadId: conv.id,
                        parentNodeId: tool.id,
                        label: cardLabel(tool),
                        mode: "manual",
                      });
                    }
                  : undefined,
              onAnswer:
                tn.kind === "agent_question" && conv.pendingQuestion !== null && isLast
                  ? (text) => props.onAnswer(conv.id, text)
                  : undefined,
              onInspectTool:
                tn.kind === "tool_group"
                  ? (tool, openDetail = false) => {
                      setInspectedTool({ parentId: id, tool });
                      setDetailOpen((open) => openDetail || open);
                      setNodes((current) => current.map((item) => ({ ...item, selected: item.id === id })));
                    }
                  : undefined,
              expandAllToken,
              expandAllOpen: allCardsExpanded,
            } satisfies CardData,
          };
          out.push(node);
          threadCenterX = position.x + cardAlignWidth(tn) / 2;
          cursorY = position.y + rowHeight + rowGapY;
        });
      });

      baseCardPositionsRef.current = new Map(
        [...autoCardPositions.entries()].map(([id, position]) => [id, { ...position }]),
      );

      return out;
    });
  }, [
    branchCounts,
    branchDrafts,
    addBranchDraft,
    columnIndex,
    floatingDrafts,
    floatingThreadPositions,
    nodeHeights,
    onCardHeightChange,
    ordered,
    allCardsExpanded,
    expandAllToken,
    hasStartableDataSource,
    props.embedded,
    selectedBranchDraftId,
    setNodes,
    showConnectDataHint,
    startCanvasQuestion,
    threadNodes,
    visibleConversations,
  ]);

  const edges = useMemo<Edge[]>(() => {
    const es: Edge[] = [];
    const solid = { stroke: "var(--accent)", strokeWidth: 1.5, opacity: 0.55 };
    const dashed = { strokeDasharray: "6 6", stroke: "var(--line)", strokeWidth: 1.5 };

    ordered.forEach((conv) => {
      const groups = buildThreadGroups(threadNodes(conv));
      if (groups.length === 0) return;

      if (conv.parentThreadId && conv.parentNodeId) {
        const parent = allConversationById.get(conv.parentThreadId);
        const sourceId = parent
          ? canvasNodeIdForThreadNode(conv.parentThreadId, buildThreadGroups(threadNodes(parent)), conv.parentNodeId)
          : `${conv.parentThreadId}:${conv.parentNodeId}`;
        const targetNode = groupCardContent(groups[0].nodes);
        es.push({
          id: `e:branch:${conv.parentThreadId}:${conv.parentNodeId}:${conv.id}:${targetNode.id}`,
          source: sourceId,
          target: `${conv.id}:${targetNode.id}`,
          style: solid,
        });
      }

      for (let i = 0; i < groups.length - 1; i++) {
        const sourceNode = groupCardContent(groups[i].nodes);
        const targetNode = groupCardContent(groups[i + 1].nodes);
        es.push({
          id: `${conv.id}:e:${sourceNode.id}:${targetNode.id}`,
          source: `${conv.id}:${sourceNode.id}`,
          target: `${conv.id}:${targetNode.id}`,
          style: dashed,
        });
      }
    });

    branchDrafts.forEach((draft) => {
      es.push({
        id: `e:draft:${draft.parentCanvasNodeId}:${draft.id}`,
        source: draft.parentCanvasNodeId,
        target: draft.id,
        style: draft.kind === "fork" ? solid : dashed,
      });
    });

    return es;
  }, [allConversationById, branchDrafts, ordered, threadNodes]);

  useEffect(() => {
    if (!focusedCanvasThreadId) return;
    if (focusedThreadNodeIds.length === 0) return;
    if (initiallyFocusedThreadIdsRef.current.has(focusedCanvasThreadId)) return;
    initiallyFocusedThreadIdsRef.current.add(focusedCanvasThreadId);
    focusCanvasNodes(focusedThreadNodeIds, { ...DEFAULT_THREAD_FOCUS, duration: 400 });
  }, [focusCanvasNodes, focusedCanvasThreadId, focusedThreadNodeIds]);

  useEffect(() => {
    if (!props.activeId) return;
    if (focusedThreadNodeIds.length === 0) return;
    const activeFocusKey = `${props.activeId}:${focusedThreadSignature}:${rightChromeWidth}`;
    if (lastActiveFocusRef.current === activeFocusKey) return;
    lastActiveFocusRef.current = activeFocusKey;
    focusCanvasNodes(focusedThreadNodeIds, { ...THREAD_FOCUS, duration: 420 });
  }, [focusCanvasNodes, focusedThreadNodeIds, focusedThreadSignature, props.activeId, rightChromeWidth]);

  const onNodeClick: NodeMouseHandler<CanvasNode> = (_, node) => {
    if (node.type !== "card") return;
    setInspectedTool(null);
    setDetailOpen((open) => open && opensInspector(node.data.tn));
    setNodes((current) => current.map((item) => ({ ...item, selected: item.id === node.id })));
  };

  const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = (_, node) => {
    if (node.type !== "card") return;
    setInspectedTool(null);
    setDetailOpen(opensInspector(node.data.tn));
    setNodes((current) => current.map((item) => ({ ...item, selected: item.id === node.id })));
  };

  function focusThread(id: string) {
    setFocusThreadId(id);
    setLeftPanel(null);
    const ids = nodes.filter((n) => n.id.startsWith(`${id}:`)).map((n) => n.id);
    focusCanvasNodes(ids, { ...THREAD_FOCUS, duration: 400 });
  }

  function resetThreadLayout() {
    const basePositions = baseCardPositionsRef.current;
    if (basePositions.size === 0) return;

    manualCardPositionIdsRef.current.clear();
    setNodes((current) =>
      current.map((node) => {
        if (!isCardNode(node)) return node;
        const base = basePositions.get(node.id);
        if (!base) return node;
        return {
          ...node,
          position: { ...base },
        };
      }),
    );

    requestAnimationFrame(() => {
      const fitOpts = props.embedded
        ? { padding: 0.22, minZoom: 0.6, maxZoom: 0.9, upperBias: 0, duration: 320 }
        : { ...THREAD_FOCUS, duration: 320 };
      if (focusedThreadNodeIds.length > 0) {
        focusCanvasNodes(focusedThreadNodeIds, fitOpts);
      } else if (allCardNodeIds.length > 0) {
        void rf.fitView({ nodes: allCardNodeIds.map((id) => ({ id })), duration: 320, ...DEFAULT_FIT_VIEW });
      } else {
        void rf.fitView({ duration: 320, ...DEFAULT_FIT_VIEW });
      }
    });
  }

  function focusNode(canvasId: string) {
    setFocusThreadId(canvasId.split(":")[0]);
    setInspectedTool(null);
    setDetailOpen(true);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === canvasId })));
    focusCanvasNodes([canvasId], { ...NODE_FOCUS, duration: 400 });
  }

  function toggleLeftPanel(panel: Exclude<LeftPanel, null>) {
    setLeftPanel((current) => (current === panel ? null : panel));
  }

  function startLeftPanelResize(edge: Exclude<ResizeEdge, null>) {
    setResizeEdge(edge);
  }

  return (
    <div
      className={cn(
        "relative flex overflow-hidden bg-surface text-ink",
        props.embedded ? "h-full w-full" : "h-screen w-screen",
        !props.embedded && props.transitionPhase === "enter" && "canvas-full-transition-enter",
        !props.embedded && props.transitionPhase === "exit" && "canvas-full-transition-exit",
      )}
    >
      <div className="flex min-h-0 flex-1">
        <main ref={canvasHostRef} className="relative min-w-0 flex-1">
            <div className={cn("pointer-events-none absolute top-1/2 z-20 flex -translate-y-1/2 flex-col items-start", props.embedded ? "left-3" : "left-5")}>
              <div
                className={cn(
                  "pointer-events-auto flex flex-col items-center bg-card/96 shadow-[0_18px_48px_rgba(15,23,42,0.10)] ring-1 ring-line/50",
                  props.embedded ? "rounded-[22px] py-3" : "rounded-[28px] py-4",
                )}
                style={{ width: props.embedded ? 44 : MINI_RAIL_W }}
              >
            <button
              onClick={addFloatingDraft}
              title="New thread"
              aria-label="New thread"
              className={cn(
                "flex items-center justify-center bg-hover text-ink transition-colors hover:bg-card",
                props.embedded ? "h-9 w-9 rounded-[16px]" : "h-11 w-11 rounded-[20px]",
              )}
            >
              <Plus className={props.embedded ? "h-4 w-4" : "h-5 w-5"} />
            </button>
            <button
              onClick={
                hasCanvasDataSources || props.onConnectData
                  ? () => toggleLeftPanel("data")
                  : () => toggleLeftPanel("schema")
              }
              title={hasCanvasDataSources || props.onConnectData ? "Connect data" : "Database graph"}
              aria-label={hasCanvasDataSources || props.onConnectData ? "Connect data" : "Database graph"}
              className={cn(
                "flex items-center justify-center text-muted transition-colors hover:bg-hover hover:text-ink",
                props.embedded ? "mt-2.5 h-9 w-9 rounded-[16px]" : "mt-3 h-11 w-11 rounded-[20px]",
                (((hasCanvasDataSources || props.onConnectData) && leftPanel === "data") || (!hasCanvasDataSources && !props.onConnectData && leftPanel === "schema")) &&
                  "bg-hover text-ink",
              )}
            >
              <Database className={props.embedded ? "h-4 w-4" : "h-5 w-5"} />
            </button>
            <button
              onClick={() => toggleLeftPanel("threads")}
              title="Threads"
              aria-label="Threads"
              className={cn(
                "flex items-center justify-center text-muted transition-colors hover:bg-hover hover:text-ink",
                props.embedded ? "mt-2.5 h-9 w-9 rounded-[16px]" : "mt-3 h-11 w-11 rounded-[20px]",
                leftPanel === "threads" && "bg-hover text-ink",
              )}
            >
              <Clock3 className={props.embedded ? "h-4 w-4" : "h-5 w-5"} />
            </button>
            <button
              onClick={props.onOpenLlmConfig}
              title="Setup model"
              aria-label="Setup model"
              className={cn(
                "flex items-center justify-center text-muted transition-colors hover:bg-hover hover:text-ink",
                props.embedded ? "mt-2.5 h-9 w-9 rounded-[16px]" : "mt-3 h-11 w-11 rounded-[20px]",
              )}
            >
              <Settings2 className={props.embedded ? "h-4 w-4" : "h-5 w-5"} />
            </button>
            <div className={cn("h-px bg-line/70", props.embedded ? "my-3 w-6" : "my-4 w-7")} />
            <button
              onClick={toggleAllCardsExpanded}
              title={allCardsExpanded ? "Collapse all cards" : "Expand all cards"}
              aria-label={allCardsExpanded ? "Collapse all cards" : "Expand all cards"}
              className={cn(
                "flex items-center justify-center text-muted transition-colors hover:bg-hover hover:text-ink",
                props.embedded ? "mt-2.5 h-9 w-9 rounded-[16px]" : "mt-3 h-11 w-11 rounded-[20px]",
                allCardsExpanded && "bg-hover text-ink",
              )}
            >
              {allCardsExpanded ? (
                <ChevronsUp className={props.embedded ? "h-4 w-4" : "h-5 w-5"} />
              ) : (
                <ChevronsDown className={props.embedded ? "h-4 w-4" : "h-5 w-5"} />
              )}
            </button>
            <button
              onClick={props.onNewFlow}
              title="Home"
              aria-label="Home"
              className={cn(
                "flex items-center justify-center text-muted transition-colors hover:bg-hover hover:text-ink",
                props.embedded ? "h-9 w-9 rounded-[16px]" : "h-11 w-11 rounded-[20px]",
              )}
            >
              <Home className={props.embedded ? "h-4 w-4" : "h-5 w-5"} />
            </button>
              </div>
            </div>
            {leftPanel && (
              <div
                className={cn(
                  "pointer-events-none absolute z-20",
                  "top-1/2 -translate-y-1/2",
                )}
                style={{ left: effectiveLeftPanelLeft }}
              >
                <div
                  className="nodrag nopan nowheel pointer-events-auto relative flex max-h-[calc(100vh-140px)] flex-col overflow-hidden rounded-[28px] border border-line/70 bg-[linear-gradient(180deg,#f5f7f2_0%,#fafaf8_100%)] shadow-[0_24px_60px_rgba(15,23,42,0.12)]"
                  style={{
                    width: effectiveLeftPanelWidth,
                    height: effectiveLeftPanelHeight,
                  }}
                >
                  {leftPanelResizable && (
                    <>
                      <button
                        type="button"
                        aria-label="Resize panel"
                        onMouseDown={() => startLeftPanelResize("right")}
                        className={cn(
                          "absolute right-0 top-0 z-10 h-full w-3 translate-x-1/2 cursor-ew-resize",
                          "before:absolute before:bottom-6 before:left-1/2 before:top-6 before:w-[2px] before:-translate-x-1/2 before:rounded-full before:bg-line/65 before:opacity-0 before:transition-opacity hover:before:opacity-100",
                          resizeEdge === "right" && "before:opacity-100",
                        )}
                      />
                      <button
                        type="button"
                        aria-label="Resize panel height from top"
                        onMouseDown={() => startLeftPanelResize("top")}
                        className={cn(
                          "absolute left-0 top-0 z-10 h-3 w-full -translate-y-1/2 cursor-ns-resize",
                          "before:absolute before:left-6 before:right-6 before:top-1/2 before:h-[2px] before:-translate-y-1/2 before:rounded-full before:bg-line/65 before:opacity-0 before:transition-opacity hover:before:opacity-100",
                          resizeEdge === "top" && "before:opacity-100",
                        )}
                      />
                      <button
                        type="button"
                        aria-label="Resize panel height from bottom"
                        onMouseDown={() => startLeftPanelResize("bottom")}
                        className={cn(
                          "absolute bottom-0 left-0 z-10 h-3 w-full translate-y-1/2 cursor-ns-resize",
                          "before:absolute before:left-6 before:right-6 before:top-1/2 before:h-[2px] before:-translate-y-1/2 before:rounded-full before:bg-line/65 before:opacity-0 before:transition-opacity hover:before:opacity-100",
                          resizeEdge === "bottom" && "before:opacity-100",
                        )}
                      />
                      <button
                        type="button"
                        aria-label="Resize panel from top left"
                        onMouseDown={() => startLeftPanelResize("topLeft")}
                        className="absolute left-0 top-0 z-20 h-5 w-5 -translate-x-1/3 -translate-y-1/3 cursor-nwse-resize"
                      />
                      <button
                        type="button"
                        aria-label="Resize panel from top right"
                        onMouseDown={() => startLeftPanelResize("topRight")}
                        className="absolute right-0 top-0 z-20 h-5 w-5 translate-x-1/3 -translate-y-1/3 cursor-nesw-resize"
                      />
                      <button
                        type="button"
                        aria-label="Resize panel from bottom left"
                        onMouseDown={() => startLeftPanelResize("bottomLeft")}
                        className="absolute bottom-0 left-0 z-20 h-5 w-5 -translate-x-1/3 translate-y-1/3 cursor-nesw-resize"
                      />
                      <button
                        type="button"
                        aria-label="Resize panel from bottom right"
                        onMouseDown={() => startLeftPanelResize("bottomRight")}
                        className="absolute bottom-0 right-0 z-20 h-5 w-5 translate-x-1/3 translate-y-1/3 cursor-nwse-resize"
                      />
                    </>
                  )}
                  {leftPanel === "threads" ? (
                    <CanvasRail
                      conversations={props.conversations}
                      activeId={focusThreadId}
                      onSelectThread={focusThread}
                      onDeleteThread={props.onDeleteConversation}
                    />
                  ) : leftPanel === "data" ? (
                    <CanvasDataSourcePanel
                      sources={props.dataSources ?? []}
                      selectedSourceId={props.selectedDataSourceId ?? null}
                      onSelectSource={props.onSelectDataSource}
                      onSelectAutoSource={props.onSelectAutoDataSource}
                      sourceMismatch={props.sourceMismatch}
                      onUseSuggestedSource={props.onUseSuggestedDataSource}
                      onConfirmSelectedSource={props.onConfirmSelectedDataSource}
                      onConnectData={props.onConnectData}
                      onDisconnectDataGroup={props.onDisconnectDataGroup}
                    />
                  ) : (
                    <CanvasSchemaPanel
                      canvasDb={activeConv?.database ?? props.canvasDb}
                      conversations={props.conversations}
                      activeId={focusThreadId}
                      panelWidth={leftPanelWidth}
                    />
                  )}
                </div>
              </div>
            )}

            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              minZoom={0.2}
              maxZoom={1.5}
              panOnScroll
              panOnScrollMode={PanOnScrollMode.Free}
              zoomOnScroll={false}
              preventScrolling
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
              className="canvas-dot-background"
            >
            <Background gap={24} size={1} color="rgba(95, 109, 102, 0.16)" />
            {canvasHint && (
              <Panel position="top-center" className="pointer-events-auto">
                <div className="flex items-center gap-3 rounded-full border border-accent/30 bg-card/95 px-4 py-2 text-[13px] font-medium text-muted shadow-[0_14px_36px_rgba(15,23,42,0.12)] backdrop-blur">
                  <span>{canvasHint}</span>
                  {props.onConnectData && (
                    <button
                      type="button"
                      onClick={props.onConnectData}
                      className="rounded-full bg-accent px-3 py-1 text-[12px] font-semibold text-invert-ink transition hover:opacity-90"
                    >
                      Connect data
                    </button>
                  )}
                </div>
              </Panel>
            )}
            {props.backToResult && !props.hideModeSwitch && (
              <Panel position="top-left" className="flex items-center gap-2">
                <FlowModeSwitch
                  mode="workspace"
                  onModeChange={(mode) => {
                    if (mode === "agent") props.onNewFlow();
                  }}
                />
                <button
                  onClick={props.backToResult}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-[12px] font-medium text-ink shadow-sm hover:bg-hover"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to result
                </button>
              </Panel>
            )}
            {!props.backToResult && !props.hideModeSwitch && (
              <Panel position="top-left">
                <FlowModeSwitch
                  mode="workspace"
                  onModeChange={(mode) => {
                    if (mode === "agent") props.onNewFlow();
                  }}
                />
              </Panel>
            )}
            <Panel
              position="top-right"
              className={cn(
                "flex items-center border border-line bg-card font-semibold text-ink shadow-sm",
                props.embedded
                  ? "h-10 gap-2.5 rounded-[20px] px-3 text-[12px]"
                  : "h-12 gap-4 rounded-[24px] px-4 text-[13px]",
              )}
            >
              {props.onStartOverWorkspace && (
                <>
                  <button
                    type="button"
                    onClick={props.onStartOverWorkspace}
                    aria-label="Start over"
                    title="Start over"
                    className={cn(
                      "inline-flex items-center rounded-lg px-1 transition-colors hover:bg-hover hover:text-ink",
                      props.embedded ? "gap-1 py-0.5 text-muted" : "gap-1.5 py-1 text-muted",
                    )}
                  >
                    <RotateCcw className={props.embedded ? "h-3.5 w-3.5" : "h-4 w-4"} />
                    {!props.embedded && <span>Start over</span>}
                  </button>
                  <div className={cn("w-px bg-line", props.embedded ? "h-6" : "h-7")} />
                </>
              )}
              {((props.embedded && props.onExpandCanvas) || props.onCollapseCanvas) && (
                <button
                  aria-label={props.embedded && props.onExpandCanvas ? "Expand canvas" : "Shrink canvas"}
                  title={props.embedded && props.onExpandCanvas ? "Expand canvas" : "Shrink canvas"}
                  onClick={props.embedded && props.onExpandCanvas ? props.onExpandCanvas : props.onCollapseCanvas}
                  className="rounded-lg p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  {props.embedded ? (
                    <Maximize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Minimize2 className="h-4 w-4" />
                  )}
                </button>
              )}
              <div className={cn("w-px bg-line", props.embedded ? "h-6" : "h-7")} />
              <div className={cn("flex items-center", props.embedded ? "gap-1.5" : "gap-2")}>
                <button
                  aria-label="Fit view"
                  title="Fit view"
                  onClick={resetThreadLayout}
                  className="rounded-lg p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  <Scan className={props.embedded ? "h-3.5 w-3.5" : "h-4 w-4"} />
                </button>
                <select
                  aria-label="Canvas zoom"
                  value={zoomPercent}
                  onChange={(e) => void rf.zoomTo(Number(e.target.value) / 100, { duration: 180 })}
                  className={cn(
                    "rounded-lg border border-transparent bg-transparent px-1 font-semibold text-ink focus:border-line focus:outline-none",
                    props.embedded ? "py-0.5 text-[12px]" : "py-1 text-[13px]",
                  )}
                >
                  {zoomOptions.map((pct) => (
                    <option key={pct} value={pct}>
                      {pct}%
                    </option>
                  ))}
                </select>
              </div>
              <div className={cn("w-px bg-line", props.embedded ? "h-6" : "h-7")} />
              <button
                type="button"
                onClick={() => {
                  if (runningConversation) props.onStop(runningConversation.id);
                }}
                disabled={!runningConversation}
                aria-label="Pause AurigaSQL"
                title={runningConversation ? "Pause AurigaSQL" : "AurigaSQL is idle"}
                className={cn(
                  "inline-flex items-center rounded-lg px-1 transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent",
                  props.embedded ? "gap-1 py-0.5" : "gap-1.5 py-1",
                )}
              >
                <Pause className={props.embedded ? "h-3 w-3" : "h-3.5 w-3.5"} />
                Pause
              </button>
              <div className={cn("w-px bg-line", props.embedded ? "h-6" : "h-7")} />
              <button
                type="button"
                onClick={() => {
                  if (inspectorNode) setDetailOpen((open) => !open);
                }}
                disabled={!inspectorNode}
                aria-label="Open detail"
                title={inspectorNode ? "Detail" : "Select a card to view detail"}
                className={cn(
                  "rounded-lg px-1 transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent",
                  props.embedded ? "py-0.5" : "py-1",
                )}
              >
                Detail
              </button>
            </Panel>
          </ReactFlow>
        </main>
        <CanvasInspector
          node={inspectorNode ?? null}
          open={detailOpen}
          onOpenChange={setDetailOpen}
          contained={props.embedded}
        />
      </div>
    </div>
  );
}

export function CanvasPage(props: Parameters<typeof CanvasInner>[0]) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
