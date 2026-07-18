import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  Copy,
  Database,
  MessageCircleQuestion,
  Sparkles,
  Table2,
  Terminal,
  User,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { buildNodes, type ThreadNode } from "../../lib/buildNodes";
import { stripSystemNote } from "../../lib/stripSystemNote";
import { summarizeTool } from "../../lib/summarizeTool";
import { formatCell, parseResultTable } from "../../lib/parseResultTable";
import { formatSql } from "../../lib/formatSql";
import { tokenizeSql, type SqlTokenType } from "../../lib/highlightSql";
import { humanizeToolName } from "../../lib/toolLabels";
import type { Conversation } from "../../state/types";

type Palette = { bg: string; fg: string };
type KnowledgeEntry = {
  id?: number | string;
  knowledge: string;
  description?: string;
  definition?: string;
};
type DomainTopic = {
  id?: number | string;
  name: string;
  description?: string;
  definition?: string;
};
type ColumnMeaningEntry = {
  id?: number | string;
  table?: string;
  column: string;
  fullName?: string;
  explanation: string;
  dataType?: string;
  example?: string;
  possibleCategories?: string;
};
type SchemaTable = {
  name: string;
  columns: Array<{ name: string; type: string; meta?: string }>;
  constraints: string[];
  sample?: { headers: string[]; rows: string[][] };
};
type PreviewTable = {
  headers: string[];
  rows: string[][];
  truncated: boolean;
  emptyMessage?: string;
  emptyDetail?: string;
};

export type Checkpoint = {
  nodeId: string;
  order: number;
  label: string;
  summary: string;
  toolName?: string;
};

export type CheckpointGroup = {
  id: string;
  question: string;
  checkpoints: Checkpoint[];
};

function compactTabLabel(label: string): string {
  if (label === "Inspecting schema") return "Schema";
  if (label === "Looking up knowledge") return "Knowledge";
  if (label === "Running SQL") return "SQL";
  if (label === "Final SQL") return "Final SQL";
  if (label === "Asking you") return "Clarify";
  return label;
}

const ACCENT: Palette = { bg: "bg-accent-soft", fg: "text-accent" };
const NEUTRAL: Palette = { bg: "bg-hover", fg: "text-muted" };

const SQL_TOKEN_CLASS: Record<SqlTokenType, string> = {
  keyword: "text-[#af00db]",
  function: "text-[#1f2328]",
  string: "text-[#c41a16]",
  number: "text-[#1750eb]",
  comment: "text-[#008000]",
  operator: "text-[#1f2328]",
  plain: "text-[#1f2328]",
};

export function SqlCodeBlock({ sql, showCopy = false }: { sql: string; showCopy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const formattedSql = useMemo(() => formatSql(sql), [sql]);
  const displaySql = formattedSql || sql.trim();
  const tokens = useMemo(() => tokenizeSql(displaySql), [displaySql]);

  function copySql() {
    navigator.clipboard.writeText(displaySql).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="relative overflow-hidden rounded-2xl bg-hover/85">
      {showCopy && (
        <button
          type="button"
          onClick={copySql}
          className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg bg-card/90 px-2 py-1 text-[11px] font-medium text-muted shadow-sm ring-1 ring-line/70 transition-colors hover:bg-card hover:text-ink"
          aria-label="Copy SQL"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <pre
        className={cn(
          "overflow-auto whitespace-pre px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[#1f2328]",
          showCopy && "pr-20",
        )}
      >
        <code>
          {tokens.map((token, i) => (
            <span key={`${i}-${token.text}`} className={SQL_TOKEN_CLASS[token.type]}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function isSqlToolName(name?: string) {
  return (
    name === "execute_sql" ||
    name === "run_sqlite_readonly" ||
    name === "run_duckdb_readonly" ||
    name === "run_postgres_readonly" ||
    name === "explain_sqlite_query" ||
    name === "explain_postgres_query" ||
    name === "validate_sql" ||
    name === "validate_sqlite_query" ||
    name === "validate_duckdb_query" ||
    name === "validate_postgres_query" ||
    name === "submit_sql" ||
    name === "submit"
  );
}

function isSchemaToolName(name?: string) {
  return (
    name === "get_schema" ||
    name === "list_sqlite_tables" ||
    name === "list_duckdb_tables" ||
    name === "list_postgres_tables" ||
    name === "describe_postgres_table"
  );
}

function isValidationToolName(name?: string) {
  return (
    name === "validate_sql" ||
    name === "validate_sqlite_query" ||
    name === "validate_duckdb_query" ||
    name === "validate_postgres_query"
  );
}

function isExplainToolName(name?: string) {
  return name === "explain_sqlite_query" || name === "explain_postgres_query";
}

function tryParseKnowledgeEntries(result: string): KnowledgeEntry[] | null {
  const stripped = stripSystemNote(result).trim();
  if (!stripped.startsWith("[") && !stripped.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(stripped) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const entries: KnowledgeEntry[] = items
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        if (typeof record.knowledge !== "string") return null;
        const entry: KnowledgeEntry = {
          id: typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined,
          knowledge: record.knowledge,
          description: typeof record.description === "string" ? record.description : undefined,
          definition: typeof record.definition === "string" ? record.definition : undefined,
        };
        return entry;
      })
      .filter((entry): entry is KnowledgeEntry => entry !== null);
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

function tryParseDomainTopics(result: string): DomainTopic[] | null {
  const stripped = stripSystemNote(result).trim();
  if (!stripped.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (!Array.isArray(parsed)) return null;
    const topics = parsed
      .map((item): DomainTopic | null => {
        if (typeof item === "string" && item.trim() !== "") return { name: item };
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const name = record.knowledge_name ?? record.knowledge ?? record.name ?? record.topic;
        if (typeof name !== "string" || name.trim() === "") return null;
        return {
          id: typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined,
          name,
          description: typeof record.description === "string" ? record.description : undefined,
          definition: typeof record.definition === "string" ? record.definition : undefined,
        };
      })
      .filter((topic): topic is DomainTopic => topic !== null);
    return topics.length > 0 ? topics : null;
  } catch {
    return null;
  }
}

function parseColumnMeaningText(text: string) {
  const clean = stripSystemNote(text).trim();
  const fullName = clean.match(/Full name:\s*'([^']+)'/i)?.[1]?.trim();
  const explanation = clean.match(/Explanation:\s*(.*?)(?:\s+Data type:|\s+Example:|\s+Possible categories:|$)/i)?.[1]?.trim();
  const dataType = clean.match(/Data type:\s*(.*?)(?:\s+Example:|\s+Possible categories:|$)/i)?.[1]?.trim();
  const example = clean.match(/Example:\s*'?(.+?)'?\.?(?:\s+Possible categories:|$)/i)?.[1]?.trim();
  const possibleCategories = clean.match(/Possible categories:\s*(.*?)\.?$/i)?.[1]?.trim();

  return {
    fullName,
    explanation: explanation || clean,
    dataType,
    example,
    possibleCategories,
  };
}

function columnPathParts(raw: string) {
  const pipeParts = raw.split("|").map((part) => part.trim()).filter(Boolean);
  if (pipeParts.length >= 3) {
    return { table: pipeParts[pipeParts.length - 2], column: pipeParts[pipeParts.length - 1] };
  }

  const dotParts = raw.split(".").map((part) => part.trim()).filter(Boolean);
  if (dotParts.length >= 2) {
    return { table: dotParts[dotParts.length - 2], column: dotParts[dotParts.length - 1] };
  }

  return { column: raw.trim() || "Column" };
}

function tryParseColumnMeanings(result: string): ColumnMeaningEntry[] | null {
  const stripped = stripSystemNote(result).trim();
  if (!stripped) return null;

  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string" && value.trim())
        .map(([key, value], index) => {
          const path = columnPathParts(key);
          return {
            id: index + 1,
            table: path.table,
            column: path.column,
            ...parseColumnMeaningText(String(value)),
          };
        });
      return entries.length > 0 ? entries : null;
    } catch {
      return null;
    }
  }

  if (/Full name:|Explanation:|Data type:/i.test(stripped)) {
    return [{ id: 1, column: "Column", ...parseColumnMeaningText(stripped) }];
  }

  return null;
}

function toSuperscript(text: string): string {
  const map: Record<string, string> = {
    "0": "0",
    "1": "1",
    "2": "2",
    "3": "3",
    "4": "4",
    "5": "5",
    "6": "6",
    "7": "7",
    "8": "8",
    "9": "9",
    "-": "-",
    "+": "+",
    "(": "(",
    ")": ")",
    "n": "n",
  };
  const unicodeMap: Record<string, string> = {
    "0": "⁰",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
    "5": "⁵",
    "6": "⁶",
    "7": "⁷",
    "8": "⁸",
    "9": "⁹",
    "-": "⁻",
    "+": "⁺",
    "(": "⁽",
    ")": "⁾",
    "n": "ⁿ",
  };
  return text
    .split("")
    .map((char) => unicodeMap[char] ?? map[char] ?? char)
    .join("");
}

function formatKnowledgeDefinition(definition: string): string {
  let formatted = definition.trim();
  if (formatted.startsWith("$") && formatted.endsWith("$")) {
    formatted = formatted.slice(1, -1);
  }

  formatted = formatted.replace(/\\text\{([^}]*)\}/g, "$1");
  formatted = formatted.replace(/\\times/g, "×");
  formatted = formatted.replace(/\\cdot/g, "·");
  formatted = formatted.replace(/\\leq/g, "≤");
  formatted = formatted.replace(/\\geq/g, "≥");
  formatted = formatted.replace(/\\neq/g, "≠");
  formatted = formatted.replace(/\\approx/g, "≈");
  formatted = formatted.replace(/\\left/g, "");
  formatted = formatted.replace(/\\right/g, "");
  formatted = formatted.replace(/\\,/g, " ");
  formatted = formatted.replace(/\\ /g, " ");
  formatted = formatted.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1 / $2)");
  formatted = formatted.replace(/\^\{([^}]*)\}/g, (_, exponent: string) => toSuperscript(exponent));
  formatted = formatted.replace(/\^([A-Za-z0-9+-]+)/g, (_, exponent: string) => toSuperscript(exponent));
  formatted = formatted.replace(/\\([A-Za-z]+)/g, "$1");
  formatted = formatted.replace(/\s+/g, " ").trim();
  return formatted;
}

function parseSchemaTables(result: string): SchemaTable[] | null {
  const stripped = stripSystemNote(result);
  const jsonTables = parseJsonSchemaTables(stripped);
  if (jsonTables) return jsonTables;
  const textTables = parseTextSchemaTables(stripped);
  if (textTables) return textTables;

  if (!stripped.includes('CREATE TABLE "')) return null;

  const matches = [...stripped.matchAll(/CREATE TABLE "([^"]+)" \(\n([\s\S]*?)\n\);\n*([\s\S]*?)(?=CREATE TABLE "|$)/g)];
  if (matches.length === 0) return null;

  return matches.map((match) => {
    const [, name, body, tail] = match;
    const rawLines = body.split("\n").map((line) => line.trim()).filter(Boolean);
    const columns: SchemaTable["columns"] = [];
    const constraints: string[] = [];

    for (const line of rawLines) {
      const cleaned = line.replace(/,$/, "");
      if (
        cleaned.startsWith("PRIMARY KEY") ||
        cleaned.startsWith("FOREIGN KEY") ||
        cleaned.startsWith("UNIQUE") ||
        cleaned.startsWith("CHECK")
      ) {
        constraints.push(cleaned);
        continue;
      }

      const colMatch = cleaned.match(/^("?[\w]+"?)\s+(.+)$/);
      if (!colMatch) {
        constraints.push(cleaned);
        continue;
      }

      const [, colName, rest] = colMatch;
      const metaMatch = rest.match(/^(.+?)(\s+(?:NOT NULL|NULL|DEFAULT .+|PRIMARY KEY.*|REFERENCES .+))$/);
      if (metaMatch) {
        columns.push({
          name: colName.replace(/"/g, ""),
          type: metaMatch[1].trim(),
          meta: metaMatch[2].trim(),
        });
      } else {
        columns.push({
          name: colName.replace(/"/g, ""),
          type: rest.trim(),
        });
      }
    }

    let sample: SchemaTable["sample"] | undefined;
    const sampleMatch = tail.match(/First 3 rows:\n([\s\S]*?)(?=\n(?:CREATE TABLE "|$))/);
    if (sampleMatch) {
      const lines = sampleMatch[1]
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== "" && line.trim() !== "...");
      if (lines.length >= 3) {
        const headers = lines[0].split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
        const rows = lines
          .slice(2)
          .map((line) => line.split(/\s{2,}/).map((part) => part.trim()))
          .filter((row) => row.length > 0);
        if (headers.length > 0 && rows.length > 0) {
          sample = { headers, rows };
        }
      }
    }

    return { name, columns, constraints, sample };
  });
}

function parseCreateColumns(createSql: string): SchemaTable["columns"] {
  const body = createSql.match(/\(([\s\S]*)\)/)?.[1];
  if (!body) return [];
  return body
    .split(",")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line && !/^(PRIMARY KEY|CONSTRAINT|UNIQUE|FOREIGN KEY|CHECK)\b/i.test(line))
    .map((line): SchemaTable["columns"][number] | null => {
      const match = line.match(/^"?([\w\s-]+?)"?\s+(.+)$/);
      if (!match) return null;
      return { name: match[1].trim(), type: match[2].trim() };
    })
    .filter((column): column is SchemaTable["columns"][number] => column !== null);
}

function parseColumnList(value: string): SchemaTable["columns"] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): SchemaTable["columns"][number] => {
      const match = part.match(/^("?[\w\s-]+"?)\s+(.+)$/);
      return match
        ? { name: match[1].replace(/"/g, "").trim(), type: match[2].trim() }
        : { name: part, type: "" };
    });
}

function parseTextSchemaTables(result: string): SchemaTable[] | null {
  const matches = [...result.matchAll(/Table:\s*([^\n]+)\n(?:(?:Schema:\s*([^\n]+))|(?:Columns:\s*([^\n]+)))/g)];
  if (matches.length === 0) return null;

  const tables = matches.map((match): SchemaTable => {
    const [, name, createSql, columnsText] = match;
    const columns = createSql
      ? parseCreateColumns(createSql)
      : columnsText
        ? parseColumnList(columnsText)
        : [];
    return { name: name.trim(), columns, constraints: [] };
  });
  return tables.length > 0 ? tables : null;
}

function tableNameFromRecord(record: Record<string, unknown>, index: number): string {
  const rawName = record.table ?? record.name ?? record.table_name;
  const schema = typeof record.schema === "string" && record.schema.trim() ? record.schema.trim() : "";
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : `table_${index + 1}`;
  return schema ? `${schema}.${name}` : name;
}

function parseJsonSchemaTables(result: string): SchemaTable[] | null {
  const stripped = result.trim();
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(stripped) as unknown;
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    const tableValues = record && Array.isArray(record.tables)
      ? record.tables
      : Array.isArray(parsed)
        ? parsed
        : record && (Array.isArray(record.columns) || typeof (record.table ?? record.name ?? record.table_name) === "string")
          ? [record]
          : null;
    if (!tableValues || tableValues.length === 0) return null;

    const tables = tableValues
      .map((tableValue, index): SchemaTable | null => {
        if (typeof tableValue === "string" && tableValue.trim()) {
          return { name: tableValue.trim(), columns: [], constraints: [] };
        }
        if (!tableValue || typeof tableValue !== "object" || Array.isArray(tableValue)) return null;
        const tableRecord = tableValue as Record<string, unknown>;
        const rawColumns = [tableRecord.columns, tableRecord.fields].find((value): value is unknown[] => Array.isArray(value));
        const columns = (rawColumns ?? [])
          .map((columnValue): SchemaTable["columns"][number] | null => {
            if (typeof columnValue === "string") return { name: columnValue, type: "" };
            if (!columnValue || typeof columnValue !== "object" || Array.isArray(columnValue)) return null;
            const columnRecord = columnValue as Record<string, unknown>;
            const rawName = columnRecord.name ?? columnRecord.column ?? columnRecord.column_name;
            if (typeof rawName !== "string" || !rawName.trim()) return null;
            const rawType = columnRecord.type ?? columnRecord.data_type ?? columnRecord.dtype;
            const metaParts = [
              columnRecord.nullable === false ? "NOT NULL" : "",
              typeof columnRecord.default === "string" ? `DEFAULT ${columnRecord.default}` : "",
            ].filter(Boolean);
            return {
              name: rawName.trim(),
              type: typeof rawType === "string" ? rawType : "",
              meta: metaParts.length > 0 ? metaParts.join(" ") : undefined,
            };
          })
          .filter((column): column is SchemaTable["columns"][number] => column !== null);
        const rawConstraints = tableRecord.constraints;
        const constraints = Array.isArray(rawConstraints)
          ? rawConstraints.map((constraint) => stringifyCell(constraint)).filter(Boolean)
          : [];
        return { name: tableNameFromRecord(tableRecord, index), columns, constraints };
      })
      .filter((table): table is SchemaTable => table !== null);

    return tables.length > 0 ? tables : null;
  } catch {
    return null;
  }
}

function SchemaPreview({ tables }: { tables: SchemaTable[] }) {
  const [openTable, setOpenTable] = useState<string | null>(null);
  const onlyTableNames = tables.every(
    (table) => table.columns.length === 0 && table.constraints.length === 0 && !table.sample,
  );

  if (onlyTableNames) {
    return (
      <div className="space-y-2.5">
        {tables.map((table) => (
          <article
            key={table.name}
            className="overflow-hidden rounded-[1.6rem] border border-line/80 bg-card shadow-[0_10px_28px_rgba(24,32,28,0.05)]"
          >
            <div className="flex w-full items-center justify-between gap-3 bg-surface/70 px-4 py-2.5 text-left">
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-semibold text-ink">{table.name}</div>
                <div className="mt-0.5 text-[10.5px] text-faint">Table listed</div>
              </div>
              <span className="shrink-0 rounded-full border border-line bg-card px-2 py-0.5 text-[10.5px] font-medium text-muted">
                schema
              </span>
            </div>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {tables.map((table) => (
        <article
          key={table.name}
          className="overflow-hidden rounded-[1.6rem] border border-line/80 bg-card shadow-[0_10px_28px_rgba(24,32,28,0.05)]"
        >
          <button
            type="button"
            onClick={() => setOpenTable((current) => (current === table.name ? null : table.name))}
            className="flex w-full items-center justify-between gap-3 bg-surface/70 px-4 py-2.5 text-left transition-colors hover:bg-hover/60"
          >
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-ink">{table.name}</div>
              <div className="mt-0.5 text-[10.5px] text-faint">
                {table.columns.length} columns{table.constraints.length > 0 ? `, ${table.constraints.length} constraints` : ""}
              </div>
            </div>
            <span
              className={cn(
                "shrink-0 text-[18px] leading-none text-faint transition-transform",
                openTable === table.name && "rotate-45 text-accent",
              )}
            >
              +
            </span>
          </button>

          {openTable === table.name && (
            <div className="space-y-4 border-t border-line/70 px-4 py-4">
              <div className="overflow-hidden rounded-2xl border border-line/70">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="bg-hover/70">
                      <th className="px-3 py-2 text-left font-medium text-muted">Column</th>
                      <th className="px-3 py-2 text-left font-medium text-muted">Type</th>
                      <th className="px-3 py-2 text-left font-medium text-muted">Meta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.columns.map((column) => (
                      <tr key={`${table.name}-${column.name}`} className="border-t border-line/60">
                        <td className="px-3 py-2 font-medium text-ink">{column.name}</td>
                        <td className="px-3 py-2 font-mono text-[11.5px] text-muted">{column.type}</td>
                        <td className="px-3 py-2 text-[11.5px] text-faint">{column.meta ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {table.constraints.length > 0 && (
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Constraints</div>
                  <div className="flex flex-wrap gap-2">
                    {table.constraints.map((constraint, index) => (
                      <span
                        key={`${table.name}-constraint-${index}`}
                        className="rounded-full border border-line bg-surface px-2.5 py-1 font-mono text-[11px] text-muted"
                      >
                        {constraint}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {table.sample && (
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Sample Rows</div>
                  <div className="overflow-auto rounded-2xl border border-line/70">
                    <table className="w-full min-w-max border-collapse text-[12px]">
                      <thead>
                        <tr className="bg-hover/70">
                          {table.sample.headers.map((header) => (
                            <th key={`${table.name}-${header}`} className="px-3 py-2 text-left font-medium text-muted">
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.sample.rows.map((row, rowIndex) => (
                          <tr key={`${table.name}-row-${rowIndex}`} className="border-t border-line/60">
                            {table.sample!.headers.map((_, columnIndex) => (
                              <td key={`${table.name}-${rowIndex}-${columnIndex}`} className="px-3 py-2 text-ink">
                                {row[columnIndex] ?? "—"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return <>{text}</>;

  const pieces: ReactNode[] = [];
  const lowered = text.toLowerCase();
  let cursor = 0;
  let matchIndex = lowered.indexOf(normalizedQuery);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) pieces.push(text.slice(cursor, matchIndex));
    const end = matchIndex + normalizedQuery.length;
    pieces.push(
      <mark
        key={`${matchIndex}-${end}`}
        className="rounded-[4px] bg-[rgba(245,201,92,0.42)] px-0.5 text-ink"
      >
        {text.slice(matchIndex, end)}
      </mark>,
    );
    cursor = end;
    matchIndex = lowered.indexOf(normalizedQuery, cursor);
  }

  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <>{pieces}</>;
}

function KnowledgePreview({ entries }: { entries: KnowledgeEntry[] }) {
  const [query, setQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [openKnowledge, setOpenKnowledge] = useState<number | null>(entries.length === 1 ? 0 : null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const showSearch = entries.length > 1;
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!normalizedQuery) return [];
    return entries
      .map((entry, index) => {
        const haystack = [
          entry.knowledge,
          entry.description ?? "",
          formatKnowledgeDefinition(entry.definition ?? ""),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedQuery) ? index : -1;
      })
      .filter((index) => index !== -1);
  }, [entries, normalizedQuery]);

  function jumpToMatch(nextCursor?: number) {
    if (matches.length === 0) return;
    const cursor = nextCursor ?? matchCursor % matches.length;
    const targetIndex = matches[cursor] ?? matches[0];
    setOpenKnowledge(targetIndex);
    itemRefs.current[targetIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setMatchCursor((cursor + 1) % matches.length);
  }

  return (
    <div className="space-y-3">
      {showSearch && (
        <div className="sticky top-0 z-10 -mx-1 rounded-2xl bg-surface/95 px-1 pb-2 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2">
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchCursor(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jumpToMatch(matchCursor % Math.max(matches.length, 1));
                }
              }}
              placeholder="Search knowledge"
              className="w-full border-0 bg-transparent text-[12.5px] text-ink placeholder:text-faint focus:outline-none"
            />
            {normalizedQuery && (
              <span className="shrink-0 text-[11px] text-faint">
                {matches.length === 0 ? "No match" : `${matches.length} matches`}
              </span>
            )}
          </div>
        </div>
      )}
      {entries.map((entry, index) => (
        <article
          key={`${entry.id ?? index}-${entry.knowledge}`}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          className={cn(
            "rounded-2xl border border-line/70 bg-card px-4 py-3 shadow-[0_8px_24px_rgba(24,32,28,0.04)] transition-colors",
            normalizedQuery &&
              matches.includes(index) &&
              "border-accent/40 bg-accent-soft/20 shadow-[0_10px_28px_rgba(18,128,122,0.08)]",
          )}
        >
          <button
            type="button"
            onClick={() => setOpenKnowledge((current) => (current === index ? null : index))}
            className="flex w-full items-start gap-3 text-left"
          >
            <span className="mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent">
              {entry.id ?? index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-[13px] font-semibold leading-5 text-ink">
                    <HighlightedText text={entry.knowledge} query={query} />
                  </h4>
                  {entry.description && (
                    <p className="mt-1 text-[12px] leading-5 text-muted">
                      <HighlightedText text={entry.description} query={query} />
                    </p>
                  )}
                </div>
                <span
                  className={cn(
                    "mt-0.5 shrink-0 text-[18px] leading-none text-faint transition-transform",
                    openKnowledge === index && "rotate-45 text-accent",
                  )}
                >
                  +
                </span>
              </div>

              {openKnowledge === index && entry.definition && (
                <div className="mt-2 rounded-xl bg-hover/85 px-3 py-2 font-mono text-[12.5px] leading-6 text-ink">
                  <HighlightedText text={formatKnowledgeDefinition(entry.definition)} query={query} />
                </div>
              )}
            </div>
          </button>
        </article>
      ))}
    </div>
  );
}

function ColumnMeaningsPreview({ entries }: { entries: ColumnMeaningEntry[] }) {
  const [openColumn, setOpenColumn] = useState<number | null>(entries.length === 1 ? 0 : null);

  return (
    <div className="space-y-3">
      {entries.map((entry, index) => {
        const title = entry.table ? `${entry.table}.${entry.column}` : entry.fullName || entry.column;
        return (
          <article
            key={`${entry.table ?? "column"}-${entry.column}-${index}`}
            className="rounded-2xl border border-line/70 bg-card px-4 py-3 shadow-[0_8px_24px_rgba(24,32,28,0.04)]"
          >
            <button
              type="button"
              onClick={() => setOpenColumn((current) => (current === index ? null : index))}
              className="flex w-full items-start gap-3 text-left"
            >
              <span className="mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent">
                {entry.id ?? index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-[13px] font-semibold leading-5 text-ink">{title}</h4>
                    {entry.fullName && title !== entry.fullName && (
                      <p className="mt-1 text-[12px] leading-5 text-muted">{entry.fullName}</p>
                    )}
                  </div>
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 text-[18px] leading-none text-faint transition-transform",
                      openColumn === index && "rotate-45 text-accent",
                    )}
                  >
                    +
                  </span>
                </div>

                {openColumn === index && (
                  <div className="mt-2 space-y-2">
                    <p className="rounded-xl bg-hover/85 px-3 py-2 text-[12.5px] leading-6 text-ink">
                      {entry.explanation}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {entry.dataType && (
                        <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted">
                          Data type: <span className="font-mono text-ink">{entry.dataType}</span>
                        </span>
                      )}
                      {entry.example && (
                        <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted">
                          Example: <span className="font-mono text-ink">{entry.example}</span>
                        </span>
                      )}
                      {entry.possibleCategories && (
                        <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted">
                          Categories: <span className="text-ink">{entry.possibleCategories}</span>
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </button>
          </article>
        );
      })}
    </div>
  );
}

function DomainTopicsPreview({ topics }: { topics: DomainTopic[] }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-card px-3 py-2.5">
        <div className="text-[12.5px] font-medium text-ink">
          Output: {topics.length} available knowledge topic name{topics.length === 1 ? "" : "s"}
        </div>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          This tool only lists topic names. Use a knowledge definition tool to fetch formulas or explanations.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {topics.map((topic, index) => (
          <span
            key={`${topic.id ?? index}-${topic.name}`}
            className="max-w-full rounded-full border border-line bg-card px-2.5 py-1.5 text-[12px] font-medium leading-4 text-ink"
            title={topic.name}
          >
            {topic.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function EmptyPreview({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-card px-4 py-4">
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      {detail && <p className="mt-1 text-[12px] leading-5 text-muted">{detail}</p>}
    </div>
  );
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value as Record<string, unknown>).length} fields`;
  return String(value);
}

function tryParseJsonRows(result: string): PreviewTable | null {
  const stripped = stripSystemNote(result).trim();
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(stripped) as unknown;
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    const rowsValue = record && Array.isArray(record.rows) ? record.rows : Array.isArray(parsed) ? parsed : null;
    if (!rowsValue) return null;
    const truncated = record?.truncated === true;

    const columnHints = [
      record?.columns,
      record?.headers,
      record?.column_names,
    ].find((value): value is unknown[] => Array.isArray(value));

    const headersFromHints = columnHints
      ?.map((column) => {
        if (typeof column === "string") return column;
        if (column && typeof column === "object") {
          const columnRecord = column as Record<string, unknown>;
          const name = columnRecord.name ?? columnRecord.column ?? columnRecord.key;
          return typeof name === "string" ? name : null;
        }
        return null;
      })
      .filter((name): name is string => !!name);

    if (rowsValue.length === 0) {
      const rowCount = typeof record?.row_count === "number" ? record.row_count : 0;
      return {
        headers: headersFromHints ?? [],
        rows: [],
        truncated,
        emptyMessage: rowCount === 0 ? "No matching rows" : "No rows returned",
        emptyDetail: rowCount === 0
          ? "The SQL ran successfully, but the current filters did not match any rows."
          : "The SQL ran successfully, but the tool output did not include row data.",
      };
    }

    const firstRow = rowsValue[0];
    if (firstRow && typeof firstRow === "object" && !Array.isArray(firstRow)) {
      const seen = new Set<string>();
      const headers = (headersFromHints && headersFromHints.length > 0 ? headersFromHints : [])
        .filter((header) => {
          if (seen.has(header)) return false;
          seen.add(header);
          return true;
        });
      for (const row of rowsValue) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        for (const key of Object.keys(row as Record<string, unknown>)) {
          if (!seen.has(key)) {
            seen.add(key);
            headers.push(key);
          }
        }
      }
      if (headers.length === 0) return null;
      return {
        headers,
        rows: rowsValue.map((row) => {
          const rowRecord = row && typeof row === "object" && !Array.isArray(row)
            ? row as Record<string, unknown>
            : {};
          return headers.map((header) => stringifyCell(rowRecord[header]));
        }),
        truncated,
      };
    }

    if (Array.isArray(firstRow)) {
      const headers = headersFromHints && headersFromHints.length === firstRow.length
        ? headersFromHints
        : firstRow.map((_, index) => `Column ${index + 1}`);
      return {
        headers,
        rows: rowsValue
          .filter((row): row is unknown[] => Array.isArray(row))
          .map((row) => headers.map((_, index) => stringifyCell(row[index]))),
        truncated,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function tryParseEmbeddedTable(result: string): PreviewTable | null {
  const stripped = stripSystemNote(result).trim();
  const commentMatch = stripped.match(/\/\*[\s\S]*?(?:rows|header)[^\n]*\n(?:SELECT[^\n]*\n)?([\s\S]*?)\s*\*\//i);
  const tableText = commentMatch?.[1]?.trim();
  if (!tableText) return null;
  return parseResultTable(tableText);
}

function tryParseJsonValue(result: string): unknown | null {
  const stripped = stripSystemNote(result).trim();
  if (!stripped || (!stripped.startsWith("{") && !stripped.startsWith("["))) return null;
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function humanizeFieldName(value: string): string {
  return value
    .replace(/[_|]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function isSqlLike(text: string) {
  return /^(select|with|insert|update|delete|create|alter|drop|explain)\b/i.test(text.trim());
}

function StatusPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        ok
          ? "border-accent/25 bg-accent-soft text-accent"
          : "border-danger/30 bg-danger-soft text-danger",
      )}
    >
      {ok ? "Passed" : "Needs revision"}
    </span>
  );
}

function ValidationPreview({ record }: { record: Record<string, unknown> }) {
  const ok = record.ok === true;
  const detailEntries = Object.entries(record).filter(([key]) => key !== "ok" && key !== "normalized_sql");
  const rows: Array<[string, ReactNode]> = [
    ["Status", <StatusPill ok={ok} />],
    ...detailEntries.map(([key, value]): [string, ReactNode] => [
      humanizeFieldName(key),
      typeof value === "string" && isSqlLike(value)
        ? <SqlCodeBlock sql={value} showCopy />
        : <GenericJsonPreview value={value} compact />,
    ]),
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card">
      <table className="w-full border-collapse text-[13px]">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-line/70 last:border-b-0 align-top">
              <th className="w-36 bg-hover/60 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
                {label}
              </th>
              <td className="min-w-0 px-3 py-2 text-ink">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PlanRow = {
  depth: number;
  node: string;
  relation: string;
  strategy: string;
  cost: string;
  rows: string;
};

function collectPlanRows(value: unknown, depth = 0): PlanRow[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectPlanRows(item, depth));
  if (!isRecord(value)) return [];
  if (isRecord(value.Plan)) return collectPlanRows(value.Plan, depth);

  const nodeType = typeof value["Node Type"] === "string" ? value["Node Type"] : "";
  const relation = [value["Schema"], value["Relation Name"]].filter((part) => typeof part === "string" && part).join(".");
  const strategy = [value["Join Type"], value["Strategy"], value["Parent Relationship"]]
    .filter((part) => typeof part === "string" && part)
    .join(" / ");
  const startupCost = typeof value["Startup Cost"] === "number" ? value["Startup Cost"] : undefined;
  const totalCost = typeof value["Total Cost"] === "number" ? value["Total Cost"] : undefined;
  const planRows = typeof value["Plan Rows"] === "number" ? value["Plan Rows"] : undefined;
  const current: PlanRow[] = nodeType
    ? [{
        depth,
        node: nodeType,
        relation: relation || "—",
        strategy: strategy || "—",
        cost: startupCost !== undefined && totalCost !== undefined ? `${startupCost}..${totalCost}` : "—",
        rows: planRows !== undefined ? String(planRows) : "—",
      }]
    : [];
  const children = Array.isArray(value.Plans)
    ? value.Plans.flatMap((child) => collectPlanRows(child, depth + 1))
    : [];
  return [...current, ...children];
}

function ExplainPlanPreview({ record }: { record: Record<string, unknown> }) {
  const query = typeof record.query === "string" ? record.query : "";
  const planRows = collectPlanRows(record.plan);

  return (
    <div className="space-y-3">
      {query && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Explained SQL</div>
          <SqlCodeBlock sql={query} showCopy />
        </div>
      )}
      {planRows.length > 0 ? (
        <div className="overflow-auto rounded-xl border border-line">
          <table className="w-full min-w-max border-collapse text-[12px]">
            <thead>
              <tr className="bg-hover">
                <th className="border-b border-line px-2 py-1.5 text-left font-medium text-muted">Node</th>
                <th className="border-b border-line px-2 py-1.5 text-left font-medium text-muted">Relation</th>
                <th className="border-b border-line px-2 py-1.5 text-left font-medium text-muted">Strategy</th>
                <th className="border-b border-line px-2 py-1.5 text-right font-medium text-muted">Cost</th>
                <th className="border-b border-line px-2 py-1.5 text-right font-medium text-muted">Rows</th>
              </tr>
            </thead>
            <tbody>
              {planRows.map((row, index) => (
                <tr key={`${row.node}-${index}`} className="even:bg-surface/60">
                  <td className="border-b border-line/50 px-2 py-1.5 font-medium text-ink" style={{ paddingLeft: `${8 + row.depth * 14}px` }}>
                    {row.node}
                  </td>
                  <td className="border-b border-line/50 px-2 py-1.5 text-muted">{row.relation}</td>
                  <td className="border-b border-line/50 px-2 py-1.5 text-muted">{row.strategy}</td>
                  <td className="border-b border-line/50 px-2 py-1.5 text-right font-mono text-[11.5px] text-ink">{row.cost}</td>
                  <td className="border-b border-line/50 px-2 py-1.5 text-right font-mono text-[11.5px] text-ink">{row.rows}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <GenericJsonPreview value={record.plan} />
      )}
    </div>
  );
}

function GenericFieldsPreview({ entries }: { entries: Array<[string, unknown]> }) {
  return (
    <div className="grid gap-2">
      {entries.map(([key, value]) => (
        <div key={key} className="rounded-2xl border border-line bg-card px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{humanizeFieldName(key)}</div>
          <div className="mt-1 text-[13px] leading-relaxed text-ink">
            {typeof value === "string" && isSqlLike(value) ? (
              <SqlCodeBlock sql={value} showCopy />
            ) : (
              <GenericJsonPreview value={value} compact />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function GenericJsonPreview({ value, compact = false }: { value: unknown; compact?: boolean }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted">No value returned</span>;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return <span className={typeof value === "number" || typeof value === "bigint" ? "font-mono tabular-nums" : ""}>{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <EmptyPreview title="No items returned" />;
    }
    const objectItems = value.filter(isRecord);
    if (objectItems.length === value.length) {
      const headers = Array.from(new Set(objectItems.flatMap((item) => Object.keys(item))));
      return (
        <div className="overflow-auto rounded-xl border border-line">
          <table className="w-full min-w-max border-collapse text-[12px]">
            <thead>
              <tr className="bg-hover">
                {headers.map((header) => (
                  <th key={header} className="border-b border-line px-2 py-1.5 text-left font-medium text-muted">
                    {humanizeFieldName(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {objectItems.map((item, rowIndex) => (
                <tr key={rowIndex} className="even:bg-surface/60">
                  {headers.map((header) => (
                    <td key={`${rowIndex}-${header}`} className="border-b border-line/50 px-2 py-1.5 text-ink">
                      {stringifyCell(item[header]) || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    const shown = compact ? value.slice(0, 6) : value;
    return (
      <div className="flex flex-wrap gap-2">
        {shown.map((item, index) => (
          <span key={index} className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted">
            {stringifyCell(item)}
          </span>
        ))}
        {shown.length < value.length && (
          <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-faint">
            +{value.length - shown.length} more
          </span>
        )}
      </div>
    );
  }
  if (isRecord(value)) {
    return <GenericFieldsPreview entries={Object.entries(value)} />;
  }
  return <span>{String(value)}</span>;
}

function PlainTextPreview({ text }: { text: string }) {
  const clean = stripSystemNote(text).trim();
  if (!clean) return <EmptyPreview title="No output returned" />;
  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-3 text-[13px] leading-relaxed text-ink">
      <div className="whitespace-pre-wrap">{clean}</div>
    </div>
  );
}

function toolLabel(name: string): string {
  return humanizeToolName(name);
}

function nodeLabel(n: ThreadNode): string {
  switch (n.kind) {
    case "question":
      return "Your question";
    case "thinking":
      return "Thinking";
    case "tool":
      return toolLabel(n.title ?? "");
    case "agent_question":
      return "Asking you";
    case "user_answer":
      return "You answered";
    case "answer":
      return "Final SQL";
    case "agent_text":
      return "Answer";
  }
}

function nodePalette(n: ThreadNode): Palette {
  switch (n.kind) {
    case "question":
    case "user_answer":
    case "thinking":
      return NEUTRAL;
    default:
      return ACCENT;
  }
}

function checkpointSummary(n: ThreadNode): string {
  if (n.kind === "tool") return summarizeTool(n.title ?? "", n.result ?? "");
  if (n.kind === "answer") {
    const table = n.result ? parseResultTable(n.result) : null;
    const rows = table?.rows.length ?? 0;
    return rows > 0 ? `Prepared final SQL with ${rows} result row${rows === 1 ? "" : "s"}` : "Prepared final SQL";
  }
  if (n.kind === "agent_question") return "Requested clarification before finalizing SQL";
  return nodeLabel(n);
}

function nodeAsCheckpoint(n: ThreadNode, order: number): Checkpoint | null {
  if (n.kind !== "tool" && n.kind !== "answer" && n.kind !== "agent_question") return null;
  return {
    nodeId: n.id,
    order,
    label: nodeLabel(n),
    summary: checkpointSummary(n),
    toolName: n.kind === "tool" ? n.title ?? undefined : n.kind === "answer" ? "submit_sql" : "ask_user",
  };
}

export function buildCheckpoints(conversation: Conversation): Checkpoint[] {
  return buildCheckpointGroups(conversation).flatMap((group) => group.checkpoints);
}

export function buildCheckpointGroups(conversation: Conversation): CheckpointGroup[] {
  const nodes = buildNodes(conversation.timeline, conversation.title);
  let order = 0;
  const groups: CheckpointGroup[] = [];
  let current: CheckpointGroup | null = null;

  for (const n of nodes) {
    if (n.kind === "question") {
      current = {
        id: n.id,
        question: n.body,
        checkpoints: [],
      };
      groups.push(current);
      continue;
    }

    const item = nodeAsCheckpoint(n, order + 1);
    if (!item) continue;
    order += 1;
    if (!current) {
      current = {
        id: "root",
        question: conversation.title,
        checkpoints: [],
      };
      groups.push(current);
    }
    current.checkpoints.push(item);
  }

  return groups.filter((group) => group.checkpoints.length > 0);
}

function StepIcon({ n }: { n: ThreadNode }) {
  const cls = "h-3.5 w-3.5";
  if (n.kind === "tool") {
    const name = n.title ?? "";
    if (name === "execute_sql" || name === "run_postgres_readonly") return <Terminal className={cls} />;
    if (name.startsWith("get_schema") || name.includes("postgres_table") || name.includes("column")) return <Table2 className={cls} />;
    if (name.includes("knowledge")) return <BookOpen className={cls} />;
    return <Terminal className={cls} />;
  }
  if (n.kind === "answer") return <Database className={cls} />;
  if (n.kind === "agent_question") return <MessageCircleQuestion className={cls} />;
  if (n.kind === "user_answer" || n.kind === "question") return <User className={cls} />;
  if (n.kind === "agent_text") return <Sparkles className={cls} />;
  return <span className="text-[10px] leading-none">···</span>;
}

export function ResultPreview({ result, toolName }: { result: string; toolName?: string }) {
  const strippedResult = stripSystemNote(result).trim();
  const parsedJson = useMemo(() => tryParseJsonValue(result), [result]);
  const domainTopics = useMemo(() => {
    if (toolName !== "get_all_external_knowledge_names") return null;
    return tryParseDomainTopics(result);
  }, [result, toolName]);
  const columnMeanings = useMemo(() => {
    if (toolName !== "get_column_meaning" && toolName !== "get_all_column_meanings") return null;
    return tryParseColumnMeanings(result);
  }, [result, toolName]);
  const knowledgeEntries = useMemo(() => {
    if (!toolName || !toolName.includes("knowledge")) return null;
    return tryParseKnowledgeEntries(result);
  }, [result, toolName]);
  const schemaTables = useMemo(() => {
    if (!isSchemaToolName(toolName)) return null;
    return parseSchemaTables(result);
  }, [result, toolName]);

  if (domainTopics) {
    return <DomainTopicsPreview topics={domainTopics} />;
  }
  if (toolName === "get_all_external_knowledge_names" && strippedResult === "[]") {
    return (
      <EmptyPreview
        title="No knowledge topics found"
        detail="The knowledge browser returned an empty topic list for this database."
      />
    );
  }
  if (columnMeanings) {
    return <ColumnMeaningsPreview entries={columnMeanings} />;
  }
  if ((toolName === "get_column_meaning" || toolName === "get_all_column_meanings") && /no column meanings available/i.test(strippedResult)) {
    return (
      <EmptyPreview
        title="No column meanings available"
        detail="This database did not provide extra column descriptions for the requested scope."
      />
    );
  }
  if (knowledgeEntries) {
    return <KnowledgePreview entries={knowledgeEntries} />;
  }
  if (schemaTables) {
    return <SchemaPreview tables={schemaTables} />;
  }

  if (isRecord(parsedJson)) {
    if (isValidationToolName(toolName) || "ok" in parsedJson) return <ValidationPreview record={parsedJson} />;
    if (isExplainToolName(toolName) && "plan" in parsedJson) return <ExplainPlanPreview record={parsedJson} />;
  }

  const table = tryParseJsonRows(result) ?? parseResultTable(strippedResult) ?? tryParseEmbeddedTable(strippedResult);
  if (table) return <TablePreview table={table} />;

  if (isRecord(parsedJson)) {
    return <GenericJsonPreview value={parsedJson} />;
  }

  if (Array.isArray(parsedJson)) {
    return <GenericJsonPreview value={parsedJson} />;
  }

  return <PlainTextPreview text={strippedResult} />;
}

function TablePreview({ table }: { table: PreviewTable }) {
  if (table.rows.length === 0) {
    return (
      <EmptyPreview
        title={table.emptyMessage ?? "No rows returned"}
        detail={table.emptyDetail ?? (table.headers.length > 0 ? `Columns: ${table.headers.join(", ")}` : undefined)}
      />
    );
  }
  return (
    <div className="overflow-auto rounded-xl border border-line">
      <table className="w-full min-w-max border-collapse text-[12px]">
        <thead className="sticky top-0">
          <tr>
            {table.headers.map((h, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-line bg-hover px-2 py-1.5 text-right font-medium text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="even:bg-surface/60">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  title={cell}
                  className="whitespace-nowrap border-b border-line/50 px-2 py-1.5 text-right text-ink tabular-nums"
                >
                  {formatCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated && (
        <div className="border-t border-line bg-hover/50 px-3 py-2 text-[11px] text-faint">
          Showing a truncated preview.
        </div>
      )}
    </div>
  );
}

export function DetailBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{label}</div>
      {children}
    </div>
  );
}

function TraceDetail({ n }: { n: ThreadNode }) {
  const palette = nodePalette(n);
  const result = "result" in n ? n.result : undefined;
  const isKnowledgeNamesTool = n.kind === "tool" && n.title === "get_all_external_knowledge_names";
  const isKnowledgeDefinitionTool = n.kind === "tool" && n.title === "get_knowledge_definition";
  const isKnowledgeResultTool =
    isKnowledgeNamesTool || isKnowledgeDefinitionTool || (n.kind === "tool" && n.title === "get_all_knowledge_definitions");

  return (
    <div className="bg-transparent">
      <div className="flex items-start gap-3 px-5 py-5">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl",
            palette.bg,
            palette.fg,
          )}
        >
          <StepIcon n={n} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-[13px] font-medium", n.kind === "thinking" ? "text-muted" : "text-ink")}>
            {nodeLabel(n)}
          </div>
          {(n.kind === "tool" || n.kind === "answer" || n.kind === "agent_question") && (
            <div className="mt-0.5 truncate text-[12px] text-muted">{checkpointSummary(n)}</div>
          )}
        </div>
      </div>

      <div className="space-y-4 px-5 pb-6 pl-[56px]">
        {n.kind === "tool" && (
          <>
            {n.body && isSqlToolName(n.title) && (
              <DetailBlock label="SQL">
                <SqlCodeBlock sql={stripSystemNote(n.body)} showCopy />
              </DetailBlock>
            )}
            {result && (
              isKnowledgeResultTool ? (
                <ResultPreview result={result} toolName={n.title} />
              ) : isSqlToolName(n.title) ? (
                <DetailBlock label="Result">
                  <ResultPreview result={result} toolName={n.title} />
                </DetailBlock>
              ) : (
                <ResultPreview result={result} toolName={n.title} />
              )
            )}
          </>
        )}

        {n.kind === "answer" && (
          <>
            {n.body && (
              <DetailBlock label="Final SQL">
                <SqlCodeBlock sql={n.body} showCopy />
              </DetailBlock>
            )}
            {result !== undefined && (
              <DetailBlock label="Returned rows">
                <ResultPreview result={result} toolName="submit_sql" />
              </DetailBlock>
            )}
          </>
        )}

        {n.kind !== "tool" && n.kind !== "answer" && n.body && (
          <pre className="overflow-auto whitespace-pre-wrap font-sans text-[13px] leading-snug text-ink">
            {n.kind === "agent_question" ? n.body : stripSystemNote(n.body)}
          </pre>
        )}
      </div>
    </div>
  );
}

export function ProcessTimeline({
  conversation,
  openTabIds,
  selectedId,
  onSelect,
  onCloseTab,
  hideTabs = false,
}: {
  conversation: Conversation;
  openTabIds: string[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onCloseTab: (id: string) => void;
  hideTabs?: boolean;
}) {
  const nodes = useMemo(() => buildNodes(conversation.timeline, conversation.title), [conversation.timeline, conversation.title]);
  const checkpoints = useMemo(() => buildCheckpoints(conversation), [conversation]);
  const activeSelectedId = selectedId ?? openTabIds[openTabIds.length - 1] ?? null;
  const openTabs = openTabIds
    .map((id) => {
      const checkpoint = checkpoints.find((cp) => cp.nodeId === id);
      const node = nodes.find((n) => n.id === id);
      return checkpoint && node ? { checkpoint, node } : null;
    })
    .filter((item): item is { checkpoint: Checkpoint; node: ThreadNode } => item !== null);
  const activeTab = openTabs.find((t) => t.checkpoint.nodeId === activeSelectedId) ?? null;

  return (
    <div className="app-shell-bg flex h-full flex-col">
      {!hideTabs && (
        <div className="flex h-[56px] items-center border-b border-line/60 bg-transparent px-4">
          <div className="flex w-full gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {openTabs.map(({ checkpoint }) => {
              const active = checkpoint.nodeId === activeSelectedId;
              return (
                <button
                  key={checkpoint.nodeId}
                  onClick={() => onSelect?.(checkpoint.nodeId)}
                  className={cn(
                    "group flex shrink-0 items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-all",
                    active
                      ? "border-line/80 bg-card text-ink shadow-sm"
                      : "border-transparent bg-hover/55 text-muted hover:border-line/50 hover:bg-hover/80 hover:text-ink",
                  )}
                >
                  <span className={cn("shrink-0 text-[11px] font-semibold", active ? "text-muted" : "text-faint")}>{checkpoint.order}</span>
                  <span className="whitespace-nowrap text-[12.5px] font-medium">{compactTabLabel(checkpoint.label)}</span>
                  <span
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(checkpoint.nodeId);
                    }}
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-all",
                      active ? "opacity-100 text-faint hover:bg-hover hover:text-muted" : "opacity-0 text-faint group-hover:opacity-100 hover:bg-hover hover:text-muted",
                    )}
                    role="button"
                    aria-label={`Close ${checkpoint.label}`}
                  >
                    <X className="h-3 w-3" />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className={cn("flex-1 overflow-y-auto bg-transparent", hideTabs ? "px-4 py-4" : "px-4 py-4")}>
        {activeTab ? (
          <TraceDetail n={activeTab.node} />
        ) : (
          <div className="rounded-2xl border border-dashed border-line bg-card px-4 py-6 text-[13px] text-muted">
            Pick a step to open its output here.
          </div>
        )}
      </div>
    </div>
  );
}
