import { describe, expect, it } from "vitest";
import { collectNotices } from "./useCompletionNotifications";
import { notificationSnippet } from "../lib/notifications";
import type { Conversation, ConversationStatus } from "./types";

function conv(id: string, status: ConversationStatus, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, database: "db", databases: ["db"], mode: "agent", canvasWorkId: null,
    parentThreadId: null, parentNodeId: null, title: `Question ${id}`, summary: null,
    rawEvents: [], timeline: [], pendingQuestion: null, status, turnInFlight: false,
    sseConnected: true, error: null, createdAt: 0, ...extra,
  };
}

const offScreen = () => false;

describe("collectNotices", () => {
  it("announces a chat that finished while you were elsewhere", () => {
    const before = new Map<string, ConversationStatus>([["a", "active"]]);
    const notices = collectNotices(before, [conv("a", "done", { summary: "Top customers" })], offScreen, false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "done", title: "Top customers", body: "Answer ready" });
  });

  it("stays quiet for the chat on screen, unless the window is hidden", () => {
    const before = new Map<string, ConversationStatus>([["a", "active"]]);
    const now = [conv("a", "done")];
    expect(collectNotices(before, now, () => true, false)).toHaveLength(0);
    expect(collectNotices(before, now, () => true, true)).toHaveLength(1);
  });

  it("announces clarifying questions and errors, not user stops or old chats", () => {
    const before = new Map<string, ConversationStatus>([
      ["q", "active"], ["e", "starting"], ["s", "active"], ["old", "done"],
    ]);
    const notices = collectNotices(
      before,
      [
        conv("q", "waiting_user", { pendingQuestion: "Which **year**?" }),
        conv("e", "error", { error: "Model timed out" }),
        conv("s", "stopped"),
        conv("old", "done"),
        conv("new", "done"),
      ],
      offScreen,
      false,
    );
    expect(notices.map((n) => [n.conversation.id, n.kind, n.body])).toEqual([
      ["q", "question", "Which year?"],
      ["e", "error", "Model timed out"],
    ]);
  });
});

describe("notificationSnippet", () => {
  it("flattens markdown and truncates", () => {
    expect(notificationSnippet("## Result\n\nSee [docs](http://x) `now`")).toBe("Result See docs now");
    expect(notificationSnippet("x".repeat(200), 10)).toBe("xxxxxxxxx…");
  });
});
