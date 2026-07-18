import type { TimelineEvent } from "./buildTimeline";
import { findExecutedResult } from "./findExecutedResult";
import { stripSystemNote } from "./stripSystemNote";

/**
 * Folds a thread's flat timeline into canvas nodes:
 * - root "question" node is synthesized from the conversation title so it
 *   renders instantly and never depends on the SSE echo (which may be lost
 *   to the subscribe race); the first matching user_msg echo is skipped.
 * - tool call + its response = one "tool" node.
 * - intermediate "thinking" is downgraded from the main canvas: if a later
 *   action/tool/final text follows, we treat that thinking as preparatory
 *   noise and do not emit a standalone node. Only orphaned trailing thinking
 *   remains visible.
 * - ask_user call/response become one "agent_question" node with an answer.
 * - submit_sql becomes the terminal "answer" node (ack response skipped),
 *   with the previously executed result attached when the SQL matches.
 */
export type ThreadNode = {
  id: string;
  kind: "question" | "thinking" | "tool" | "agent_question" | "user_answer" | "answer" | "agent_text";
  title?: string; // tool name for "tool" nodes
  body: string;
  answer?: string;
  summary?: string;
  reasoning?: string;
  result?: string;
};

type Draft = Omit<ThreadNode, "id"> & { callId?: string };

function isSqlExecutionTool(name: string | undefined): boolean {
  return (
    name === "execute_sql" ||
    name === "run_sqlite_readonly" ||
    name === "run_duckdb_readonly" ||
    name === "run_postgres_readonly" ||
    name === "run_mysql_readonly"
  );
}

function isSubmitTool(name: string | undefined): boolean {
  return name === "submit_sql" || name === "submit";
}

function isAskTool(name: string | undefined): boolean {
  return name === "ask_user" || name === "ask";
}

function toolSql(args: Record<string, unknown>): string {
  return String(args.sql ?? args.query ?? "");
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function extractNullCheckColumns(sql: string): string[] {
  const columns = new Set<string>();
  const nullCheck = /\b(?:(?:"[^"]+"|[a-z_][\w$]*)\s*\.\s*)?("[^"]+"|[a-z_][\w$]*)\s+is\s+null\b/gi;
  let match: RegExpExecArray | null;

  while ((match = nullCheck.exec(sql)) !== null) {
    const column = (match[1] ?? "").replace(/^"|"$/g, "");
    if (column) columns.add(column);
  }

  return [...columns];
}

function inferExecuteSqlPurpose(sql: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (!normalized) return "Inspect query results";
  const lower = normalized.toLowerCase();

  if (/\bcount\s*\(/.test(lower) && /\bis null\b/.test(lower)) {
    const nullColumns = extractNullCheckColumns(normalized);
    return nullColumns.length > 0
      ? `Count rows missing ${formatList(nullColumns)}`
      : "Count rows with missing values";
  }
  if (/\bcount\s*\(/.test(lower) && /\bgroup by\b/.test(lower)) return "Compare grouped counts";
  if (/\bcount\s*\(/.test(lower)) return "Count matching rows";
  if (/\b(avg|sum|min|max|stddev|percentile_cont)\s*\(/.test(lower) && /\bgroup by\b/.test(lower)) {
    return "Compare grouped metrics";
  }
  if (/\b(avg|sum|min|max|stddev|percentile_cont)\s*\(/.test(lower)) return "Check summary metrics";
  if (/\bgroup by\b/.test(lower)) return "Compare grouped results";
  if (/\bjoin\b/.test(lower) && /\bwhere\b/.test(lower)) return "Inspect matching filtered records";
  if (/\bwhere\b/.test(lower)) return "Inspect filtered records";
  if (/\border by\b/.test(lower) && /\blimit\b/.test(lower)) return "Review top results";
  return "Inspect query results";
}

function summarizeExecuteSqlPurpose(pendingThinking: string | null, sql: string): string {
  const reasoning = summarizeExecuteSqlReasoning(pendingThinking);
  if (!reasoning) return inferExecuteSqlPurpose(sql);
  return reasoning;
}

function summarizeExecuteSqlReasoning(pendingThinking: string | null): string | undefined {
  const source = pendingThinking?.trim().replace(/\s+/g, " ") ?? "";
  if (!source) return undefined;

  const softened = source
    .replace(/^i\s+(should|need to|want to|will)\s+/i, "")
    .replace(/^let'?s\s+/i, "")
    .replace(/^we\s+(should|need to|want to|will)\s+/i, "")
    .replace(/^to\s+/i, "")
    .trim();

  if (!softened) return undefined;
  return softened.charAt(0).toUpperCase() + softened.slice(1);
}

export function buildNodes(timeline: TimelineEvent[], title: string): ThreadNode[] {
  const drafts: Draft[] = [{ kind: "question", body: title }];
  let titleEchoSkipped = false;
  let pendingThinking: string | null = null;

  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    switch (e.kind) {
      case "user_msg":
        if (pendingThinking) {
          drafts.push({ kind: "thinking", body: pendingThinking });
          pendingThinking = null;
        }
        if (!titleEchoSkipped && e.text === title) {
          titleEchoSkipped = true; // SSE echo of the synthesized root — skip
        } else {
          drafts.push({ kind: "question", body: e.text });
        }
        break;
      case "thinking":
        pendingThinking = pendingThinking ? `${pendingThinking}\n\n${e.text}` : e.text;
        break;
      case "tool_call": {
        const sql = toolSql(e.args);
        const reasoning = summarizeExecuteSqlReasoning(pendingThinking);
        const purpose =
          isSqlExecutionTool(e.name) ? inferExecuteSqlPurpose(sql) : summarizeExecuteSqlPurpose(pendingThinking, sql);
        pendingThinking = null;
        if (isAskTool(e.name)) {
          drafts.push({ kind: "agent_question", body: String(e.args.question ?? "") });
        } else if (isSubmitTool(e.name)) {
          const executed = findExecutedResult(timeline, sql, i);
          drafts.push({
            kind: "answer",
            body: sql,
            summary: purpose,
            result: executed === null ? undefined : stripSystemNote(executed),
          });
        } else {
          drafts.push({
            kind: "tool",
            title: e.name,
            summary: isSqlExecutionTool(e.name) ? purpose : undefined,
            reasoning,
            callId: e.id,
            // arg-less tools (get_schema etc.) get no body — "{}" is just noise
            body: sql || (Object.keys(e.args).length > 0 ? JSON.stringify(e.args, null, 2) : ""),
          });
        }
        break;
      }
      case "tool_response": {
        if (isAskTool(e.name)) {
          const open = [...drafts].reverse().find((d) => d.kind === "agent_question" && d.answer === undefined);
          const answer = stripSystemNote(e.response);
          if (open) open.answer = answer;
          else drafts.push({ kind: "user_answer", body: answer });
        } else if (isSubmitTool(e.name)) {
          // Attach the submitted query result when exploration did not already
          // provide a matching execution result.
          const open = [...drafts].reverse().find((d) => d.kind === "answer");
          if (open && open.result === undefined) {
            const stripped = stripSystemNote(e.response);
            if (stripped) open.result = stripped;
          }
        } else {
          const open = e.id
            ? drafts.find((d) => d.kind === "tool" && d.callId === e.id && d.result === undefined)
            : drafts.find((d) => d.kind === "tool" && d.title === e.name && d.result === undefined);
          const stripped = stripSystemNote(e.response);
          if (open) open.result = stripped;
          else drafts.push({ kind: "tool", title: e.name, body: "", result: stripped });
        }
        break;
      }
      case "final_answer": {
        pendingThinking = null;
        const sql = e.sql?.trim() ?? "";
        const result = e.result ? stripSystemNote(e.result) : undefined;
        if (sql) {
          drafts.push({
            kind: "answer",
            body: sql,
            summary: inferExecuteSqlPurpose(sql),
            result: result && result.trim() ? result : undefined,
          });
        }
        if (e.text.trim()) {
          drafts.push({ kind: "agent_text", body: e.text });
        }
        break;
      }
      case "final":
        pendingThinking = null;
        drafts.push({ kind: "agent_text", body: e.text });
        break;
    }
  }

  if (pendingThinking) drafts.push({ kind: "thinking", body: pendingThinking });

  return drafts.map((d, i) => {
    const { callId, ...node } = d;
    return { ...node, id: `n${i}` };
  });
}
