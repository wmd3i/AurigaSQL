import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { extractAgentResult } from "../lib/extractAgentResult";
import { notificationSnippet, showDesktopNotification } from "../lib/notifications";
import type { Conversation, ConversationStatus } from "./types";

const RUNNING: ConversationStatus[] = ["starting", "active"];

type Notice = { kind: "done" | "question" | "error"; body: string };

function noticeFor(conversation: Conversation): Notice | null {
  switch (conversation.status) {
    case "done": {
      const result = extractAgentResult(conversation);
      return { kind: "done", body: notificationSnippet(result.answerText) || "Answer ready" };
    }
    case "waiting_user":
      return { kind: "question", body: notificationSnippet(conversation.pendingQuestion) || "The agent has a question for you" };
    case "error":
      return { kind: "error", body: notificationSnippet(conversation.error) || "Something went wrong" };
    default:
      return null;
  }
}

export type ChatNotice = Notice & { conversation: Conversation; title: string };

/** Chats that just left a running state and that you aren't looking at. */
export function collectNotices(
  before: Map<string, ConversationStatus>,
  conversations: Conversation[],
  isOnScreen: (conversation: Conversation) => boolean,
  windowHidden: boolean,
): ChatNotice[] {
  const notices: ChatNotice[] = [];
  for (const conversation of conversations) {
    const was = before.get(conversation.id);
    if (!was || !RUNNING.includes(was) || RUNNING.includes(conversation.status)) continue;
    if (!windowHidden && isOnScreen(conversation)) continue;
    const notice = noticeFor(conversation);
    if (notice) notices.push({ ...notice, conversation, title: conversation.summary || conversation.title });
  }
  return notices;
}

/**
 * Like Open WebUI: when a chat finishes (or stops to ask a question) while
 * you're looking at another chat or another app, show a toast you can click
 * to jump to it. When the window is in the background and desktop
 * notifications are on, also send an OS notification.
 */
export function useCompletionNotifications(
  conversations: Conversation[],
  isOnScreen: (conversation: Conversation) => boolean,
  onOpen: (conversation: Conversation) => void,
) {
  const previous = useRef<Map<string, ConversationStatus> | null>(null);
  const latest = useRef({ isOnScreen, onOpen });
  latest.current = { isOnScreen, onOpen };

  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(conversations.map((c) => [c.id, c.status]));
    // First run (page load): remember statuses without announcing anything.
    if (!before) return;

    const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
    for (const notice of collectNotices(before, conversations, latest.current.isOnScreen, hidden)) {
      const open = () => latest.current.onOpen(notice.conversation);
      const options = {
        id: `chat-notice-${notice.conversation.id}`,
        description: notice.body,
        duration: 8000,
        action: { label: "Open", onClick: open },
      };
      if (notice.kind === "error") toast.error(notice.title, options);
      else if (notice.kind === "question") toast.info(notice.title, options);
      else toast.success(notice.title, options);

      if (hidden) showDesktopNotification(notice.title, notice.body, open);
    }
  }, [conversations]);
}
