import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "../api/bff";
import { reducer } from "./reducer";
import { initialState } from "./types";
import { useChat } from "./useChat";

vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("../api/bff", () => ({
  bff: {
    cancel: vi.fn(),
    cleanup: vi.fn(),
    session: vi.fn(),
    turn: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ BFF_BASE: "http://127.0.0.1:6003" }));

class FakeSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;

  constructor() {
    sockets.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let sockets: FakeSocket[];
let dispose: () => void;

function startChats(...ids: string[]) {
  let state = initialState;
  const chat = useChat((action) => { state = reducer(state, action); });
  for (const id of ids) {
    state = reducer(state, {
      type: "CONVERSATION_STARTED", id, database: "db", databases: ["db"],
      title: id, createdAt: 1, mode: "agent",
    });
    chat.subscribe(id);
  }
  sockets[0].open();
  dispose = () => chat.clearConversations(ids);
  return {
    chat,
    conversation: (id: string) => state.conversations.find((conversation) => conversation.id === id),
  };
}

function reconnect() {
  sockets.at(-1)!.close();
  vi.advanceTimersByTime(500);
  const socket = sockets.at(-1)!;
  socket.open();
  return socket;
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.mocked(bff.session).mockImplementation(() => new Promise(() => {}));
  vi.mocked(bff.turn).mockImplementation(() => new Promise(() => {}));
  vi.mocked(bff.cancel).mockImplementation(() => Promise.resolve({ status: "ok" }));
  vi.mocked(bff.cleanup).mockImplementation(() => Promise.resolve({ status: "ok" }));
});

afterEach(() => {
  dispose();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chat event subscriptions", () => {
  it("keeps completed history when the backend restarts and reconnects only active tasks", () => {
    const { conversation } = startChats("completed", "running");
    sockets[0].receive({ task_id: "running", index: 0, event: { type: "user_message", text: "Work in progress" } });
    const answer = { type: "final_answer", text: "The answer", sql: null, result: null };
    sockets[0].receive({ task_id: "completed", index: 0, event: answer });
    expect(conversation("completed")?.status).toBe("done");
    expect(sockets[0].sent.at(-1)).not.toMatchObject({ op: "unsubscribe", task_id: "completed" });
    sockets[0].receive({ task_id: "completed", index: 1, event: { type: "done" } });
    expect(sockets[0].sent.at(-1)).toEqual({ op: "unsubscribe", task_id: "completed" });

    const socket = reconnect();
    expect(socket.sent).toEqual([{ op: "subscribe", task_id: "running", after: 0 }]);
    socket.receive({ task_id: "running", type: "not_found" });

    expect(conversation("completed")).toMatchObject({
      status: "done", error: null, sseConnected: false, rawEvents: [answer, { type: "done" }],
    });
    expect(conversation("running")).toMatchObject({
      status: "error", error: expect.stringContaining("session is no longer available"), sseConnected: false,
    });
  });

  it.each(["done", "stopped"] as const)("preserves %s when not_found arrives before stream cleanup", (status) => {
    const { chat, conversation } = startChats("task");
    if (status === "done") {
      sockets[0].receive({ task_id: "task", index: 0, event: { type: "final_answer", text: "saved" } });
    } else {
      chat.cancel("task");
    }
    expect(conversation("task")?.status).toBe(status);

    reconnect().receive({ task_id: "task", type: "not_found" });

    expect(conversation("task")).toMatchObject({ status, error: null, sseConnected: false });
  });

  it("keeps the agent's error when its turn ends", () => {
    const { conversation } = startChats("task");
    sockets[0].receive({ task_id: "task", index: 0, event: { type: "error", message: "Query failed" } });
    sockets[0].receive({ task_id: "task", index: 1, event: { type: "done" } });

    expect(conversation("task")).toMatchObject({ status: "error", error: "Query failed", sseConnected: false });
  });

  it("uses the final HTTP snapshot if the socket drops before the done event", async () => {
    const { chat, conversation } = startChats("task");
    const events = [{ type: "final_answer", text: "The answer" }, { type: "done" }];
    vi.mocked(bff.turn).mockResolvedValueOnce({
      task_id: "task", session_id: "task", mode: "dbagent", response: "The answer", adk_available: true,
      state: { task_done: true, agent_events: events },
    });
    chat.sendMessage("task", "Query");
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(500);

    expect(sockets).toHaveLength(1);
    expect(conversation("task")).toMatchObject({ status: "done", rawEvents: events });
  });

  it("unsubscribes on the cancellation event and resumes after it for a follow-up", () => {
    const { chat, conversation } = startChats("task");
    chat.cancel("task");
    sockets[0].receive({ task_id: "task", index: 0, event: { type: "done" } });
    expect(conversation("task")?.status).toBe("stopped");
    expect(sockets[0].sent.at(-1)).toEqual({ op: "unsubscribe", task_id: "task" });

    chat.sendMessage("task", "Follow-up");
    sockets[1].open();
    expect(sockets[1].sent).toEqual([{ op: "subscribe", task_id: "task", after: 0 }]);
    sockets[0].receive({ task_id: "task", type: "not_found" });
    sockets[1].receive({ task_id: "task", index: 0, event: { type: "done" } });
    const message = { type: "user_message", text: "Follow-up" };
    sockets[1].receive({ task_id: "task", index: 1, event: message });
    expect(conversation("task")).toMatchObject({ status: "active", rawEvents: [{ type: "done" }, message] });
  });
});
