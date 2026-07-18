import { useCallback, useRef, type Dispatch } from "react";
import { bff } from "../api/bff";
import { openEventStream, type EventStreamHandle } from "../api/eventStream";
import type { Action, CanvasScope, QueryMode } from "./types";
import type { DataSource } from "../api/bff";
import type { CanvasToneId } from "../lib/canvasTones";
import type { RawAgentEvent } from "../lib/buildTimeline";

type BranchFrom = {
  parentThreadId: string;
  parentNodeId: string;
  parentContext?: string;
  branchKind?: "follow_up" | "fork";
};

function errorFromTurnState(state: Record<string, unknown>): string | null {
  return typeof state.error === "string" && state.error.trim() ? state.error : null;
}

function agentEventsFromTurnState(state: Record<string, unknown>): RawAgentEvent[] {
  const events = state.agent_events;
  if (!Array.isArray(events)) return [];
  return events.filter((event): event is RawAgentEvent => {
    if (!event || typeof event !== "object") return false;
    return typeof (event as { type?: unknown }).type === "string";
  });
}

export function useChat(dispatch: Dispatch<Action>) {
  const streams = useRef<Map<string, EventStreamHandle>>(new Map());
  const probedSessions = useRef<Set<string>>(new Set());

  const probeSession = useCallback(
    (taskId: string, handle: EventStreamHandle | undefined) => {
      if (probedSessions.current.has(taskId)) return;
      probedSessions.current.add(taskId);
      bff
        .session(taskId)
        .then((snapshot) => {
          const events = agentEventsFromTurnState(snapshot.state);
          if (events.length > 0) {
            dispatch({ type: "SYNC_AGENT_EVENTS", id: taskId, events });
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("404")) return;
          handle?.close();
          streams.current.delete(taskId);
          probedSessions.current.delete(taskId);
          dispatch({
            type: "CONV_ERROR",
            id: taskId,
            message: "This session is no longer available. It may have been lost after a backend restart.",
          });
        });
    },
    [dispatch],
  );

  const subscribe = useCallback(
    (taskId: string) => {
      if (taskId.startsWith("local_")) return;
      const existing = streams.current.get(taskId);
      if (existing) {
        probeSession(taskId, existing);
        return;
      }
      const handle = openEventStream(
        taskId,
        (event) => dispatch({ type: "SSE_EVENT", id: taskId, event }),
        () => dispatch({ type: "SSE_STATUS", id: taskId, connected: false }),
        () => dispatch({ type: "SSE_STATUS", id: taskId, connected: true }),
      );
      streams.current.set(taskId, handle);
      probeSession(taskId, handle);
    },
    [dispatch, probeSession],
  );

  /** Home composer submit: start free-chat session, subscribe, fire first turn.
   *  The first turn message stays the raw query so the SSE echo still matches
   *  the title for root-node dedupe. */
  const startConversation = useCallback(
    async (
      source: DataSource,
      query: string,
      mode: QueryMode,
      model?: string | null,
      branchFrom?: BranchFrom | null,
      canvasScope?: CanvasScope,
      signal?: AbortSignal,
      options?: { preserveView?: boolean; canvasTone?: CanvasToneId; canvasWorkId?: string | null },
    ) => {
      const started = await bff.startFreechat(source.id, query, model, branchFrom?.parentContext ?? null, signal); // throws → caller shows inline error
      dispatch({
        type: "CONVERSATION_STARTED",
        id: started.task_id,
        source: started.source,
        database: started.database,
        databases: started.databases,
        title: query,
        createdAt: Date.now(),
        mode,
        canvasWorkId: options?.canvasWorkId ?? null,
        parentThreadId: branchFrom?.parentThreadId ?? null,
        parentNodeId: branchFrom?.parentNodeId ?? null,
        canvasBranchKind: branchFrom?.branchKind,
        canvasTone: options?.canvasTone,
        canvasScope,
        preserveView: options?.preserveView,
      });
      subscribe(started.task_id);
      dispatch({ type: "TURN_SENT", id: started.task_id });
      // Fire-and-forget: a short AI title for the sidebar (from the first query).
      bff
        .summaryTitle(query)
        .then((r) => {
          if (r.title) dispatch({ type: "SET_SUMMARY", id: started.task_id, summary: r.title });
        })
        .catch(() => {}); // best-effort; sidebar falls back to the raw query
      bff
        .turn(started.task_id, query, "a-interact", model)
        .then((response) => {
          const events = agentEventsFromTurnState(response.state);
          if (events.length > 0) {
            dispatch({ type: "SYNC_AGENT_EVENTS", id: started.task_id, events });
          }
          const error = errorFromTurnState(response.state);
          if (error) {
            dispatch({ type: "CONV_ERROR", id: started.task_id, message: error });
            return;
          }
          dispatch({ type: "TURN_DONE", id: started.task_id });
        })
        .catch((e) => dispatch({ type: "CONV_ERROR", id: started.task_id, message: String(e) }));
    },
    [dispatch, subscribe],
  );

  const startLocalBranch = useCallback(
    (
      source: DataSource | undefined,
      database: string,
      databases: string[],
      query: string,
      branchFrom: { parentThreadId: string; parentNodeId: string; branchKind?: "follow_up" | "fork" },
      canvasScope?: CanvasScope,
      canvasTone?: CanvasToneId,
      canvasWorkId?: string | null,
    ) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `local_${crypto.randomUUID()}`
          : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      dispatch({
        type: "LOCAL_BRANCH_STARTED",
        id,
        source,
        database,
        databases,
        title: query,
        createdAt: Date.now(),
        canvasWorkId,
        parentThreadId: branchFrom.parentThreadId,
        parentNodeId: branchFrom.parentNodeId,
        canvasBranchKind: branchFrom.branchKind,
        canvasTone,
        canvasScope,
      });
      return id;
    },
    [dispatch],
  );

  const answerLocalBranch = useCallback(
    async (id: string, query: string, parentContext: string, model?: string | null) => {
      try {
        const response = await bff.branchAnswer(query, parentContext, model);
        dispatch({ type: "LOCAL_BRANCH_ANSWERED", id, answer: response.answer });
      } catch (e) {
        dispatch({ type: "CONV_ERROR", id, message: String(e) });
      }
    },
    [dispatch],
  );

  const sendMessage = useCallback(
    (taskId: string, message: string, model?: string | null) => {
      dispatch({ type: "TURN_SENT", id: taskId });
      bff
        .turn(taskId, message, "a-interact", model)
        .then((response) => {
          const events = agentEventsFromTurnState(response.state);
          if (events.length > 0) {
            dispatch({ type: "SYNC_AGENT_EVENTS", id: taskId, events });
          }
          const error = errorFromTurnState(response.state);
          if (error) {
            dispatch({ type: "CONV_ERROR", id: taskId, message: error });
            return;
          }
          dispatch({ type: "TURN_DONE", id: taskId });
        })
        .catch((e) => dispatch({ type: "CONV_ERROR", id: taskId, message: String(e) }));
    },
    [dispatch],
  );

  /** Stop the in-flight agent turn. Optimistically flips the conversation to a
   *  terminal "stopped" state; the still-open turn() POST resolves shortly after
   *  the backend aborts the loop. */
  const cancel = useCallback(
    (taskId: string) => {
      dispatch({ type: "TURN_STOPPED", id: taskId });
      bff.cancel(taskId).catch((e) => {
        // Best-effort: the UI is already stopped. Log but don't error the thread.
        console.error("cancel failed", e);
      });
    },
    [dispatch],
  );

  const answerPending = useCallback(
    (taskId: string, answer: string) => {
      bff
        .answerUser(taskId, answer)
        .then(() => dispatch({ type: "ANSWER_SENT", id: taskId }))
        .catch((e) => dispatch({ type: "CONV_ERROR", id: taskId, message: String(e) }));
    },
    [dispatch],
  );

  const deleteConversation = useCallback(
    async (taskId: string) => {
      const handle = streams.current.get(taskId);
      if (handle) {
        handle.close();
        streams.current.delete(taskId);
      }
      probedSessions.current.delete(taskId);
      dispatch({ type: "DELETE_CONVERSATION", id: taskId });
      try {
        await bff.cleanup(taskId);
      } catch {
        // Best-effort cleanup only: the user asked to remove local history first.
      }
    },
    [dispatch],
  );

  const clearConversations = useCallback((taskIds: string[]) => {
    taskIds.forEach((taskId) => {
      streams.current.get(taskId)?.close();
      streams.current.delete(taskId);
      probedSessions.current.delete(taskId);
      bff.cleanup(taskId).catch(() => {
        // Local history is cleared immediately; backend cleanup is best effort.
      });
    });
  }, []);

  const revertConversationToNode = useCallback(
    (taskId: string, nodeId: string) => {
      cancel(taskId);
      dispatch({ type: "REVERT_CONVERSATION_TO_NODE", id: taskId, nodeId });
    },
    [cancel, dispatch],
  );

  return {
    startConversation,
    startLocalBranch,
    answerLocalBranch,
    sendMessage,
    answerPending,
    cancel,
    subscribe,
    deleteConversation,
    clearConversations,
    revertConversationToNode,
  };
}
