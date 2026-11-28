import { buildNodes, type ThreadNode } from "./buildNodes";
import type { Conversation } from "../state/types";

/** Per-field cap inside the branch context, and the cap for the whole context. */
export const BRANCH_FIELD_LIMIT = 2400;
export const BRANCH_CONTEXT_LIMIT = 14000;

export type BranchContextTarget = {
  parentThreadId: string;
  parentNodeId: string;
  label: string;
  /** The follow-up was started from the parent thread's Error card. */
  anchorError?: boolean;
};

export type BranchContextCard = {
  threadId: string;
  threadTitle: string;
  node: ThreadNode;
  /** 0-based position in its own thread, used for the [Card N] numbering. */
  indexInThread: number;
};

export function compactForBranchContext(text: string, limit = BRANCH_FIELD_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n...[truncated for branch context]`;
}

export function formatNodeForBranchContext(node: ThreadNode): string {
  const parts: string[] = [];
  switch (node.kind) {
    case "question":
      parts.push(`User: ${compactForBranchContext(node.body)}`);
      break;
    case "thinking":
      parts.push(`Assistant reasoning: ${compactForBranchContext(node.body, 1200)}`);
      break;
    case "tool":
      parts.push(`Tool call: ${node.title ?? "tool"}`);
      if (node.summary) parts.push(`Purpose: ${compactForBranchContext(node.summary, 800)}`);
      if (node.reasoning) parts.push(`Reasoning: ${compactForBranchContext(node.reasoning, 1000)}`);
      if (node.body) parts.push(`Input:\n${compactForBranchContext(node.body, 1400)}`);
      if (node.result !== undefined) parts.push(`Result:\n${compactForBranchContext(node.result)}`);
      break;
    case "agent_question":
      parts.push(`Assistant asked user: ${compactForBranchContext(node.body)}`);
      if (node.answer !== undefined) parts.push(`User answered: ${compactForBranchContext(node.answer)}`);
      break;
    case "user_answer":
      parts.push(`User answered: ${compactForBranchContext(node.body)}`);
      break;
    case "answer":
      parts.push("Assistant submitted final SQL:");
      if (node.body) parts.push(compactForBranchContext(node.body, 2000));
      if (node.result !== undefined) parts.push(`Execution result:\n${compactForBranchContext(node.result)}`);
      break;
    case "agent_text":
      parts.push(`Assistant: ${compactForBranchContext(node.body)}`);
      break;
  }
  return parts.join("\n");
}

/** Root-first chain of threads ending at the branch's parent thread. */
function ancestorChain(conversations: Conversation[], parentThreadId: string): Conversation[] {
  const byId = new Map(conversations.map((conv) => [conv.id, conv]));
  const chain: Conversation[] = [];
  const seen = new Set<string>();
  let current = byId.get(parentThreadId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined;
  }
  return chain;
}

/**
 * The cards a follow-up inherits, oldest first: each ancestor thread up to the
 * card its child branched from, then the parent thread up to the anchor card.
 * A cut point that no longer exists keeps that whole thread.
 */
export function branchContextCards(conversations: Conversation[], target: BranchContextTarget): BranchContextCard[] {
  const chain = ancestorChain(conversations, target.parentThreadId);
  return chain.flatMap((conv, index) => {
    const cutAt = index === chain.length - 1 ? target.parentNodeId : chain[index + 1].parentNodeId;
    const nodes = buildNodes(conv.timeline, conv.title);
    const end = cutAt ? nodes.findIndex((node) => node.id === cutAt) : -1;
    const included = end >= 0 ? nodes.slice(0, end + 1) : nodes;
    return included.map((node, indexInThread) => ({ threadId: conv.id, threadTitle: conv.title, node, indexInThread }));
  });
}

const TRUNCATION_SUFFIX = "\n...[truncated for branch context]";

function threadHeader(conv: Pick<Conversation, "id" | "database" | "title">): string {
  return [`Thread ${conv.id}`, `Database: ${conv.database}`, `Original user query: ${compactForBranchContext(conv.title)}`].join("\n");
}

function cardText(card: BranchContextCard): string {
  const { node } = card;
  return `\n[Card ${card.indexInThread + 1}: ${node.kind}${node.title ? `/${node.title}` : ""}]\n${formatNodeForBranchContext(node)}`;
}

/**
 * The parent_context sent with a follow-up. Always keeps the intro, the root
 * thread's header, the anchor card and (for an Error-card follow-up) the error
 * line; then adds earlier cards from the anchor backwards while they fit, and
 * replaces the rest with one "[N earlier cards omitted]" line.
 */
export function buildBranchParentContext(
  conversations: Conversation[],
  target?: BranchContextTarget | null,
  limit = BRANCH_CONTEXT_LIMIT,
): string | undefined {
  if (!target) return undefined;
  const cards = branchContextCards(conversations, target);
  if (cards.length === 0) return undefined;
  const byId = new Map(conversations.map((conv) => [conv.id, conv]));
  const parent = byId.get(target.parentThreadId);
  const intro = [
    "The new user message starts a branch from an existing canvas thread.",
    `Branch anchor: thread ${target.parentThreadId}, card ${target.parentNodeId} (${target.label}).`,
    "Treat the next user message as a follow-up question from that exact branch anchor, not as an unrelated new task. Use the compact parent-thread transcript below as prior conversation context. Continue from the branch anchor and preserve user intent, assumptions, SQL exploration, tool results, and clarifications. Re-fetch schema or knowledge if the compact context is insufficient.",
    "",
  ].join("\n");
  const errorLine = target.anchorError ? `Thread ended with error: ${compactForBranchContext(parent?.error ?? "error")}` : null;
  const texts = cards.map(cardText);
  const anchorIndex = cards.length - 1;

  const render = (firstKept: number, anchorText = texts[anchorIndex]): string => {
    const sections: string[][] = [];
    let currentThread: string | null = null;
    const pushHeader = (threadId: string) => {
      const conv = byId.get(threadId);
      sections.push([conv ? threadHeader(conv) : `Thread ${threadId}`]);
      currentThread = threadId;
    };
    pushHeader(cards[0].threadId);
    for (let i = firstKept; i <= anchorIndex; i++) {
      if (cards[i].threadId !== currentThread) pushHeader(cards[i].threadId);
      const section = sections[sections.length - 1];
      if (i === firstKept && firstKept > 0) section.push(`[${firstKept} earlier cards omitted]`);
      section.push(i === anchorIndex ? anchorText : texts[i]);
    }
    const body = sections.map((lines) => lines.join("\n")).join("\n\n---\n\n");
    return `${intro}\n${body}${errorLine ? `\n\n${errorLine}` : ""}`;
  };

  let firstKept = anchorIndex;
  while (firstKept > 0 && render(firstKept - 1).length <= limit) firstKept -= 1;

  let text = render(firstKept);
  if (text.length > limit) {
    const overhead = text.length - texts[anchorIndex].length;
    const room = Math.max(0, limit - overhead - TRUNCATION_SUFFIX.length);
    text = render(firstKept, compactForBranchContext(texts[anchorIndex], room));
    if (text.length > limit) text = text.slice(0, limit);
  }
  return text;
}
