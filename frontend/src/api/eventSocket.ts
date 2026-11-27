import { BFF_BASE } from "./client";
import { isStreamEvent, type EventStreamHandle, type StreamEvent } from "./eventStream";

/**
 * One WebSocket per tab carries the live events of every subscribed task.
 *
 * It replaces one EventSource per task: browsers allow only six HTTP/1.1
 * connections per host (shared by all tabs), so a handful of running chats
 * used to block every other request ("Request timed out after 20s").
 * WebSockets don't count toward that limit.
 *
 * On reconnect each task resubscribes from the last event index it received,
 * so nothing is lost or repeated.
 */

export type TaskStreamCallbacks = {
  onEvent: (event: StreamEvent, eventIndex: number) => void;
  /** The socket dropped; it reconnects on its own. */
  onDisconnect?: () => void;
  onConnect?: () => void;
  /** The backend has no such task (e.g. it restarted). The subscription is dropped. */
  onNotFound?: () => void;
};

type Subscription = TaskStreamCallbacks & { lastIndex: number };

type ServerMessage =
  | { task_id: string; index: number; event: unknown }
  | { task_id: string; type: "not_found" }
  | { type: "ping" };

const MAX_RETRY_MS = 10_000;
const OPEN = 1; // WebSocket.OPEN

export function eventSocketUrl(base = BFF_BASE): string {
  return `${base.replace(/^http/, "ws")}/ws`;
}

export class EventSocket {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Subscription>();
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly createSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  subscribe(taskId: string, callbacks: TaskStreamCallbacks): EventStreamHandle {
    const sub: Subscription = { ...callbacks, lastIndex: -1 };
    this.subs.set(taskId, sub);
    if (this.ws?.readyState === OPEN) {
      this.send({ op: "subscribe", task_id: taskId, after: sub.lastIndex });
      sub.onConnect?.();
    } else {
      this.connect();
    }
    return {
      close: () => {
        if (this.subs.get(taskId) !== sub) return;
        this.subs.delete(taskId);
        this.send({ op: "unsubscribe", task_id: taskId });
        if (this.subs.size === 0) this.shutdown();
      },
    };
  }

  private connect() {
    if (this.ws || this.retryTimer) return;
    const ws = this.createSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      for (const [taskId, sub] of this.subs) {
        this.send({ op: "subscribe", task_id: taskId, after: sub.lastIndex });
        sub.onConnect?.();
      }
    };
    ws.onmessage = (e) => this.handle(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.subs.forEach((sub) => sub.onDisconnect?.());
      if (this.subs.size === 0) return;
      const delay = Math.min(500 * 2 ** this.retries, MAX_RETRY_MS);
      this.retries += 1;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.subs.size > 0) this.connect();
      }, delay);
    };
  }

  private handle(raw: unknown) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || !("task_id" in msg)) return; // ping
    const sub = this.subs.get(msg.task_id);
    if (!sub) return;
    if ("type" in msg && msg.type === "not_found") {
      this.subs.delete(msg.task_id);
      sub.onNotFound?.();
      if (this.subs.size === 0) this.shutdown();
      return;
    }
    if (!("index" in msg) || typeof msg.index !== "number") return;
    if (msg.index <= sub.lastIndex) return;
    if (!isStreamEvent(msg.event)) {
      console.warn("Ignoring unexpected event payload:", msg.event);
      return;
    }
    sub.lastIndex = msg.index;
    sub.onEvent(msg.event, msg.index);
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  private shutdown() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

let shared: EventSocket | null = null;

/** Subscribe to one task's events over the tab's shared socket. */
export function openTaskStream(taskId: string, callbacks: TaskStreamCallbacks): EventStreamHandle {
  shared ??= new EventSocket(eventSocketUrl());
  return shared.subscribe(taskId, callbacks);
}
