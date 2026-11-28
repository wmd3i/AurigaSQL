import { describe, expect, it } from "vitest";
import { reducer } from "./reducer";
import { buildNodes } from "../lib/buildNodes";
import { initialState, type AppState } from "./types";

const started: AppState = reducer(initialState, {
  type: "CONVERSATION_STARTED", id: "t1", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "agent",
});

describe("reducer", () => {
  it("replaces a pending History entry atomically while preserving other pending questions", () => {
    let state = reducer(started, {
      type: "PENDING_CHAT_STARTED", chat: { id: "first", title: "First question", createdAt: 2 },
    });
    state = reducer(state, {
      type: "PENDING_CHAT_STARTED", chat: { id: "second", title: "Second question", createdAt: 3 },
    });
    state = reducer(state, { type: "NEW_FLOW" });
    state = reducer(state, { type: "PENDING_CHAT_DATABASE", id: "first", database: "db1" });
    expect(state.pendingChats).toHaveLength(2);
    state = reducer(state, {
      type: "CONVERSATION_STARTED", id: "created", pendingId: "first", background: true,
      title: "First question", database: "db1", databases: ["db1"], mode: "agent", createdAt: 99,
    });
    expect(state.pendingChats.map((chat) => chat.id)).toEqual(["second"]);
    expect(state.conversations.map((chat) => chat.id)).toEqual(["created", "t1"]);
    expect(state.conversations[0].createdAt).toBe(2);
    expect(state).toMatchObject({ view: "home", activeId: null });

    state = reducer(state, { type: "PENDING_CHAT_FINISHED", id: "first" });
    expect(state.pendingChats.map((chat) => chat.id)).toEqual(["second"]);
    state = reducer(state, { type: "PENDING_CHAT_FINISHED", id: "second" });
    expect(state.pendingChats).toEqual([]);
  });

  it("CONVERSATION_STARTED (agent) prepends conversation, activates it, lands on result page", () => {
    expect(started.view).toBe("result");
    expect(started.activeId).toBe("t1");
    expect(started.conversations[0]).toMatchObject({ id: "t1", mode: "agent", status: "starting", turnInFlight: false });
  });

  it("CONVERSATION_STARTED records branch parent metadata when forking from a card", () => {
    const s = reducer(initialState, {
      type: "CONVERSATION_STARTED",
      id: "tb",
      database: "db1",
      databases: ["db1"],
      title: "branch q",
      createdAt: 1,
      mode: "workspace",
      parentThreadId: "t1",
      parentNodeId: "n3",
    });
    expect(s.conversations[0]).toMatchObject({ parentThreadId: "t1", parentNodeId: "n3" });
  });

  it("LOCAL_BRANCH_STARTED creates a local canvas follow-up while the lightweight answer loads", () => {
    const s = reducer(initialState, {
      type: "LOCAL_BRANCH_STARTED",
      id: "local-1",
      database: "db1",
      databases: ["db1"],
      title: "check SNQI first",
      createdAt: 1,
      parentThreadId: "t1",
      parentNodeId: "n0",
    });
    expect(s.view).toBe("canvas");
    expect(s.activeId).toBe("local-1");
    expect(s.conversations[0]).toMatchObject({
      id: "local-1",
      mode: "workspace",
      parentThreadId: "t1",
      parentNodeId: "n0",
      status: "active",
      turnInFlight: true,
      rawEvents: [],
      timeline: [],
    });
  });

  it("LOCAL_BRANCH_ANSWERED completes a local branch with a final answer", () => {
    const loading = reducer(initialState, {
      type: "LOCAL_BRANCH_STARTED",
      id: "local-1",
      database: "db1",
      databases: ["db1"],
      title: "what does this mean?",
      createdAt: 1,
      parentThreadId: "t1",
      parentNodeId: "n0",
    });
    const s = reducer(loading, {
      type: "LOCAL_BRANCH_ANSWERED",
      id: "local-1",
      answer: "It means the clear-weather rows have the best SNQI.",
    });
    expect(s.conversations[0]).toMatchObject({
      status: "done",
      turnInFlight: false,
      error: null,
      timeline: [{ kind: "final", text: "It means the clear-weather rows have the best SNQI." }],
    });
  });

  it("CONVERSATION_STARTED (canvas) goes straight to canvas", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "workspace",
    });
    expect(ws.view).toBe("canvas");
  });

  it("CONVERSATION_STARTED can keep canvas focused on the new active thread", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED",
      id: "tw",
      database: "db1",
      databases: ["db1"],
      title: "q",
      createdAt: 1,
      mode: "workspace",
      canvasScope: "active",
    });
    expect(ws.view).toBe("canvas");
    expect(ws.canvasScope).toBe("active");
    expect(ws.activeId).toBe("tw");
  });

  it("CONVERSATION_STARTED can preserve the current view for embedded canvas runs", () => {
    const homeWorkspace = reducer(initialState, { type: "SET_ENTRY_MODE", mode: "workspace" });
    const ws = reducer(homeWorkspace, {
      type: "CONVERSATION_STARTED",
      id: "tw",
      database: "db1",
      databases: ["db1"],
      title: "q",
      createdAt: 1,
      mode: "workspace",
      preserveView: true,
    });
    expect(ws.view).toBe("home");
    expect(ws.entryMode).toBe("workspace");
    expect(ws.activeId).toBe("tw");
  });

  it("SSE_EVENT adk_event appends raw + rebuilds timeline + status active", () => {
    const s = reducer(started, {
      type: "SSE_EVENT", id: "t1",
      event: { type: "user_message", message: "hello" },
    });
    expect(s.conversations[0].rawEvents).toHaveLength(1);
    expect(s.conversations[0].timeline).toEqual([{ kind: "user_msg", text: "hello" }]);
    expect(s.conversations[0].status).toBe("active");
  });

  it("SSE_EVENT pending_question sets pendingQuestion + waiting_user and an answerable card", () => {
    const s = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "pending_question", text: "which year?" },
    });
    expect(s.conversations[0].pendingQuestion).toBe("which year?");
    expect(s.conversations[0].status).toBe("waiting_user");
    expect(buildNodes(s.conversations[0].timeline, "q").at(-1)).toMatchObject({ kind: "agent_question", body: "which year?" });
  });

  it("SSE_EVENT clarification_request sets pendingQuestion + waiting_user", () => {
    const s = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "clarification_request", question: "which year?" },
    });
    expect(s.conversations[0].pendingQuestion).toBe("which year?");
    expect(s.conversations[0].status).toBe("waiting_user");
    expect(buildNodes(s.conversations[0].timeline, "q").at(-1)).toMatchObject({ kind: "agent_question", body: "which year?" });
  });

  it("SSE_EVENT final_answer marks the conversation done without submit_sql", () => {
    const inFlight = reducer(started, { type: "TURN_SENT", id: "t1" });
    const s = reducer(inFlight, {
      type: "SSE_EVENT",
      id: "t1",
      event: { type: "final_answer", text: "```sql\nSELECT 1\n```", sql: "SELECT 1", result: "n\n-\n1" },
    });
    expect(s.conversations[0].status).toBe("done");
    expect(s.conversations[0].turnInFlight).toBe(false);
    expect(s.conversations[0].timeline.at(-1)).toMatchObject({ kind: "final_answer", sql: "SELECT 1" });
  });

  it("SSE_EVENT error marks the conversation error", () => {
    const inFlight = reducer(started, { type: "TURN_SENT", id: "t1" });
    const s = reducer(inFlight, {
      type: "SSE_EVENT",
      id: "t1",
      event: { type: "error", message: "boom" },
    });
    expect(s.conversations[0]).toMatchObject({ status: "error", error: "boom", turnInFlight: false });
  });

  it("ANSWER_SENT clears pendingQuestion, back to active", () => {
    const withQ = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "pending_question", text: "which year?" },
    });
    const s = reducer(withQ, { type: "ANSWER_SENT", id: "t1" });
    expect(s.conversations[0].pendingQuestion).toBeNull();
    expect(s.conversations[0].status).toBe("active");
  });

  it("TURN_SENT/TURN_DONE toggle turnInFlight", () => {
    const a = reducer(started, { type: "TURN_SENT", id: "t1" });
    expect(a.conversations[0].turnInFlight).toBe(true);
    const b = reducer(a, { type: "TURN_DONE", id: "t1" });
    expect(b.conversations[0].turnInFlight).toBe(false);
  });

  it("CONV_ERROR sets error + status error + clears turnInFlight", () => {
    const s = reducer(started, { type: "CONV_ERROR", id: "t1", message: "boom" });
    expect(s.conversations[0]).toMatchObject({ error: "boom", status: "error", turnInFlight: false });
  });

  it("NEW_FLOW returns to home keeping history", () => {
    const s = reducer(started, { type: "NEW_FLOW" });
    expect(s.view).toBe("home");
    expect(s.activeId).toBeNull();
    expect(s.conversations).toHaveLength(1);
  });

  it("START_OVER_WORKSPACE starts a fresh canvas work while keeping history", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "workspace", canvasWorkId: "work-1",
    });
    const s = reducer(ws, { type: "START_OVER_WORKSPACE", canvasWorkId: "work-2" });
    expect(s.view).toBe("home");
    expect(s.entryMode).toBe("workspace");
    expect(s.activeId).toBeNull();
    expect(s.currentCanvasWorkId).toBe("work-2");
    expect(s.conversations.map((conversation) => conversation.id)).toEqual(["tw"]);
  });

  it("START_OVER_WORKSPACE can keep a clean full canvas open", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "workspace", canvasWorkId: "work-1",
    });
    const s = reducer(ws, { type: "START_OVER_WORKSPACE", view: "canvas", canvasWorkId: "work-2" });
    expect(s.view).toBe("canvas");
    expect(s.entryMode).toBe("workspace");
    expect(s.activeId).toBeNull();
    expect(s.currentCanvasWorkId).toBe("work-2");
    expect(s.conversations.map((conversation) => conversation.id)).toEqual(["tw"]);
  });

  it("START_OVER_WORKSPACE keeps conversations from all canvas works", () => {
    const first = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw-1", database: "db1", databases: ["db1"], title: "q1", createdAt: 1, mode: "workspace", canvasWorkId: "work-1",
    });
    const second = reducer(first, {
      type: "CONVERSATION_STARTED", id: "tw-2", database: "db1", databases: ["db1"], title: "q2", createdAt: 2, mode: "workspace", canvasWorkId: "work-2",
    });
    const reopenedFirst = reducer(second, { type: "OPEN_CONVERSATION", id: "tw-1" });
    const cleared = reducer(reopenedFirst, {
      type: "START_OVER_WORKSPACE", view: "canvas", canvasWorkId: "work-3",
    });
    const chat = reducer(cleared, { type: "SET_ENTRY_MODE", mode: "agent" });
    const canvas = reducer(chat, { type: "SET_ENTRY_MODE", mode: "workspace" });

    expect(canvas.currentCanvasWorkId).toBe("work-3");
    expect(canvas.conversations.map((conversation) => conversation.id)).toEqual(["tw-2", "tw-1"]);
  });

  it("OPEN_CONVERSATION reopens an agent thread on its result page", () => {
    const home = reducer(started, { type: "NEW_FLOW" });
    const s = reducer(home, { type: "OPEN_CONVERSATION", id: "t1" });
    expect(s.view).toBe("result");
    expect(s.activeId).toBe("t1");
  });

  it("OPEN_CONVERSATION opens canvas history in the current Chat view", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "workspace",
    });
    const home = reducer(ws, { type: "NEW_FLOW" });
    const s = reducer(home, { type: "OPEN_CONVERSATION", id: "tw" });
    expect(s.view).toBe("result");
    expect(s.activeId).toBe("tw");
  });

  it("OPEN_WORKSPACE opens an empty canvas for the selected database", () => {
    const s = reducer(started, { type: "OPEN_WORKSPACE", database: "db2" });
    expect(s.view).toBe("canvas");
    expect(s.activeId).toBeNull();
    expect(s.canvasDb).toBe("db2");
    expect(s.entryMode).toBe("workspace");
  });

  it("switching Chat to Canvas and back keeps the same session and events", () => {
    const answered = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "final_answer", text: "SELECT 1", sql: "SELECT 1", result: "1" },
    });
    const canvas = reducer(answered, { type: "SET_VIEW", view: "canvas" });
    expect(canvas).toMatchObject({ view: "canvas", activeId: "t1", currentCanvasWorkId: "t1", canvasDb: "db1" });
    const chat = reducer(canvas, { type: "SET_VIEW", view: "result" });
    expect(chat).toMatchObject({ view: "result", activeId: "t1" });
    expect(chat.conversations).toBe(answered.conversations);
  });

  it("Canvas history can open a Chat session without changing its origin or duplicating it", () => {
    const canvas = reducer(started, { type: "START_OVER_WORKSPACE", view: "canvas", canvasWorkId: "empty" });
    const opened = reducer(canvas, { type: "OPEN_CONVERSATION", id: "t1" });
    expect(opened).toMatchObject({ view: "canvas", activeId: "t1", currentCanvasWorkId: "t1", canvasDb: "db1" });
    expect(opened.conversations).toBe(started.conversations);
    expect(opened.conversations[0].mode).toBe("agent");
  });

  it("Chat can select a Canvas branch and return to the same work without losing its siblings", () => {
    const root = reducer(started, {
      type: "CONVERSATION_STARTED", id: "root", database: "db2", databases: ["db2"], title: "root", createdAt: 2,
      mode: "workspace", canvasWorkId: "work",
    });
    const branch = reducer(root, {
      type: "CONVERSATION_STARTED", id: "fork", database: "db2", databases: ["db2"], title: "fork", createdAt: 3,
      mode: "workspace", canvasWorkId: "work", parentThreadId: "root", parentNodeId: "n0", canvasBranchSide: "right",
    });
    const chat = reducer(branch, { type: "OPEN_CONVERSATION", id: "fork", view: "result" });
    expect(chat).toMatchObject({ view: "result", activeId: "fork", currentCanvasWorkId: "work" });
    const selectedRoot = reducer(chat, { type: "OPEN_CONVERSATION", id: "root" });
    const canvas = reducer(selectedRoot, { type: "SET_VIEW", view: "canvas" });
    expect(canvas).toMatchObject({ view: "canvas", activeId: "root", currentCanvasWorkId: "work" });
    expect(canvas.conversations).toBe(branch.conversations);
  });

  it("deleting the active history entry preserves the display mode of the next entry", () => {
    const workspace = reducer(started, {
      type: "CONVERSATION_STARTED", id: "workspace", database: "db2", databases: ["db2"], title: "q2", createdAt: 2,
      mode: "workspace", canvasWorkId: "work",
    });
    const canvas = reducer(workspace, { type: "DELETE_CONVERSATION", id: "workspace" });
    expect(canvas).toMatchObject({ view: "canvas", activeId: "t1", currentCanvasWorkId: "t1" });
    const chat = reducer(workspace, { type: "OPEN_CONVERSATION", id: "t1", view: "result" });
    const remaining = reducer(chat, { type: "DELETE_CONVERSATION", id: "t1" });
    expect(remaining).toMatchObject({ view: "result", activeId: "workspace" });
    expect(remaining.conversations.map((c) => c.id)).toEqual(["workspace"]);
  });

  it("OPEN_WORKSPACE can preserve the active workspace thread when expanding embedded canvas", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "workspace",
      preserveView: true,
    });
    const s = reducer(ws, { type: "OPEN_WORKSPACE", database: "db1", preserveActiveThread: true });
    expect(s.view).toBe("canvas");
    expect(s.activeId).toBe("tw");
    expect(s.canvasDb).toBe("db1");
  });

  it("OPEN_WORKSPACE shows the active Chat thread, or restores the last canvas when home is empty", () => {
    const workspace = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1,
      mode: "workspace", canvasWorkId: "work-1",
    });
    const home = reducer(workspace, { type: "NEW_FLOW" });
    const chat = reducer(home, {
      type: "CONVERSATION_STARTED", id: "chat", database: "db2", databases: ["db2"], title: "chat", createdAt: 2,
      mode: "agent",
    });
    for (const previous of [home, chat]) {
      const reopened = reducer(previous, { type: "OPEN_WORKSPACE", database: "Canvas", preserveActiveThread: true });
      expect(reopened.view).toBe("canvas");
      expect(reopened.activeId).toBe(previous === chat ? "chat" : "tw");
      expect(reopened.currentCanvasWorkId).toBe(previous === chat ? "chat" : "work-1");
      expect(reopened.conversations).toEqual(previous.conversations);
    }
  });

  it("OPEN_WORKSPACE does not restore a different work after starting over", () => {
    const workspace = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1,
      mode: "workspace", canvasWorkId: "work-1",
    });
    const cleared = reducer(workspace, { type: "START_OVER_WORKSPACE", canvasWorkId: "work-2" });
    const reopened = reducer(cleared, { type: "OPEN_WORKSPACE", database: "db2", preserveActiveThread: true });
    expect(reopened.activeId).toBeNull();
    expect(reopened.currentCanvasWorkId).toBe("work-2");
    expect(reopened.canvasDb).toBe("db2");
  });

  it("OPEN_WORKSPACE_SETUP opens the data-engine setup page without changing the flow mode", () => {
    const s = reducer(started, { type: "OPEN_WORKSPACE_SETUP" });
    expect(s.view).toBe("workspace_setup");
    expect(s.activeId).toBeNull();
    expect(s.entryMode).toBe("agent");
  });

  it("SET_VIEW back to home preserves workspace entry mode after data setup", () => {
    const workspace = reducer(initialState, { type: "SET_ENTRY_MODE", mode: "workspace" });
    const setup = reducer(workspace, { type: "OPEN_WORKSPACE_SETUP" });
    const back = reducer(setup, { type: "SET_VIEW", view: "home" });
    expect(back.view).toBe("home");
    expect(back.entryMode).toBe("workspace");
  });

  it("SET_VIEW switches the active view (Show process / back to result)", () => {
    const s = reducer(started, { type: "SET_VIEW", view: "canvas" });
    expect(s.view).toBe("canvas");
  });

  it("SET_VIEW to canvas can scope the canvas to the active thread", () => {
    const second = reducer(started, {
      type: "CONVERSATION_STARTED", id: "t2", database: "db1", databases: ["db1"], title: "q2", createdAt: 2, mode: "agent",
    });
    const s = reducer(second, { type: "SET_VIEW", view: "canvas", canvasScope: "active" });
    expect(s.view).toBe("canvas");
    expect(s.canvasScope).toBe("active");
    expect(s.activeId).toBe("t2");
  });

  it("SSE_EVENT with submit_sql function_call marks conversation done", () => {
    const s = reducer(started, {
      type: "SSE_EVENT", id: "t1",
      event: {
        type: "adk_event",
        content: { role: "model", parts: [{ type: "function_call", name: "submit_sql", args: { sql: "SELECT 1" } }] },
      },
    });
    expect(s.conversations[0].status).toBe("done");
  });

  it("SSE_EVENT with submit_sql clears the in-flight turn immediately", () => {
    const running = reducer(started, { type: "TURN_SENT", id: "t1" });
    const s = reducer(running, {
      type: "SSE_EVENT",
      id: "t1",
      event: {
        type: "adk_event",
        content: { role: "model", parts: [{ type: "function_call", name: "submit_sql", args: { sql: "SELECT 1" } }] },
      },
    });
    expect(s.conversations[0]).toMatchObject({ status: "done", turnInFlight: false });
  });

  it("CONVERSATION_STARTED keeps long titles verbatim (echo dedupe relies on exact match)", () => {
    const longTitle = "x".repeat(100);
    const s = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "t9", database: "db1", databases: ["db1"], title: longTitle, createdAt: 1, mode: "workspace",
    });
    expect(s.conversations[0].title).toBe(longTitle);
  });

  it("CONVERSATION_STARTED records the canvas database (first thread wins)", () => {
    expect(started.canvasDb).toBe("db1");
    const second = reducer(started, {
      type: "CONVERSATION_STARTED", id: "t2", database: "db1", databases: ["db1"], title: "q2", createdAt: 2, mode: "agent",
    });
    expect(second.canvasDb).toBe("db1");
  });

  it("workspace conversations keep the canvas in all-threads mode", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "workspace",
    });
    expect(ws.canvasScope).toBe("all");
  });

  it("SET_ENTRY_MODE updates the selected homepage mode", () => {
    const s = reducer(initialState, { type: "SET_ENTRY_MODE", mode: "workspace" });
    expect(s.entryMode).toBe("workspace");
  });

  it("SET_ENTRY_MODE keeps the user on the current page instead of opening the real canvas", () => {
    const s = reducer(initialState, { type: "SET_ENTRY_MODE", mode: "workspace" });
    expect(s.view).toBe("home");
    expect(s.activeId).toBeNull();
    expect(s.canvasDb).toBeNull();
  });

  it("pending_question sets answerTarget to that conversation (most recent default)", () => {
    const s = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "pending_question", text: "which year?" },
    });
    expect(s.answerTarget).toBe("t1");
  });

  it("SET_ANSWER_TARGET switches the target", () => {
    const s = reducer(started, { type: "SET_ANSWER_TARGET", id: null });
    expect(s.answerTarget).toBeNull();
  });

  it("ANSWER_SENT clears answerTarget when it pointed at that conversation", () => {
    const withQ = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "pending_question", text: "which year?" },
    });
    const s = reducer(withQ, { type: "ANSWER_SENT", id: "t1" });
    expect(s.answerTarget).toBeNull();
  });

  it("done is sticky: later events (e.g. submit_sql tool response) keep status done", () => {
    const done = reducer(started, {
      type: "SSE_EVENT", id: "t1",
      event: {
        type: "adk_event",
        content: { role: "model", parts: [{ type: "function_call", name: "submit_sql", args: { sql: "SELECT 1" } }] },
      },
    });
    const s = reducer(done, {
      type: "SSE_EVENT", id: "t1",
      event: {
        type: "adk_event",
        content: { role: "tool", parts: [{ type: "function_response", name: "submit_sql", response: "SQL submitted" }] },
      },
    });
    expect(s.conversations[0].status).toBe("done");
  });

  it("DELETE_CONVERSATION removes the thread from history", () => {
    const second = reducer(started, {
      type: "CONVERSATION_STARTED", id: "t2", database: "db1", databases: ["db1"], title: "q2", createdAt: 2, mode: "agent",
    });
    const s = reducer(second, { type: "DELETE_CONVERSATION", id: "t1" });
    expect(s.conversations.map((c) => c.id)).toEqual(["t2"]);
  });

  it("DELETE_CONVERSATION falls back to home when the last thread is removed", () => {
    const s = reducer(started, { type: "DELETE_CONVERSATION", id: "t1" });
    expect(s.conversations).toHaveLength(0);
    expect(s.activeId).toBeNull();
    expect(s.view).toBe("home");
  });
});


describe("clarification lifecycle", () => {
  it("keeps waiting across progress events and resumes on an accepted answer", () => {
    let s = reducer(started, { type: "TURN_SENT", id: "t1" });
    s = reducer(s, { type: "SSE_EVENT", id: "t1", event: { type: "clarification_request", question: "Which drivers?" } });
    s = reducer(s, { type: "SSE_EVENT", id: "t1", event: { type: "assistant_text", text: "Checking" } });
    expect(s.conversations[0].status).toBe("waiting_user");
    s = reducer(s, { type: "SSE_EVENT", id: "t1", event: { type: "clarification_answer", answer: "All drivers" } });
    expect(s.conversations[0].pendingQuestion).toBeNull();
    expect(s.conversations[0].status).toBe("active");
    expect(buildNodes(s.conversations[0].timeline, "q").find((n) => n.kind === "agent_question"))
      .toMatchObject({ body: "Which drivers?", answer: "All drivers" });
  });

  it("restores a waiting question from a snapshot even when event count is unchanged", () => {
    const events = [{ type: "user_message" as const, text: "q" }];
    let s = reducer(started, { type: "SYNC_AGENT_EVENTS", id: "t1", events });
    s = reducer(s, { type: "SYNC_SESSION_STATE", id: "t1", state: {
      agent_events: events, execution_status: "waiting_user", pending_question: "Which drivers?", task_done: false,
    } });
    expect(s.conversations[0]).toMatchObject({ status: "waiting_user", pendingQuestion: "Which drivers?", turnInFlight: true });
    expect(s.answerTarget).toBe("t1");
    s = reducer(s, { type: "SYNC_SESSION_STATE", id: "t1", state: {
      agent_events: events, execution_status: "done", pending_question: null, task_done: true,
    } });
    expect(s.conversations[0]).toMatchObject({ status: "done", pendingQuestion: null, turnInFlight: false });
    expect(s.answerTarget).toBeNull();
  });

  it("ignores a stale HTTP snapshot behind the SSE stream", () => {
    const s = reducer(started, { type: "SSE_EVENT", id: "t1", event: { type: "clarification_request", question: "Which?" } });
    const restored = reducer(s, { type: "SYNC_SESSION_STATE", id: "t1", state: { agent_events: [], task_done: true } });
    expect(restored.conversations[0].status).toBe("waiting_user");
  });
});


it("does not duplicate restored cards when EventSource replays its backlog", () => {
  const events = [
    { type: "user_message" as const, text: "q" },
    { type: "clarification_request" as const, question: "Which?" },
  ];
  let s = reducer(started, { type: "SYNC_SESSION_STATE", id: "t1", state: {
    agent_events: events, pending_question: "Which?", execution_status: "waiting_user",
  } });
  for (const [eventIndex, event] of events.entries()) {
    s = reducer(s, { type: "SSE_EVENT", id: "t1", event, eventIndex });
  }
  expect(s.conversations[0].rawEvents).toHaveLength(2);
  expect(buildNodes(s.conversations[0].timeline, "q").filter((n) => n.kind === "question")).toHaveLength(1);
  expect(s.conversations[0].pendingQuestion).toBe("Which?");
});


it("keeps an in-flight start visible when its initial session probe returns idle", () => {
  let s = reducer(started, { type: "TURN_SENT", id: "t1" });
  s = reducer(s, { type: "SYNC_SESSION_STATE", id: "t1", state: {
    agent_events: [], execution_status: "idle", task_done: false,
  } });
  expect(s.conversations[0].turnInFlight).toBe(true);
  s = reducer(s, { type: "SSE_EVENT", id: "t1", event: { type: "runtime_status", status: "running" } });
  expect(s.conversations[0]).toMatchObject({ status: "active", turnInFlight: true });
});
