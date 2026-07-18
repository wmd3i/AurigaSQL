import { buildTimeline, type RawAgentEvent } from "../lib/buildTimeline";
import { buildNodes } from "../lib/buildNodes";
import type { Action, AppState, Conversation } from "./types";

function patch(
  state: AppState,
  id: string,
  fn: (c: Conversation) => Conversation,
): AppState {
  return {
    ...state,
    conversations: state.conversations.map((c) => (c.id === id ? fn(c) : c)),
  };
}

function nodeIndexFromId(nodeId: string): number | null {
  const match = /^n(\d+)$/.exec(nodeId);
  if (!match) return null;
  return Number(match[1]);
}

function trimRawEventsToNodeCount(conv: Conversation, keepNodeCount: number): RawAgentEvent[] {
  if (keepNodeCount <= 1) return [];
  let best = conv.rawEvents;

  for (let i = 0; i <= conv.rawEvents.length; i += 1) {
    const rawEvents = conv.rawEvents.slice(0, i);
    const timeline = buildTimeline(rawEvents);
    const nodeCount = buildNodes(timeline, conv.title).length;
    if (nodeCount <= keepNodeCount) best = rawEvents;
    if (nodeCount >= keepNodeCount) break;
  }

  return best;
}

function isSubmitEvent(evt: RawAgentEvent) {
  return (
    evt.type === "adk_event" &&
    (evt.content?.parts ?? []).some((p) => p.type === "function_call" && p.name === "submit_sql")
  );
}

function statusFromEvents(events: RawAgentEvent[], fallback: Conversation["status"]): Conversation["status"] {
  if (events.some((evt) => evt.type === "error")) return "error";
  if (events.some((evt) => evt.type === "final_answer" || evt.type === "done" || isSubmitEvent(evt))) return "done";
  return events.length > 0 ? "active" : fallback;
}

function canvasWorkIdForConversation(conversations: Conversation[], conversation: Conversation) {
  if (conversation.canvasWorkId) return conversation.canvasWorkId;
  const byId = new Map(conversations.map((item) => [item.id, item]));
  let current: Conversation | undefined = conversation;
  const seen = new Set<string>();
  while (current?.parentThreadId && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentThreadId);
  }
  return current?.canvasWorkId ?? current?.id ?? conversation.id;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "CONVERSATION_STARTED": {
      const conv: Conversation = {
        id: action.id,
        source: action.source,
        database: action.database,
        databases: action.databases,
        mode: action.mode,
        canvasWorkId: action.mode === "workspace" ? action.canvasWorkId ?? action.id : null,
        parentThreadId: action.parentThreadId ?? null,
        parentNodeId: action.parentNodeId ?? null,
        canvasBranchKind: action.canvasBranchKind,
        canvasTone: action.canvasTone,
        title: action.title, // verbatim — buildNodes dedupes the SSE echo by exact match; display layers truncate visually
        summary: null,
        rawEvents: [],
        timeline: [],
        pendingQuestion: null,
        status: "starting",
        turnInFlight: false,
        sseConnected: false,
        error: null,
        createdAt: action.createdAt,
      };
      return {
        ...state,
        // agent mode lands on the answer-first result page; canvas mode goes straight to canvas.
        // Embedded canvas starts the same real thread but stays on the home surface until expanded.
        view: action.preserveView ? state.view : action.mode === "agent" ? "result" : "canvas",
        activeId: conv.id,
        canvasDb: state.canvasDb ?? conv.database,
        currentCanvasWorkId: conv.mode === "workspace" ? conv.canvasWorkId : state.currentCanvasWorkId,
        canvasScope: action.canvasScope ?? (action.mode === "agent" ? state.canvasScope : "all"),
        conversations: [conv, ...state.conversations],
      };
    }
    case "LOCAL_BRANCH_STARTED": {
      const conv: Conversation = {
        id: action.id,
        source: action.source,
        database: action.database,
        databases: action.databases,
        mode: "workspace",
        canvasWorkId: action.canvasWorkId ?? action.parentThreadId,
        parentThreadId: action.parentThreadId,
        parentNodeId: action.parentNodeId,
        canvasBranchKind: action.canvasBranchKind,
        canvasTone: action.canvasTone,
        title: action.title,
        summary: null,
        rawEvents: [],
        timeline: [],
        pendingQuestion: null,
        status: "active",
        turnInFlight: true,
        sseConnected: false,
        error: null,
        createdAt: action.createdAt,
      };
      return {
        ...state,
        view: "canvas",
        activeId: conv.id,
        canvasDb: state.canvasDb ?? conv.database,
        currentCanvasWorkId: conv.canvasWorkId,
        canvasScope: action.canvasScope ?? "all",
        conversations: [conv, ...state.conversations],
      };
    }
    case "LOCAL_BRANCH_ANSWERED":
      return patch(state, action.id, (c) => ({
        ...c,
        timeline: [{ kind: "final", text: action.answer }],
        status: "done",
        turnInFlight: false,
        error: null,
      }));
    case "SSE_EVENT": {
      if (action.event.type === "pending_question") {
        const text = action.event.text;
        return {
          ...patch(state, action.id, (c) => ({ ...c, pendingQuestion: text, status: "waiting_user" })),
          answerTarget: action.id,
        };
      }
      if (action.event.type === "clarification_request") {
        const question = action.event.question;
        return {
          ...patch(state, action.id, (c) => ({ ...c, pendingQuestion: question, status: "waiting_user" })),
          answerTarget: action.id,
        };
      }
      const evt = action.event as RawAgentEvent;
      const isDone = evt.type === "final_answer" || evt.type === "done" || isSubmitEvent(evt);
      const isError = evt.type === "error";
      return patch(state, action.id, (c) => {
        const rawEvents = [...c.rawEvents, evt];
        // Terminal states (one-shot "done", user "stopped") must not be reopened
        // by trailing events (submit ack, late-arriving tool output).
        const terminal = c.status === "done" || c.status === "stopped";
        const status = terminal ? c.status : isError ? "error" : isDone ? "done" : "active";
        return {
          ...c,
          rawEvents,
          timeline: buildTimeline(rawEvents),
          status,
          turnInFlight: isDone || isError || status === "done" || status === "stopped" ? false : c.turnInFlight,
          error: isError ? evt.message : null,
        };
      });
    }
    case "SYNC_AGENT_EVENTS":
      return patch(state, action.id, (c) => {
        if (action.events.length <= c.rawEvents.length) return c;
        const status = statusFromEvents(action.events, c.status);
        const errorEvent = action.events.find((evt) => evt.type === "error");
        return {
          ...c,
          rawEvents: action.events,
          timeline: buildTimeline(action.events),
          status,
          turnInFlight: status === "done" || status === "error" || status === "stopped" ? false : c.turnInFlight,
          error: errorEvent && "message" in errorEvent ? errorEvent.message : c.error,
        };
      });
    case "SSE_STATUS":
      return patch(state, action.id, (c) => ({ ...c, sseConnected: action.connected }));
    case "TURN_SENT":
      // A new turn reopens the thread: clear the terminal "done"/"stopped" so
      // follow-up events flow in again (status settles via the next SSE event).
      return patch(state, action.id, (c) => ({
        ...c,
        turnInFlight: true,
        status: c.status === "done" || c.status === "stopped" ? "active" : c.status,
        error: null,
      }));
    case "TURN_DONE":
      return patch(state, action.id, (c) => ({ ...c, turnInFlight: false }));
    case "TURN_STOPPED":
      return patch(state, action.id, (c) => ({
        ...c,
        status: "stopped",
        turnInFlight: false,
        pendingQuestion: null,
      }));
    case "SET_SUMMARY":
      return patch(state, action.id, (c) => ({ ...c, summary: action.summary }));
    case "ANSWER_SENT": {
      const next = patch(state, action.id, (c) => ({ ...c, pendingQuestion: null, status: "active" }));
      return state.answerTarget === action.id ? { ...next, answerTarget: null } : next;
    }
    case "CONV_ERROR":
      return patch(state, action.id, (c) => ({ ...c, error: action.message, status: "error", turnInFlight: false }));
    case "DELETE_CONVERSATION": {
      const conversations = state.conversations.filter((c) => c.id !== action.id);
      const wasActive = state.activeId === action.id;
      const nextActiveId = wasActive ? conversations[0]?.id ?? null : state.activeId;
      const nextActiveConversation = nextActiveId
        ? conversations.find((c) => c.id === nextActiveId) ?? null
        : null;
      const deletedConversation = state.conversations.find((c) => c.id === action.id) ?? null;
      return {
        ...state,
        conversations,
        activeId: nextActiveId,
        answerTarget: state.answerTarget === action.id ? null : state.answerTarget,
        view:
          conversations.length === 0
            ? "home"
            : wasActive
              ? nextActiveConversation?.mode === "agent"
                ? "result"
                : "canvas"
              : state.view,
        canvasDb:
          state.canvasDb === deletedConversation?.database
            ? conversations[0]?.database ?? null
            : state.canvasDb,
        currentCanvasWorkId:
          deletedConversation?.canvasWorkId && state.currentCanvasWorkId === deletedConversation.canvasWorkId
            ? nextActiveConversation?.canvasWorkId ?? null
            : state.currentCanvasWorkId,
        canvasScope:
          conversations.length === 0
            ? "all"
            : wasActive && nextActiveConversation?.mode === "workspace"
              ? "all"
              : state.canvasScope,
      };
    }
    case "REVERT_CONVERSATION_TO_NODE": {
      const targetIndex = nodeIndexFromId(action.nodeId);
      if (targetIndex === null || targetIndex <= 0) return state;
      return patch(state, action.id, (c) => {
        const rawEvents = trimRawEventsToNodeCount(c, targetIndex);
        const timeline = buildTimeline(rawEvents);
        return {
          ...c,
          rawEvents,
          timeline,
          pendingQuestion: null,
          status: "stopped",
          turnInFlight: false,
          error: null,
        };
      });
    }
    case "NEW_FLOW":
      return { ...state, view: "home", activeId: null, canvasScope: "all", entryMode: "agent" };
    case "START_OVER_WORKSPACE": {
      return {
        ...state,
        view: action.view ?? "home",
        activeId: null,
        currentCanvasWorkId: action.canvasWorkId ?? null,
        canvasScope: "all",
        answerTarget: null,
        entryMode: "workspace",
      };
    }
    case "OPEN_WORKSPACE_SETUP":
      return {
        ...state,
        view: "workspace_setup",
        activeId: null,
        canvasScope: "all",
        answerTarget: null,
      };
    case "OPEN_CONVERSATION": {
      const conv = state.conversations.find((c) => c.id === action.id);
      const view: AppState["view"] = conv?.mode === "agent" ? "result" : "canvas";
      return {
        ...state,
        view,
        activeId: action.id,
        currentCanvasWorkId: conv?.mode === "workspace" ? conv.canvasWorkId ?? conv.id : state.currentCanvasWorkId,
        canvasScope: conv?.mode === "workspace" ? "all" : state.canvasScope,
      };
    }
    case "OPEN_WORKSPACE": {
      const activeWorkspace = action.preserveActiveThread
        ? state.conversations.find((c) => c.id === state.activeId && c.mode === "workspace")
        : null;
      return {
        ...state,
        view: "canvas",
        activeId: activeWorkspace ? activeWorkspace.id : null,
        canvasDb: activeWorkspace ? state.canvasDb ?? activeWorkspace.database : action.database,
        currentCanvasWorkId: activeWorkspace?.canvasWorkId ?? state.currentCanvasWorkId,
        canvasScope: "all",
        answerTarget: null,
        entryMode: "workspace",
      };
    }
    case "SET_VIEW":
      return {
        ...state,
        view: action.view,
        canvasScope: action.view === "canvas" ? action.canvasScope ?? state.canvasScope : state.canvasScope,
      };
    case "SET_ANSWER_TARGET":
      return { ...state, answerTarget: action.id };
    case "SET_ENTRY_MODE":
      return { ...state, entryMode: action.mode };
  }
}
