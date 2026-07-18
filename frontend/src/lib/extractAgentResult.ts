import type { Conversation } from "../state/types";
import { buildNodes, type ThreadNode } from "./buildNodes";
import { stripSystemNote } from "./stripSystemNote";
import { humanizeToolName } from "./toolLabels";

/**
 * Distils a conversation's process timeline into the answer-first shape the
 * Agent result page renders. The canvas still owns the full step-by-step view;
 * this picks out only the "products": the natural-language answer, the
 * submitted SQL, and the executed result table.
 *
 * - `answerText`: the agent's last free-text reply (final NL answer / summary).
 * - `sql`: the submitted SQL (terminal "answer" node), or the most recent
 *   executed SQL as a fallback while the turn is still running.
 * - `result`: the result text attached to the submitted SQL, or the latest
 *   execute_sql output when nothing has been submitted yet.
 * - `steps`: number of reasoning/tool nodes — the size of the hidden process.
 */
export type AgentResult = {
  answerText: string | null;
  sql: string | null;
  result: string | null;
  steps: number;
  currentStep: string | null; // human label of the latest reasoning/tool step (live progress)
};

/** Friendly, present-tense labels for the live "what's happening now" line. */
const STEP_LABELS: Record<string, string> = {
  get_schema: "Reading the schema",
  list_sqlite_tables: "Reading the schema",
  list_duckdb_tables: "Reading the schema",
  list_postgres_tables: "Reading the schema",
  describe_postgres_table: "Reading the schema",
  execute_sql: "Running SQL",
  run_sqlite_readonly: "Running SQL",
  run_duckdb_readonly: "Running SQL",
  run_postgres_readonly: "Running SQL",
  explain_sqlite_query: "Explaining SQL",
  explain_postgres_query: "Explaining SQL",
  sample_sqlite_rows: "Sampling rows",
  sample_duckdb_rows: "Sampling rows",
  sample_postgres_rows: "Sampling rows",
  validate_sql: "Validating SQL",
  validate_sqlite_query: "Validating SQL",
  validate_duckdb_query: "Validating SQL",
  validate_postgres_query: "Validating SQL",
  submit_sql: "Finalizing the answer",
  submit: "Finalizing the answer",
  get_knowledge_definition: "Looking up domain terms",
  get_all_knowledge_definitions: "Looking up domain terms",
  get_all_column_meanings: "Reading column meanings",
  ask_user: "Asking a clarifying question",
};

function describeStep(node: ThreadNode): string {
  if (node.kind === "thinking") return "Thinking";
  if (node.kind === "tool") return STEP_LABELS[node.title ?? ""] ?? humanizeToolName(node.title);
  return "Working";
}

/** Last result text produced by an execute_sql tool node, if any. */
function lastExecutedResult(nodes: ThreadNode[]): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === "tool" && (n.title === "execute_sql" || n.title === "run_postgres_readonly") && n.result !== undefined) {
      return n.result;
    }
  }
  return null;
}

/** Most recent SQL the agent ran via execute_sql, if any. */
function lastExecutedSql(nodes: ThreadNode[]): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === "tool" && (n.title === "execute_sql" || n.title === "run_postgres_readonly") && n.body.trim()) {
      return n.body;
    }
  }
  return null;
}

export function extractAgentResult(conv: Conversation): AgentResult {
  const nodes = buildNodes(conv.timeline, conv.title);

  const answerNode = [...nodes].reverse().find((n) => n.kind === "answer") ?? null;
  const lastText = [...nodes].reverse().find((n) => n.kind === "agent_text") ?? null;
  const allowToolFallback =
    conv.status === "starting" || conv.status === "active" || conv.status === "waiting_user" || conv.turnInFlight;

  const sql = answerNode?.body ?? (allowToolFallback ? lastExecutedSql(nodes) : null);
  // Raw tool output can still contain a trailing legacy system note.
  const rawResult = answerNode?.result ?? (allowToolFallback ? lastExecutedResult(nodes) : null);
  const result = rawResult ? stripSystemNote(rawResult) : null;
  const processNodes = nodes.filter((n) => n.kind === "thinking" || n.kind === "tool");
  const lastProcess = processNodes[processNodes.length - 1] ?? null;

  return {
    answerText: lastText?.body ?? null,
    sql: sql && sql.trim() ? sql : null,
    result: result && result.trim() ? result : null,
    steps: processNodes.length,
    currentStep: lastProcess ? describeStep(lastProcess) : null,
  };
}
