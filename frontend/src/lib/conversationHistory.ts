import type { Conversation } from "../state/types";

export function conversationWorkId(conversations: Conversation[], conversation: Conversation): string {
  const byId = new Map(conversations.map((item) => [item.id, item]));
  let current = conversation;
  const seen = new Set<string>();
  while (!seen.has(current.id)) {
    if (current.canvasWorkId) return current.canvasWorkId;
    seen.add(current.id);
    const parent = current.parentThreadId ? byId.get(current.parentThreadId) : undefined;
    if (!parent) return current.parentThreadId ?? current.id;
    current = parent;
  }
  return conversation.id;
}

export function buildHistoryItems(conversations: Conversation[]) {
  const groups = new Map<string, Conversation[]>();
  conversations.forEach((conversation) => {
    const key = conversationWorkId(conversations, conversation);
    groups.set(key, [...(groups.get(key) ?? []), conversation]);
  });
  return [...groups.entries()].map(([key, group]) => {
    const oldestFirst = [...group].sort((a, b) => a.createdAt - b.createdAt);
    const newestFirst = [...oldestFirst].reverse();
    return {
      key,
      primary: oldestFirst.find((conversation) => !conversation.parentThreadId) ?? oldestFirst[0]!,
      latest: newestFirst[0]!,
      conversations: newestFirst,
      latestAt: newestFirst[0]!.createdAt,
    };
  }).sort((a, b) => b.latestAt - a.latestAt);
}
