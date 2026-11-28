import { stripSystemNote } from "./stripSystemNote";

export type TimelineEvent =
  | { kind: "user_msg"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; id?: string }
  | { kind: "tool_response"; name: string; response: string; id?: string }
  | { kind: "final"; text: string }
  | { kind: "final_answer"; text: string; sql?: string | null; result?: string | null };

type AdkPart =
  | { type: "text"; text: string }
  | { type: "function_call"; name: string; id?: string; args: Record<string, unknown> }
  | { type: "function_response"; name: string; id?: string; response: unknown };

export type AdkEvent =
  | { type: "user_message"; message: string }
  | {
      type: "adk_event";
      author?: string;
      final?: boolean;
      content?: { role?: string; parts?: AdkPart[] };
    };

export type AgentEvent =
  | { type: "user_message"; text: string; message?: string }
  | { type: "assistant_text"; text: string; final?: boolean }
  | { type: "tool_call"; id?: string; name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; id?: string; name: string; result: unknown }
  | { type: "clarification_request"; question: string }
  | { type: "clarification_answer"; answer: string }
  | { type: "runtime_status"; status: "running" | "waiting_user" }
  | { type: "final_answer"; text?: string; sql?: string | null; result?: string | null }
  | { type: "error"; message: string }
  | { type: "done" };

export type RawAgentEvent = AdkEvent | AgentEvent;

function isAdkWrapperEvent(e: RawAgentEvent): e is Extract<AdkEvent, { type: "adk_event" }> {
  return e.type === "adk_event";
}

export function buildTimeline(events: RawAgentEvent[] | undefined | null): TimelineEvent[] {
  if (!events || events.length === 0) return [];
  const timeline: TimelineEvent[] = [];

  const bridgedQuestions: string[] = [];
  const bridgedCallIds = new Set<string>();
  for (const e of events) {
    if (e.type === "clarification_request") {
      const lastAsk = [...timeline].reverse().find((item) =>
        item.kind === "tool_call" && (item.name === "ask" || item.name === "ask_user"));
      const lastAnswer = [...timeline].reverse().find((item) =>
        item.kind === "tool_response" && (item.name === "ask" || item.name === "ask_user"));
      if (!lastAsk || lastAsk.kind !== "tool_call" || lastAsk.args.question !== e.question ||
          (lastAnswer && timeline.indexOf(lastAnswer) > timeline.indexOf(lastAsk))) {
        timeline.push({ kind: "tool_call", name: "ask_user", args: { question: e.question } });
        bridgedQuestions.push(e.question);
      }
      continue;
    }
    if (e.type === "clarification_answer") {
      timeline.push({ kind: "tool_response", name: "ask_user", response: e.answer });
      continue;
    }
    if (e.type === "user_message") {
      timeline.push({ kind: "user_msg", text: "text" in e ? e.text : e.message ?? "" });
      continue;
    }
    if (!isAdkWrapperEvent(e)) {
      if (e.type === "assistant_text") {
        const text = (e.text ?? "").trim();
        if (text) timeline.push(e.final ? { kind: "final", text } : { kind: "thinking", text });
      } else if (e.type === "tool_call") {
        // The IPC bridge publishes ask immediately; the agent trajectory may
        // replay the same call later. Keep one question and one answer.
        const bridged = (e.name === "ask" || e.name === "ask_user")
          ? bridgedQuestions.indexOf(String(e.args?.question ?? "")) : -1;
        if (bridged >= 0) {
          bridgedQuestions.splice(bridged, 1);
          if (e.id) bridgedCallIds.add(e.id);
          continue;
        }
        timeline.push({ kind: "tool_call", name: e.name ?? "?", args: e.args ?? {}, id: e.id });
      } else if (e.type === "tool_result") {
        if (e.id && bridgedCallIds.has(e.id)) continue;
        if (e.name === "ask" || e.name === "ask_user") {
          const previous = [...timeline].reverse().find((item) =>
            (item.kind === "tool_call" || item.kind === "tool_response") &&
            (item.name === "ask" || item.name === "ask_user"));
          if (previous?.kind === "tool_response") continue;
        }
        const result = e.result;
        timeline.push({
          kind: "tool_response",
          name: e.name ?? "?",
          response: stripSystemNote(typeof result === "string" ? result : JSON.stringify(result)),
          id: e.id,
        });
      } else if (e.type === "final_answer") {
        timeline.push({
          kind: "final_answer",
          text: e.text ?? "",
          sql: e.sql ?? null,
          result: e.result ?? null,
        });
      } else if (e.type === "error") {
        timeline.push({ kind: "final", text: e.message });
      }
      continue;
    }

    const content = e.content ?? {};
    const role = content.role ?? "";
    const parts = content.parts ?? [];

    for (const part of parts) {
      if (part.type === "text" && role === "model" && !e.final) {
        const text = (part.text ?? "").trim();
        if (text) timeline.push({ kind: "thinking", text });
      } else if (part.type === "function_call") {
        timeline.push({ kind: "tool_call", name: part.name ?? "?", args: part.args ?? {}, id: part.id });
      } else if (part.type === "function_response") {
        const resp = part.response as unknown;
        timeline.push({
          kind: "tool_response",
          name: part.name ?? "?",
          response: stripSystemNote(typeof resp === "string" ? resp : JSON.stringify(resp)),
          id: part.id,
        });
      }
    }

    if (e.final && role === "model") {
      const finalText = parts
        .filter((p): p is Extract<AdkPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text ?? "")
        .filter((t) => t.trim())
        .join("\n");
      if (finalText) timeline.push({ kind: "final", text: finalText });
    }
  }
  return timeline;
}
