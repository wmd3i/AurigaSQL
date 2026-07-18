/**
 * Parses the backend SQL tool text result format into table data:
 *   col1 | col2          ← header (" | " joined)
 *   ------------         ← ascii dash separator
 *   v1 | v2              ← rows (" | " joined, cells capped at 100 chars)
 *   ...                  ← optional word-budget truncation marker
 * Returns null for non-tabular messages ("Query executed successfully." etc.)
 * so callers can fall back to plain text.
 */
export type ResultTable = { headers: string[]; rows: string[][]; truncated: boolean };

function splitRow(line: string) {
  return line.split(/\s*\|\s*/).map((cell) => cell.trim());
}

function looksLikeSeparator(line: string) {
  return /^[\s|:+-]+$/.test(line.trim());
}

function isCommentClose(line: string) {
  return line.trim() === "*/";
}

function parseFlattenedTable(text: string): ResultTable | null {
  if (!text.includes("|")) return null;
  const separatorMatch = text.match(/\s-{8,}\s/);
  if (!separatorMatch || separatorMatch.index === undefined) return null;

  const headerPart = text.slice(0, separatorMatch.index).trim();
  const headers = splitRow(headerPart);
  if (headers.length < 1) return null;

  let dataPart = text.slice(separatorMatch.index + separatorMatch[0].length).trim();
  dataPart = dataPart.replace(/^(?:-+\s+)+/, "").trim();
  if (!dataPart) return null;

  let truncated = false;
  if (dataPart.endsWith("...")) {
    truncated = true;
    dataPart = dataPart.slice(0, -3).trim();
  }

  const flatCells = splitRow(dataPart).filter((cell) => cell !== "");
  if (flatCells.length < headers.length) return null;

  const rows: string[][] = [];
  for (let i = 0; i + headers.length <= flatCells.length; i += headers.length) {
    rows.push(flatCells.slice(i, i + headers.length));
  }

  if (rows.length === 0) return null;
  if (flatCells.length % headers.length !== 0) truncated = true;
  return { headers, rows, truncated };
}

function parseResultLines(lines: string[], startIndex: number): ResultTable | null {
  const headers = splitRow(lines[startIndex]);
  if (headers.length < 1) return null;

  const hasSeparator = lines.length > startIndex + 1 && looksLikeSeparator(lines[startIndex + 1]);
  if (headers.length === 1 && !lines[startIndex].includes("|") && !hasSeparator) return null;
  const firstDataLine = startIndex + (hasSeparator ? 2 : 1);
  if (lines.length <= firstDataLine) return null;

  const sampleRow = splitRow(lines[firstDataLine]);
  if (sampleRow.length < headers.length || sampleRow.length < 1) return null;

  let truncated = false;
  const rows: string[][] = [];

  for (const line of lines.slice(firstDataLine)) {
    const t = line.trim();
    if (t === "") continue;
    if (isCommentClose(t)) break;
    if (t === "..." || t.endsWith("...")) {
      truncated = true;
      if (t === "...") continue; // pure marker row — drop it
    }
    const row = splitRow(line);
    if (row.length < headers.length) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  if (rows.length === 0) return null;
  return { headers, rows, truncated };
}

export function parseResultTable(text: string): ResultTable | null {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  if (lines.length < 2) return parseFlattenedTable(text.trim());

  const fromStart = parseResultLines(lines, 0);
  if (fromStart) return fromStart;

  for (let i = 1; i < lines.length - 1; i++) {
    const cells = splitRow(lines[i]);
    if (!lines[i].includes("|") || cells.length < 2) continue;
    const parsed = parseResultLines(lines, i);
    if (parsed) return parsed;
  }

  return null;
}

/** Display-only nicety: round endless decimals to 4 places (raw text keeps full precision). */
export function formatCell(cell: string): string {
  if (/^-?\d+\.\d{5,}$/.test(cell)) return Number(cell).toFixed(4);
  return cell;
}
