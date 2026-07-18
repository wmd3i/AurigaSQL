import type { Conversation } from "../state/types";
import { buildNodes, type ThreadNode } from "./buildNodes";
import { stripSystemNote } from "./stripSystemNote";

/**
 * Splits a conversation into Q&A rounds for the transcript view. Each follow-up
 * user message starts a new round (buildNodes emits it as a "question" node),
 * so the page can keep every prior question + its products instead of letting
 * the latest answer overwrite the earlier ones.
 */
export type RoundClarification = { q: string; a: string | null };

export type Round = {
  index: number;
  question: string;
  answerText: string | null;
  sql: string | null;
  result: string | null;
  clarifications: RoundClarification[];
};

function lastWhere(nodes: ThreadNode[], pred: (n: ThreadNode) => boolean): ThreadNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) if (pred(nodes[i])) return nodes[i];
  return null;
}

function isSqlExecutionNode(n: ThreadNode): boolean {
  return n.kind === "tool" && (n.title === "execute_sql" || n.title === "run_postgres_readonly");
}

function distil(question: string, index: number, nodes: ThreadNode[]): Round {
  const answerNode = lastWhere(nodes, (n) => n.kind === "answer");
  const lastText = lastWhere(nodes, (n) => n.kind === "agent_text");
  const execSql = lastWhere(nodes, (n) => isSqlExecutionNode(n) && n.body.trim() !== "");
  const execRes = lastWhere(nodes, (n) => isSqlExecutionNode(n) && n.result !== undefined);

  const sql = answerNode?.body ?? execSql?.body ?? null;
  const rawResult = answerNode?.result ?? execRes?.result ?? null;
  const result = rawResult ? stripSystemNote(rawResult) : null;

  const clarifications: RoundClarification[] = [];
  for (const n of nodes) {
    if (n.kind === "agent_question") clarifications.push({ q: n.body, a: n.answer ?? null });
    else if (n.kind === "user_answer") {
      const open = [...clarifications].reverse().find((c) => c.a === null);
      if (open) open.a = n.body;
    }
  }

  return {
    index,
    question,
    answerText: lastText?.body ?? null,
    sql: sql && sql.trim() ? sql : null,
    result: result && result.trim() ? result : null,
    clarifications,
  };
}

export function buildRounds(conv: Conversation): Round[] {
  const nodes = buildNodes(conv.timeline, conv.title);
  const rounds: Round[] = [];
  let question: string | null = null;
  let bucket: ThreadNode[] = [];

  const flush = () => {
    if (question !== null) rounds.push(distil(question, rounds.length, bucket));
  };

  for (const n of nodes) {
    if (n.kind === "question") {
      flush();
      question = n.body;
      bucket = [];
    } else {
      bucket.push(n);
    }
  }
  flush();

  // Defensive: a conversation always has at least the root question.
  if (rounds.length === 0) rounds.push(distil(conv.title, 0, []));
  return rounds;
}
