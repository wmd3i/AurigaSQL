import type { TimelineEvent } from "./buildTimeline";

/**
 * The agent ends free-chat turns by submitting SQL (no execution attached).
 * If the same SQL was already run via execute_sql during exploration, surface
 * that result on the "Submitted SQL" card so the user sees the actual answer.
 *
 * Scans backwards from `beforeIndex` for an execute_sql call with identical
 * (trimmed) SQL, then returns the first execute_sql response after it.
 */
export function findExecutedResult(
  timeline: TimelineEvent[],
  sql: string,
  beforeIndex: number,
): string | null {
  const want = sql.trim();
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const e = timeline[i];
    const isSqlExecution = e.kind === "tool_call" && (e.name === "execute_sql" || e.name === "run_postgres_readonly");
    const executedSql = e.kind === "tool_call" ? String(e.args.sql ?? e.args.query ?? "").trim() : "";
    if (isSqlExecution && executedSql === want) {
      for (let j = i + 1; j < timeline.length; j++) {
        const r = timeline[j];
        if (r.kind === "tool_response" && (r.name === "execute_sql" || r.name === "run_postgres_readonly")) {
          return r.response;
        }
      }
      return null;
    }
  }
  return null;
}
