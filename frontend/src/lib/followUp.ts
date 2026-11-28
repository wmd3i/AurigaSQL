import type { ConversationStatus } from "../state/types";

/** The fields of a canvas card that decide whether it can start a follow-up. */
export type FollowUpCard = { kind: string; result?: string; answer?: string };
export type FollowUpSides = { left: boolean; right: boolean; below: boolean };

const TERMINAL_STATUSES: ConversationStatus[] = ["done", "stopped", "error"];

/**
 * Cards with complete content can start a follow-up. Work still in progress
 * (a running tool, an unanswered clarification), thinking, placeholders and
 * the tool-group card itself (its tools are followed up one by one) cannot.
 */
export function canFollowUp(card: FollowUpCard): boolean {
  switch (card.kind) {
    case "question":
    case "answer":
    case "agent_text":
    case "error":
      return true;
    case "tool":
      return card.result !== undefined;
    case "agent_question":
      return card.answer !== undefined;
    default:
      return false;
  }
}

/** Which plus buttons a card shows. The bottom one only continues a finished thread downwards, once. */
export function followUpSides(input: {
  card: FollowUpCard;
  status: ConversationStatus;
  isLastCard: boolean;
  hasBelowBranch: boolean;
  hasBelowDraft: boolean;
}): FollowUpSides {
  if (!canFollowUp(input.card)) return { left: false, right: false, below: false };
  const below =
    input.isLastCard && TERMINAL_STATUSES.includes(input.status) && !input.hasBelowBranch && !input.hasBelowDraft;
  return { left: true, right: true, below };
}

