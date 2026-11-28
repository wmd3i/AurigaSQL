import type { ThreadNode } from "./buildNodes";
import { parseResultTable, type ResultTable } from "./parseResultTable";
import { stripSystemNote } from "./stripSystemNote";
import { isSqlInputTool, isValidationTool } from "./toolLabels";

/** What a card's copy button puts on the clipboard. `html` is set when the
 *  content has a table, so pasting into a spreadsheet or doc keeps the cells. */
export type CopyPayload = { text: string; html?: string };

export type CopyableCard = ThreadNode | { id: string; kind: "error"; body: string };

const TRUNCATED_MARK = "…";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tsvCell(cell: string): string {
  return cell.replace(/[\t\r\n]+/g, " ");
}

/** Tables without headers (SQL tools return bare row arrays) skip the header row. */
export function tableToTsv(table: ResultTable): string {
  const rows = table.headers.length > 0 ? [table.headers, ...table.rows] : table.rows;
  const lines = rows.map((row) => row.map(tsvCell).join("\t"));
  if (table.truncated) lines.push(TRUNCATED_MARK);
  return lines.join("\n");
}

export function tableToHtml(table: ResultTable): string {
  const head =
    table.headers.length > 0
      ? `<thead><tr>${table.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`
      : "";
  const rows = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  const width = Math.max(table.headers.length, table.rows[0]?.length ?? 1);
  const more = table.truncated ? `<tr><td colspan="${width}">${TRUNCATED_MARK}</td></tr>` : "";
  return `<table>${head}<tbody>${rows}${more}</tbody></table>`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SQL tools return `dump_json(rows)`: an array of row arrays with no column
 *  names. Arrays of objects take their keys as headers. */
export function parseJsonRows(text: string): ResultTable | "empty" | null {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return "empty";
  if (parsed.every(Array.isArray)) {
    return { headers: [], rows: parsed.map((row: unknown[]) => row.map(jsonCell)), truncated: false };
  }
  if (parsed.every(isPlainObject)) {
    const headers = [...new Set(parsed.flatMap((row) => Object.keys(row)))];
    return { headers, rows: parsed.map((row) => headers.map((key) => jsonCell(row[key]))), truncated: false };
  }
  return null;
}

function textPayload(text: string | undefined): CopyPayload | null {
  const trimmed = text?.trim();
  return trimmed ? { text: trimmed } : null;
}

function resultPayload(result: string | undefined): CopyPayload | null {
  const text = result ? stripSystemNote(result) : "";
  if (!text) return null;
  const table = parseResultTable(text);
  if (table) return { text: tableToTsv(table), html: tableToHtml(table) };
  const rows = parseJsonRows(text);
  if (rows === "empty") return { text: "(no rows)" };
  if (rows) return { text: tableToTsv(rows), html: tableToHtml(rows) };
  return { text };
}

/** Mirrors the card's "Validation passed / Needs revision" line instead of the raw JSON. */
function validationPayload(result: string | undefined): CopyPayload | null {
  const text = result ? stripSystemNote(result) : "";
  if (!text) return null;
  const parsed = parseJson(text);
  if (!isPlainObject(parsed) || !("ok" in parsed)) return { text };
  if (parsed.ok === true) return { text: "Validation passed" };
  const error = typeof parsed.error === "string" ? parsed.error.trim() : "";
  return { text: error ? `Needs revision: ${error}` : "Needs revision" };
}

/** A message that is nothing but one fenced code block copies as the bare code. */
export function stripWholeCodeFence(text: string): string {
  const match = text.trim().match(/^```[\w+-]*\n([\s\S]*?)\n?```$/);
  return match && !match[1].includes("```") ? match[1].trim() : text;
}

function joinPayloads(first: CopyPayload | null, second: CopyPayload | null): CopyPayload | null {
  if (!first) return second;
  if (!second) return first;
  const text = `${first.text}\n\n${second.text}`;
  if (!first.html && !second.html) return { text };
  const asHtml = (payload: CopyPayload) => payload.html ?? `<pre>${escapeHtml(payload.text)}</pre>`;
  return { text, html: asHtml(first) + asHtml(second) };
}

/** The content of one card: tables (including SQL tools' bare JSON rows) copy
 *  as tables, SQL tool cards copy their SQL plus its result even while folded,
 *  and validation cards copy the SQL plus the pass/fail verdict. */
export function cardCopyPayload(card: CopyableCard): CopyPayload | null {
  switch (card.kind) {
    case "agent_question": {
      const answer = card.answer?.trim();
      return textPayload(answer ? `${card.body.trim()}\n\nYou clarified: ${answer}` : card.body);
    }
    case "answer":
      // The card shows the result table; fall back to the SQL when no result was captured.
      return resultPayload(card.result) ?? textPayload(stripSystemNote(card.body));
    case "tool": {
      const sql = isSqlInputTool(card.title) ? textPayload(stripSystemNote(card.body)) : null;
      const result = isValidationTool(card.title) ? validationPayload(card.result) : resultPayload(card.result);
      return joinPayloads(sql, result) ?? textPayload(stripSystemNote(card.body));
    }
    case "agent_text":
      return textPayload(stripWholeCodeFence(card.body));
    default:
      return textPayload(card.body);
  }
}

/** Writes both formats when the payload has HTML; falls back to plain text
 *  where rich clipboard writes are unavailable or refused. */
export async function writeCopyPayload(payload: CopyPayload): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard is unavailable");
  if (payload.html && typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Fall through to plain text.
    }
  }
  await clipboard.writeText(payload.text);
}
