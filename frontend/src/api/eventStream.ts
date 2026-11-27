import type { AgentEvent, RawAgentEvent } from "../lib/buildTimeline";

export type StreamEvent = RawAgentEvent | { type: "pending_question"; text: string };

export type EventStreamHandle = { close: () => void };

export function isStreamEvent(value: unknown): value is StreamEvent {
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
