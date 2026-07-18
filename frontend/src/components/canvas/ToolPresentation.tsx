import { useState, type ReactNode } from "react";
import { ListTree, Rows3, Table2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatCell, parseResultTable } from "../../lib/parseResultTable";
import { summarizeTool } from "../../lib/summarizeTool";

function humanizeKey(value: string): string {
  return value
    .replace(/[_|]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function displayValue(value: unknown, limit: number) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return truncate(value, limit);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value as Record<string, unknown>).length} fields`;
  return truncate(String(value), limit);
}

const scrollSurfaceClass =
  "nodrag nopan nowheel overflow-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)]";

function parseJson(raw: string): unknown | null {
  const text = raw.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function splitPathKey(raw: string) {
  const parts = raw.split("|").filter(Boolean);
  if (parts.length >= 2) {
    return {
      title: `${parts[parts.length - 2]}.${parts[parts.length - 1]}`,
      caption: parts.slice(0, -2).join(" / "),
    };
  }
  return { title: raw, caption: "" };
}

function parseSchema(raw: string) {
  const tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }> = [];
  for (const match of raw.matchAll(/CREATE TABLE "([^"]+)"\s*\(([\s\S]*?)\);/g)) {
    const [, name, body] = match;
    const columns = body
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line && !/^(PRIMARY KEY|CONSTRAINT|UNIQUE|FOREIGN KEY)/i.test(line))
      .map((line) => {
        const col = line.match(/^"?([a-zA-Z0-9_]+)"?\s+(.+)$/);
        return col ? { name: col[1], type: col[2] } : null;
      })
      .filter((item): item is { name: string; type: string } => Boolean(item));
    tables.push({ name, columns });
  }
  return tables;
}

function MiniTable({ result }: { result: string }) {
  const table = parseResultTable(result);
  if (!table) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line bg-hover px-3 py-2 text-[12px] font-medium text-muted">
        <Table2 className="h-3.5 w-3.5" />
        Preview
      </div>
      <div className={scrollSurfaceClass}>
        <table className="min-w-max w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {table.headers.map((header, index) => (
                <th key={index} className="whitespace-nowrap border-b border-line bg-hover/70 px-3 py-2 text-right font-semibold text-muted">
                  {humanizeKey(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="even:bg-surface/70">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="whitespace-nowrap border-b border-line/50 px-3 py-2 text-right text-ink tabular-nums">
                    {formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 text-[11px] text-faint">
        Showing {table.rows.length} row{table.rows.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function KeyValueGrid({
  entries,
  compact = false,
}: {
  entries: Array<{ label: string; value: string }>;
  compact?: boolean;
}) {
  const shown = compact ? entries.slice(0, 4) : entries;
  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-1")}>
      {shown.map((entry) => (
        <div key={`${entry.label}:${entry.value}`} className="rounded-2xl border border-line bg-hover/50 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{entry.label}</div>
          <div className="mt-1 text-[13px] leading-relaxed text-ink">{entry.value}</div>
        </div>
      ))}
      {compact && entries.length > shown.length && (
        <div className="text-[11px] text-faint">+{entries.length - shown.length} more details available</div>
      )}
    </div>
  );
}

function SummaryBanner({ title, icon }: { title: string; icon: ReactNode }) {
  return (
    <div className="rounded-2xl border border-accent/20 bg-accent-soft/60 px-3 py-2">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        {icon}
        <span>{title}</span>
      </div>
    </div>
  );
}

function SummaryText({ title }: { title: string }) {
  return <div className="text-[12px] font-medium text-faint">{title}</div>;
}

function CompactChipList(props: {
  items: Array<{ name: string; meta?: string }>;
  initialCount?: number;
  itemLabel: string;
}) {
  const { items, initialCount = 12, itemLabel } = props;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, initialCount);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((item) => (
          <span
            key={`${item.name}:${item.meta ?? ""}`}
            className="inline-flex max-w-full items-center rounded-full border border-line bg-card px-2 py-0.5 text-[11px] leading-tight text-muted"
            title={item.meta ? `${item.name} • ${item.meta}` : item.name}
          >
            <span className="truncate">{item.name}</span>
            {item.meta && <span className="ml-1 shrink-0 text-[10px] text-faint">{item.meta}</span>}
          </span>
        ))}
      </div>
      {items.length > initialCount && (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="text-left text-[12px] font-medium text-muted hover:text-accent"
        >
          {showAll ? "Show less" : `Show ${items.length - initialCount} more ${itemLabel}`}
        </button>
      )}
    </div>
  );
}

function DomainTopicsCompactPreview(props: { names: string[]; compact: boolean }) {
  const { names, compact } = props;

  return (
    <div className="space-y-2">
      <SummaryText title={`Loaded ${names.length} domain topics`} />
      <CompactChipList
        items={names.map((name) => ({ name }))}
        initialCount={compact ? 12 : names.length}
        itemLabel="topics"
      />
    </div>
  );
}

export function ToolArgumentsView(props: { body: string; compact?: boolean }) {
  const parsed = parseJson(props.body);

  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => value !== "" && value !== null && value !== undefined)
      .map(([key, value]) => ({
        label: humanizeKey(key),
        value: displayValue(value, props.compact ? 120 : 240),
      }));
    if (entries.length === 0) return null;
    return (
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">This step used</div>
        <KeyValueGrid entries={entries} compact={props.compact} />
      </div>
    );
  }

  if (!props.body.trim()) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">This step used</div>
      <div className="rounded-2xl border border-line bg-hover/50 px-3 py-2 text-[13px] leading-relaxed text-ink">
        {truncate(props.body.trim(), props.compact ? 180 : 360)}
      </div>
    </div>
  );
}

export function ToolResultView(props: { toolName: string; result: string; compact?: boolean }) {
  const { toolName, result, compact = false } = props;
  const summary = summarizeTool(toolName, result);

  if (result.startsWith("Error")) {
    return (
      <div className="space-y-2">
        <SummaryBanner title={summary} icon={<Rows3 className="h-4 w-4 text-danger" />} />
        <div className="rounded-2xl border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger">
          {truncate(result, compact ? 220 : 520)}
        </div>
      </div>
    );
  }

  if (toolName === "get_schema") {
    const tables = parseSchema(result);
    if (tables.length > 0) {
      return (
        <div className="space-y-2">
          <SummaryText title={summary} />
          {compact ? (
            <CompactChipList
              items={tables.map((table) => ({ name: table.name }))}
              itemLabel="tables"
            />
          ) : (
            tables.map((table) => (
              <div key={table.name} className="rounded-2xl border border-line bg-card px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[14px] font-semibold text-ink">{table.name}</div>
                  <div className="text-[11px] text-faint">{table.columns.length} columns</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {table.columns.slice(0, 8).map((column) => (
                    <div key={column.name} className="rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted">
                      <span className="font-medium text-ink">{column.name}</span>
                      <span className="ml-1">{truncate(column.type, 18)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      );
    }
  }

  if (toolName === "get_all_column_meanings" || toolName === "get_column_meaning") {
    const parsed = parseJson(result);
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      const entries = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
        const path = splitPathKey(key);
        return {
          label: path.title,
          value: `${path.caption ? `${path.caption} • ` : ""}${truncate(String(value), compact ? 120 : 220)}`,
        };
      });
      return (
        <div className="space-y-2">
          <SummaryBanner title={summary} icon={<ListTree className="h-4 w-4 text-accent" />} />
          <KeyValueGrid entries={entries} compact={compact} />
        </div>
      );
    }
  }

  if (toolName === "get_knowledge_definition" || toolName === "get_all_knowledge_definitions") {
    const parsed = parseJson(result);
    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const normalized = items
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          name: String(record.knowledge_name ?? record.knowledge ?? record.name ?? "Definition"),
          description: String(record.description ?? record.explanation ?? ""),
        };
      })
      .filter((item) => item.description || item.name);
    if (normalized.length > 0) {
      return (
        <div className="space-y-2">
          <SummaryText title={summary} />
          {compact ? (
            <CompactChipList
              items={normalized.map((item) => ({ name: item.name }))}
              itemLabel="terms"
            />
          ) : (
            normalized.map((item) => (
              <div key={`${item.name}:${item.description}`} className="rounded-2xl border border-line bg-hover/50 px-3 py-2">
                <div className="text-[13px] font-semibold text-ink">{item.name}</div>
                {item.description && (
                <div className="mt-1 text-[13px] leading-relaxed text-muted">
                  {truncate(item.description, 280)}
                </div>
                )}
              </div>
            ))
          )}
        </div>
      );
    }
  }

  if (toolName === "get_all_external_knowledge_names") {
    const parsed = parseJson(result);
    if (Array.isArray(parsed)) {
      const names = parsed.map((item) => String(item));
      return <DomainTopicsCompactPreview names={names} compact={compact} />;
    }
  }

  const table = parseResultTable(result);
  if (table) {
    return (
      <div className="space-y-2">
        <SummaryBanner title={summary} icon={<Rows3 className="h-4 w-4 text-accent" />} />
        <MiniTable result={result} />
      </div>
    );
  }

  const parsed = parseJson(result);
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    const entries = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
      label: humanizeKey(key),
      value: displayValue(value, compact ? 120 : 220),
    }));
    return (
      <div className="space-y-2">
        <SummaryBanner title={summary} icon={<Rows3 className="h-4 w-4 text-accent" />} />
        <KeyValueGrid entries={entries} compact={compact} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <SummaryBanner title={summary} icon={<Rows3 className="h-4 w-4 text-accent" />} />
      <div className="rounded-2xl border border-line bg-hover/50 px-3 py-2 text-[13px] leading-relaxed text-muted">
        {truncate(result.trim(), compact ? 200 : 420)}
      </div>
    </div>
  );
}
