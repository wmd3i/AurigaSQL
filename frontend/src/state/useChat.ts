import { useCallback, useRef, type Dispatch } from "react";
import { bff } from "../api/bff";
import type { EventStreamHandle } from "../api/eventStream";
import { openTaskStream } from "../api/eventSocket";
import { CHAT_START_NAVIGATION, type Action, type CanvasScope, type QueryMode } from "./types";
import type { DataSource } from "../api/bff";
import type { CanvasToneId } from "../lib/canvasTones";

type BranchFrom = {
  parentThreadId: string;
  parentNodeId: string;
  parentContext?: string;
  branchKind?: "follow_up" | "fork";
};

const SESSION_GONE_MESSAGE = "This session is no longer available. It may have been lost after a backend restart.";

type TaskStream = {
  handle?: EventStreamHandle;
  lastIndex: number;
  turn?: symbol;
};

function isSessionNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^404(?:\s|:|$)/.test(message);
}

export function useChat(dispatch: Dispatch<Action>) {
  const streams = useRef(new Map<string, TaskStream>());

  const unsubscribe = useCallback(
    (taskId: string) => {
      const stream = streams.current.get(taskId);
      if (!stream?.handle) return;
      stream.handle.close();
      stream.handle = undefined;
      dispatch({ type: "SSE_STATUS", id: taskId, connected: false });
    },
    [dispatch],
  );

  const sessionNotFound = useCallback(
    (taskId: string) => {
      unsubscribe(taskId);
      dispatch({ type: "SESSION_NOT_FOUND", id: taskId, message: SESSION_GONE_MESSAGE });
    },
    [dispatch, unsubscribe],
  );

  const syncSession = useCallback(
    (taskId: string, stream: TaskStream, state: Record<string, unknown>) => {
      if (Array.isArray(state.agent_events)) {
        stream.lastIndex = Math.max(stream.lastIndex, state.agent_events.length - 1);
      }
      dispatch({ type: "SYNC_SESSION_STATE", id: taskId, state });
    },
    [dispatch],
  );

  const subscribe = useCallback(
    (taskId: string, after = -1, { probe = true } = {}) => {
      if (taskId.startsWith("local_")) return;
      const existing = streams.current.get(taskId);
      // A restored conversation is probed once. Sending a new turn can reopen it.
      if (existing && (existing.handle || probe)) return existing;
      const stream: TaskStream = { lastIndex: Math.max(after, existing?.lastIndex ?? -1) };
      streams.current.set(taskId, stream);
      stream.handle = openTaskStream(taskId, {
        onEvent: (event, eventIndex) => {
          stream.lastIndex = Math.max(stream.lastIndex, eventIndex);
          dispatch({ type: "SSE_EVENT", id: taskId, event, eventIndex });
          // submit_sql can set the UI to done before the final result arrives.
          if (event.type === "done") unsubscribe(taskId);
        },
        onDisconnect: () => dispatch({ type: "SSE_STATUS", id: taskId, connected: false }),
        onConnect: () => dispatch({ type: "SSE_STATUS", id: taskId, connected: true }),
        onNotFound: () => sessionNotFound(taskId),
      }, stream.lastIndex);

      if (probe) {
        const isCurrent = () => streams.current.get(taskId) === stream && stream.handle && !stream.turn;
        bff
          .session(taskId)
          .then(({ state }) => {
            if (!isCurrent()) return;
            syncSession(taskId, stream, state);
            if (state.task_done === true || state._cancelled === true) unsubscribe(taskId);
          })
          .catch((error) => {
            if (isCurrent() && isSessionNotFound(error)) sessionNotFound(taskId);
          });
      }
      return stream;
    },
    [dispatch, sessionNotFound, syncSession, unsubscribe],
  );

  const sendMessage = useCallback(
    (taskId: string, message: string, model?: string | null, after = -1) => {
      const stream = subscribe(taskId, after, { probe: false });
      if (!stream) return;
      dispatch({ type: "TURN_SENT", id: taskId });
      const turn = Symbol();
      stream.turn = turn;
      const isCurrent = () => streams.current.get(taskId) === stream && stream.turn === turn;
      bff
        .turn(taskId, message, "a-interact", model)
        .then(({ state }) => {
          if (!isCurrent()) return;
          syncSession(taskId, stream, state);
          if (typeof state.error === "string" && state.error.trim()) {
            dispatch({ type: "CONV_ERROR", id: taskId, message: state.error });
          } else {
            dispatch({ type: "TURN_DONE", id: taskId });
          }
          unsubscribe(taskId);
        })
        .catch((error) => {
          if (!isCurrent() || !stream.handle) return;
          if (isSessionNotFound(error)) {
            sessionNotFound(taskId);
          } else {
            dispatch({ type: "CONV_ERROR", id: taskId, message: String(error) });
          }
        });
    },
    [dispatch, sessionNotFound, subscribe, syncSession, unsubscribe],
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
      signal?.throwIfAborted();
      // Receive the task ID even if the caller leaves during creation.
      const started = await bff.startFreechat(source.id, query, model, branchFrom?.parentContext ?? null);
      const background = signal?.aborted && signal.reason === CHAT_START_NAVIGATION;
      if (signal?.aborted && !background) {
        await bff.cleanup(started.task_id);
        return;
      }
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
        background,
      });
      sendMessage(started.task_id, query, model);
      // Fire-and-forget: a short AI title for the sidebar (from the first query).
      bff
        .summaryTitle(query)
        .then((r) => {
          if (r.title) dispatch({ type: "SET_SUMMARY", id: started.task_id, summary: r.title });
        })
        .catch(() => {}); // best-effort; sidebar falls back to the raw query
    },
    [dispatch, sendMessage],
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

  /** Stop the in-flight agent turn. Optimistically flips the conversation to a
   *  terminal "stopped" state; the still-open turn() POST resolves shortly after
   *  the backend aborts the loop. */
  const cancel = useCallback(
    (taskId: string) => {
      dispatch({ type: "TURN_STOPPED", id: taskId });
      const stream = streams.current.get(taskId);
      if (!stream?.handle) return;
      const turn = stream.turn;
      const closeIfCurrent = () => {
        if (streams.current.get(taskId) === stream && stream.turn === turn) unsubscribe(taskId);
      };
      // Keep the stream for the cancellation's done event so its index is
      // recorded before a subsequent turn reopens the conversation.
      bff.cancel(taskId)
        .then(({ status }) => {
          if (status === "no_active_turn") closeIfCurrent();
        })
        .catch((error) => {
          closeIfCurrent();
          console.error("cancel failed", error);
        });
    },
    [dispatch, unsubscribe],
  );

  const answerPending = useCallback(
    (taskId: string, answer: string) => {
      return bff
        .answerUser(taskId, answer)
        .then(() => bff.session(taskId))
        .then((snapshot) => dispatch({ type: "SYNC_SESSION_STATE", id: taskId, state: snapshot.state }))
        .catch((e) => dispatch({ type: "CONV_ERROR", id: taskId, message: String(e) }));
    },
    [dispatch],
  );

  const deleteConversation = useCallback(
    async (taskId: string) => {
      streams.current.get(taskId)?.handle?.close();
      streams.current.delete(taskId);
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
      streams.current.get(taskId)?.handle?.close();
      streams.current.delete(taskId);
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
