import type { TimelineEvent, RawAgentEvent } from "../lib/buildTimeline";
import type { StreamEvent } from "../api/eventStream";
import type { DataSource } from "../api/bff";
import type { CanvasToneId } from "../lib/canvasTones";

export type ConversationStatus =
  | "starting"
  | "active"
  | "waiting_user"
  | "done"
  | "stopped"
  | "error";
export type QueryMode = "agent" | "workspace";
export type CanvasBranchKind = "follow_up" | "fork";

export type Conversation = {
  id: string; // backend task_id
  source?: DataSource;
  database: string;
  databases: string[];
  mode: QueryMode;
  canvasWorkId: string | null; // groups all runs/cards that belong to one canvas work/session
  parentThreadId: string | null; // branch threads: which conversation they forked from
  parentNodeId: string | null; // branch threads: which card inside the parent thread they forked from
  canvasBranchKind?: CanvasBranchKind;
  canvasTone?: CanvasToneId;
  title: string; // the user's first query, verbatim — never truncate here (echo dedupe + root node depend on it)
  summary: string | null; // short AI-generated title for the sidebar (falls back to title)
  rawEvents: RawAgentEvent[];
  timeline: TimelineEvent[];
  pendingQuestion: string | null;
  status: ConversationStatus;
  turnInFlight: boolean;
  sseConnected: boolean;
  error: string | null;
  createdAt: number;
};

export type View = "home" | "workspace_setup" | "result" | "canvas";
export type CanvasScope = "all" | "active";

export type AppState = {
  view: View;
  conversations: Conversation[]; // newest first — this IS the History list
  activeId: string | null;
  canvasDb: string | null;      // canvas-level database (first thread's choice; per-root pickers are a future UI change)
  currentCanvasWorkId: string | null; // active canvas work/session; Start over creates a new one
  canvasScope: CanvasScope;
  answerTarget: string | null;  // which conversation the composer's answer goes to (click a question node to switch)
  entryMode: QueryMode;
};

export const initialState: AppState = {
  view: "home",
  conversations: [],
  activeId: null,
  canvasDb: null,
  currentCanvasWorkId: null,
  canvasScope: "all",
  answerTarget: null,
  entryMode: "agent",
};

export type Action =
  | {
      type: "CONVERSATION_STARTED";
      id: string;
      source?: DataSource;
      database: string;
      databases: string[];
      title: string;
      createdAt: number;
      mode: QueryMode;
      canvasWorkId?: string | null;
      parentThreadId?: string | null;
      parentNodeId?: string | null;
      canvasBranchKind?: CanvasBranchKind;
      canvasTone?: CanvasToneId;
      canvasScope?: CanvasScope;
      preserveView?: boolean;
    }
  | {
      type: "LOCAL_BRANCH_STARTED";
      id: string;
      source?: DataSource;
      database: string;
      databases: string[];
      title: string;
      createdAt: number;
      canvasWorkId?: string | null;
      parentThreadId: string;
      parentNodeId: string;
      canvasBranchKind?: CanvasBranchKind;
      canvasTone?: CanvasToneId;
      canvasScope?: CanvasScope;
    }
  | {
      type: "LOCAL_BRANCH_ANSWERED";
      id: string;
      answer: string;
    }
  | { type: "SSE_EVENT"; id: string; event: StreamEvent }
  | { type: "SYNC_AGENT_EVENTS"; id: string; events: RawAgentEvent[] }
  | { type: "SSE_STATUS"; id: string; connected: boolean }
  | { type: "TURN_SENT"; id: string }
  | { type: "TURN_DONE"; id: string }
  | { type: "TURN_STOPPED"; id: string }
  | { type: "SET_SUMMARY"; id: string; summary: string }
  | { type: "ANSWER_SENT"; id: string }
  | { type: "CONV_ERROR"; id: string; message: string }
  | { type: "DELETE_CONVERSATION"; id: string }
  | { type: "REVERT_CONVERSATION_TO_NODE"; id: string; nodeId: string }
  | { type: "NEW_FLOW" }
  | { type: "START_OVER_WORKSPACE"; view?: "home" | "canvas"; canvasWorkId?: string | null }
  | { type: "OPEN_CONVERSATION"; id: string }
  | { type: "OPEN_WORKSPACE_SETUP" }
  | { type: "OPEN_WORKSPACE"; database: string; preserveActiveThread?: boolean }
  | { type: "SET_VIEW"; view: View; canvasScope?: CanvasScope }
  | { type: "SET_ANSWER_TARGET"; id: string | null }
  | { type: "SET_ENTRY_MODE"; mode: QueryMode };
