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
