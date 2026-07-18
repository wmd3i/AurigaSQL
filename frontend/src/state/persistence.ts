import { buildTimeline, type RawAgentEvent } from "../lib/buildTimeline";
import { initialState, type AppState, type CanvasScope, type Conversation, type QueryMode } from "./types";
import { inferDataEngine, normalizeDataEngine } from "../lib/databaseEngine";
import type { DataSource } from "../api/bff";
import { CANVAS_TONES, type CanvasToneId } from "../lib/canvasTones";

const STORAGE_KEY = "aurigasql.app-state.v1";
const LEGACY_STORAGE_KEY = "dbagent.app-state.v1";

type PersistedConversation = Omit<Conversation, "timeline"> & {
  rawEvents: RawAgentEvent[];
};

type PersistedState = Omit<AppState, "conversations"> & {
  conversations: PersistedConversation[];
};

function isQueryMode(value: unknown): value is QueryMode {
  return value === "agent" || value === "workspace";
}

function isCanvasScope(value: unknown): value is CanvasScope {
  return value === "all" || value === "active";
}

function isCanvasTone(value: unknown): value is CanvasToneId {
  return typeof value === "string" && CANVAS_TONES.some((tone) => tone.id === value);
}

function readSource(value: unknown, fallbackDatabase: string): DataSource | undefined {
  if (!value || typeof value !== "object") {
    const engine = inferDataEngine(fallbackDatabase);
    return {
      id: `${engine}:${fallbackDatabase}`,
      source_group: "restored",
      engine,
      display_name: fallbackDatabase,
      ready: true,
      source_type: "restored",
      database: fallbackDatabase,
      db_path: null,
      schema_path: null,
      connection_id: null,
      description: "",
      reason: "",
    };
  }
  const record = value as Record<string, unknown>;
  const displayName =
    typeof record.display_name === "string"
      ? record.display_name
      : fallbackDatabase;
  const engine = normalizeDataEngine(record.engine);
  return {
    id: typeof record.id === "string" ? record.id : `${engine}:${displayName}`,
    source_group:
      typeof record.source_group === "string"
        ? record.source_group
        : typeof record.benchmark_id === "string"
          ? record.benchmark_id
          : "restored",
    engine,
    display_name: displayName,
    ready: typeof record.ready === "boolean" ? record.ready : true,
    source_type: typeof record.source_type === "string" ? record.source_type : "restored",
    database: typeof record.database === "string" ? record.database : displayName,
    db_path: typeof record.db_path === "string" ? record.db_path : null,
    schema_path: typeof record.schema_path === "string" ? record.schema_path : null,
    connection_id: typeof record.connection_id === "string" ? record.connection_id : null,
    description: typeof record.description === "string" ? record.description : "",
    reason: typeof record.reason === "string" ? record.reason : "",
  };
}

function readConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.database !== "string" ||
    !Array.isArray(record.databases) ||
    !record.databases.every((item) => typeof item === "string") ||
    !isQueryMode(record.mode) ||
    typeof record.title !== "string" ||
    typeof record.createdAt !== "number" ||
    !Array.isArray(record.rawEvents)
  ) {
    return null;
  }

  const rawEvents = record.rawEvents as RawAgentEvent[];
  return {
    id: record.id,
    source: readSource(record.source, record.database),
    database: record.database,
    databases: record.databases as string[],
    mode: record.mode,
    canvasWorkId: typeof record.canvasWorkId === "string" ? record.canvasWorkId : null,
    parentThreadId: typeof record.parentThreadId === "string" ? record.parentThreadId : null,
    parentNodeId: typeof record.parentNodeId === "string" ? record.parentNodeId : null,
    canvasBranchKind:
      record.canvasBranchKind === "follow_up" || record.canvasBranchKind === "fork"
        ? record.canvasBranchKind
        : undefined,
    canvasTone: isCanvasTone(record.canvasTone) ? record.canvasTone : undefined,
    title: record.title,
    summary: typeof record.summary === "string" ? record.summary : null,
    rawEvents,
    timeline: buildTimeline(rawEvents),
    pendingQuestion: typeof record.pendingQuestion === "string" ? record.pendingQuestion : null,
    status:
      record.status === "starting" ||
      record.status === "active" ||
      record.status === "waiting_user" ||
      record.status === "done" ||
      record.status === "stopped" ||
      record.status === "error"
        ? record.status
        : "error",
    turnInFlight: record.turnInFlight === true,
    sseConnected: false,
    error: typeof record.error === "string" ? record.error : null,
    createdAt: record.createdAt,
  };
}

function normalizeState(value: unknown): AppState {
  if (!value || typeof value !== "object") return initialState;
  const record = value as Partial<PersistedState>;
  const conversations = Array.isArray(record.conversations)
    ? record.conversations.map(readConversation).filter((item): item is Conversation => item !== null)
    : [];

  return {
    view: "home",
    conversations,
    activeId: null,
    canvasDb: typeof record.canvasDb === "string" ? record.canvasDb : null,
    currentCanvasWorkId: typeof record.currentCanvasWorkId === "string" ? record.currentCanvasWorkId : null,
    canvasScope: isCanvasScope(record.canvasScope) ? record.canvasScope : initialState.canvasScope,
    answerTarget: null,
    entryMode: "agent",
  };
}

export function loadAppState(): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return initialState;
    return normalizeState(JSON.parse(raw));
  } catch {
    return initialState;
  }
}

export function saveAppState(state: AppState) {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedState = {
      ...state,
      conversations: state.conversations.map((conversation) => ({
        ...conversation,
        sseConnected: false,
      })),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore storage failures so the app keeps working in private mode/quota limits.
  }
}
