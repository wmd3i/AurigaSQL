import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventSocket, eventSocketUrl } from "./eventSocket";

vi.mock("./client", () => ({ BFF_BASE: "http://127.0.0.1:6003" }));

class FakeSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

let sockets: FakeSocket[];
const make = () => new EventSocket("ws://x/ws", () => {
  const s = new FakeSocket();
  sockets.push(s);
  return s as unknown as WebSocket;
});

beforeEach(() => { sockets = []; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("EventSocket", () => {
  it("uses one socket for many tasks and routes events by task id", () => {
    const es = make();
    const a = vi.fn(), b = vi.fn();
    es.subscribe("A", { onEvent: a });
    es.subscribe("B", { onEvent: b });
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(sockets[0].sent).toEqual([
      { op: "subscribe", task_id: "A", after: -1 },
      { op: "subscribe", task_id: "B", after: -1 },
    ]);
    sockets[0].receive({ task_id: "B", index: 0, event: { type: "done" } });
    sockets[0].receive({ type: "ping" });
    expect(b).toHaveBeenCalledWith({ type: "done" }, 0);
    expect(a).not.toHaveBeenCalled();
  });

  it("reconnects and resumes each task after its last event, ignoring repeats", () => {
    const es = make();
    const a = vi.fn(), disconnect = vi.fn();
    es.subscribe("A", { onEvent: a, onDisconnect: disconnect });
    sockets[0].open();
    sockets[0].receive({ task_id: "A", index: 0, event: { type: "user_message", text: "hi" } });
    sockets[0].receive({ task_id: "A", index: 1, event: { type: "assistant_text", text: "x" } });
    sockets[0].drop();
    expect(disconnect).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent).toEqual([{ op: "subscribe", task_id: "A", after: 1 }]);
    sockets[1].receive({ task_id: "A", index: 1, event: { type: "assistant_text", text: "x" } });
    sockets[1].receive({ task_id: "A", index: 2, event: { type: "done" } });
    expect(a.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
  });

  it("reports unknown tasks and closes the socket when nothing is left", () => {
    const es = make();
    const notFound = vi.fn();
    es.subscribe("gone", { onEvent: vi.fn(), onNotFound: notFound });
    sockets[0].open();
    sockets[0].receive({ task_id: "gone", type: "not_found" });
    expect(notFound).toHaveBeenCalledOnce();
    expect(sockets[0].closed).toBe(true);
  });

  it("unsubscribes on close and keeps the socket for other tasks", () => {
    const es = make();
    const a = es.subscribe("A", { onEvent: vi.fn() });
    es.subscribe("B", { onEvent: vi.fn() });
    sockets[0].open();
    a.close();
    expect(sockets[0].sent.at(-1)).toEqual({ op: "unsubscribe", task_id: "A" });
    expect(sockets[0].closed).toBe(false);
  });

  it("builds the ws url from the backend base", () => {
    expect(eventSocketUrl("http://127.0.0.1:6003")).toBe("ws://127.0.0.1:6003/ws");
    expect(eventSocketUrl("https://api.example.com")).toBe("wss://api.example.com/ws");
  });
});
