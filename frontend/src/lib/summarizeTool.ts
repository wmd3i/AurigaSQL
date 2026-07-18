/**
 * Rule-based human-readable one-liners for tool node results.
 * Deterministic and instant — no LLM calls. Shown at fold level 1;
 * the raw LLM-facing text stays behind the level-2 "Raw output" fold.
 */
import { stripSystemNote } from "./stripSystemNote";
import { humanizeToolName } from "./toolLabels";

function countJsonRows(result: string): number | null {
  const stripped = result.trim();
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (!parsed || typeof parsed !== "object") return null;

    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.rows)) return record.rows.length;
    if (typeof record.returned_rows === "number") return record.returned_rows;
    if (typeof record.row_count === "number") return record.row_count;
    return null;
  } catch {
    return null;
  }
}

export function summarizeTool(toolName: string, rawResult: string): string {
  const result = stripSystemNote(rawResult);
  if (result.startsWith("Error")) return "⚠ Error — review details";

  switch (toolName) {
    case "list_postgres_tables":
    case "list_sqlite_tables":
    case "list_duckdb_tables":
    case "describe_postgres_table":
    case "get_schema": {
      const names = [...result.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]);
      if (names.length === 0) return "Loaded schema";
      return `Loaded schema: ${names.length} tables`;
    }
    case "run_postgres_readonly":
    case "run_sqlite_readonly":
    case "run_duckdb_readonly":
    case "execute_sql": {
      const jsonRows = countJsonRows(result);
      if (jsonRows !== null) {
        if (jsonRows === 0) return "No rows matched";
        return `Returned ${jsonRows} row${jsonRows === 1 ? "" : "s"}`;
      }
      const lines = result.trim().split("\n").filter((l) => l.trim() !== "");
      const hasSeparator = lines.length >= 2 && /^[-\s|+]+$/.test(lines[1]);
      const rows = Math.max(0, hasSeparator ? lines.length - 2 : lines.length);
      if (rows === 0) return "No rows matched";
      return `Returned ${rows} row${rows === 1 ? "" : "s"}`;
    }
    case "get_knowledge_definition":
    case "get_all_knowledge_definitions": {
      try {
        const parsed = JSON.parse(result);
        const n = Array.isArray(parsed) ? parsed.length : 1;
        return `Loaded ${n} domain term definition${n === 1 ? "" : "s"}`;
      } catch {
        return "Loaded domain term definitions";
      }
    }
    case "get_all_external_knowledge_names": {
      try {
        const parsed = JSON.parse(result);
        const n = Array.isArray(parsed) ? parsed.length : 0;
        return `Returned ${n} knowledge topic name${n === 1 ? "" : "s"}`;
      } catch {
        return "Returned knowledge topic names";
      }
    }
    case "get_all_column_meanings": {
      try {
        const n = Object.keys(JSON.parse(result)).length;
        return `Loaded meanings for ${n} column${n === 1 ? "" : "s"}`;
      } catch {
        return "Loaded column meanings";
      }
    }
    default:
      return `Ran ${humanizeToolName(toolName).toLowerCase()}`;
  }
}
