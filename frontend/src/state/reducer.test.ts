import { describe, expect, it } from "vitest";
import { reducer } from "./reducer";
import { initialState, type AppState } from "./types";

const started: AppState = reducer(initialState, {
  type: "CONVERSATION_STARTED", id: "t1", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "agent",
});

describe("reducer", () => {
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

  it("SSE_EVENT pending_question sets pendingQuestion + waiting_user, not added to timeline", () => {
    const s = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "pending_question", text: "which year?" },
    });
    expect(s.conversations[0].pendingQuestion).toBe("which year?");
    expect(s.conversations[0].status).toBe("waiting_user");
    expect(s.conversations[0].timeline).toHaveLength(0);
  });

  it("SSE_EVENT clarification_request sets pendingQuestion + waiting_user", () => {
    const s = reducer(started, {
      type: "SSE_EVENT", id: "t1", event: { type: "clarification_request", question: "which year?" },
    });
    expect(s.conversations[0].pendingQuestion).toBe("which year?");
    expect(s.conversations[0].status).toBe("waiting_user");
    expect(s.conversations[0].timeline).toHaveLength(0);
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

  it("OPEN_CONVERSATION reopens a canvas thread on the canvas", () => {
    const ws = reducer(initialState, {
      type: "CONVERSATION_STARTED", id: "tw", database: "db1", databases: ["db1"], title: "q", createdAt: 1, mode: "workspace",
    });
    const home = reducer(ws, { type: "NEW_FLOW" });
    const s = reducer(home, { type: "OPEN_CONVERSATION", id: "tw" });
    expect(s.view).toBe("canvas");
    expect(s.activeId).toBe("tw");
  });

  it("OPEN_WORKSPACE opens an empty canvas for the selected database", () => {
    const s = reducer(started, { type: "OPEN_WORKSPACE", database: "db2" });
    expect(s.view).toBe("canvas");
    expect(s.activeId).toBeNull();
    expect(s.canvasDb).toBe("db2");
    expect(s.entryMode).toBe("workspace");
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
