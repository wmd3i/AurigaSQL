import { describe, expect, it } from "vitest";
import { reducer } from "../state/reducer";
import { initialState, type Conversation } from "../state/types";
import { buildHistoryItems, conversationWorkId } from "./conversationHistory";

const root = reducer(initialState, {
  type: "CONVERSATION_STARTED", id: "chat", database: "db", databases: ["db"], title: "Chat question", createdAt: 1, mode: "agent",
}).conversations[0];

function conversation(overrides: Partial<Conversation>): Conversation {
  return { ...root, ...overrides };
}

describe("shared conversation history", () => {
  it("groups branches from Chat and Canvas origins together and sorts works by latest activity", () => {
    const canvas = conversation({ id: "canvas", mode: "workspace", canvasWorkId: "work", createdAt: 2 });
    const branch = conversation({ id: "branch", mode: "workspace", canvasWorkId: "chat", parentThreadId: "chat", createdAt: 3 });
    const items = buildHistoryItems([branch, canvas, root]);
    expect(items.map((item) => item.key)).toEqual(["chat", "work"]);
    expect(items[0].primary.id).toBe("chat");
    expect(items[0].latest.id).toBe("branch");
    expect(items[0].conversations.map((item) => item.id)).toEqual(["branch", "chat"]);
    expect(items[0].conversations[1]).toBe(root);
  });

  it("restores legacy branches without a work id using their ancestor's work", () => {
    const parent = conversation({ id: "parent", mode: "workspace", canvasWorkId: "work" });
    const child = conversation({ id: "child", canvasWorkId: null, parentThreadId: "parent" });
    const grandchild = conversation({ id: "grandchild", canvasWorkId: null, parentThreadId: "child" });
    expect(conversationWorkId([grandchild, child, parent], grandchild)).toBe("work");
  });

  it("keeps independent roots together when they share a canvas, regardless of origin", () => {
    const a = conversation({ id: "a", canvasWorkId: "work" });
    const b = conversation({ id: "b", mode: "workspace", canvasWorkId: "work" });
    expect(buildHistoryItems([a, b])).toHaveLength(1);
    expect(buildHistoryItems([a, b])[0].conversations).toHaveLength(2);
  });

  it("handles missing parents and cyclic legacy data without dropping history", () => {
    const orphan = conversation({ id: "orphan", parentThreadId: "missing" });
    expect(conversationWorkId([orphan], orphan)).toBe("missing");
    const a = conversation({ id: "a", parentThreadId: "b" });
    const b = conversation({ id: "b", parentThreadId: "a" });
    expect(buildHistoryItems([a, b]).flatMap((item) => item.conversations)).toHaveLength(2);
  });
});
