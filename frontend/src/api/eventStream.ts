import { BFF_BASE } from "./client";
import type { AgentEvent, RawAgentEvent } from "../lib/buildTimeline";

export type StreamEvent = RawAgentEvent | { type: "pending_question"; text: string };

export type EventStreamHandle = { close: () => void };

function isStreamEvent(value: unknown): value is StreamEvent {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  if (type === "pending_question") {
    return typeof (value as { text?: unknown }).text === "string";
  }
  if (type === "clarification_request") {
    return typeof (value as AgentEvent & { question?: unknown }).question === "string";
  }
  return typeof type === "string";
}

export function openEventStream(
  taskId: string,
  onEvent: (evt: StreamEvent) => void,
  onError?: (e: Event) => void,
  onOpen?: () => void,
): EventStreamHandle {
  const es = new EventSource(`${BFF_BASE}/events/${encodeURIComponent(taskId)}`);
  es.onopen = () => onOpen?.();
  es.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data) as unknown;
      if (!isStreamEvent(parsed)) {
        console.warn("Ignoring unexpected SSE payload:", parsed);
        return;
      }
      onEvent(parsed);
    } catch (err) {
      console.warn("SSE parse failed:", err, e.data);
    }
  };
  es.onerror = (e) => {
    onError?.(e); // EventSource auto-reconnects; nothing else to do.
  };
  return { close: () => es.close() };
}
