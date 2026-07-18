import { useState } from "react";
import { Check, Code2, Copy, Table2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatCell, parseResultTable } from "../../lib/parseResultTable";
import { formatSql } from "../../lib/formatSql";
import { tokenizeSql, type SqlTokenType } from "../../lib/highlightSql";

// Light SQL theme: magenta keywords, red strings, blue numbers; functions and
// identifiers stay near-black (matches the reference editor color scheme).
const SQL_TOKEN_CLASS: Record<SqlTokenType, string> = {
  keyword: "text-[#af00db]",
  function: "text-[#1f2328]",
  string: "text-[#c41a16]",
  number: "text-[#1750eb]",
  comment: "text-[#008000]",
  operator: "text-[#1f2328]",
  plain: "text-[#1f2328]",
};

function HighlightedSql({ sql }: { sql: string }) {
  const displaySql = formatSql(sql) || sql.trim();
  return (
    <pre className="max-h-[320px] overflow-auto bg-white p-4 font-mono text-[12.5px] leading-relaxed text-[#1f2328]">
      <code>
        {tokenizeSql(displaySql).map((tok, i) => (
          <span key={i} className={SQL_TOKEN_CLASS[tok.type]}>
            {tok.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * The final artifact, shown as one tabbed card for the result table or the SQL
 * that produced it.
 */
type Tab = "result" | "sql";

type ResultArtifactProps = {
  result: string | null;
  sql: string | null;
  question?: string;
};

export function ResultArtifact({ result, sql, question = "" }: ResultArtifactProps) {
  void question;
  const tabs: Tab[] = [];
  if (result) tabs.push("result");
  if (sql) tabs.push("sql");

  // null = follow the default (Result when available). Once the user picks a
  // tab we respect it, even as content streams in.
  const [active, setActive] = useState<Tab | null>(null);
  const [copied, setCopied] = useState(false);

  const preferred: Tab = result ? "result" : "sql";
  const current = active && tabs.includes(active) ? active : preferred;

  if (tabs.length === 0) return null;
  const table = current === "result" && result ? parseResultTable(result) : null;

  function copySql() {
    if (!sql) return;
    navigator.clipboard.writeText(formatSql(sql) || sql.trim()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
      <header className="flex items-center justify-between border-b border-line px-4">
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setActive(t)}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 text-[13px] font-medium transition-colors",
                current === t
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              {t === "result" ? (
                <Table2 className="h-4 w-4" />
              ) : (
                <Code2 className="h-4 w-4" />
              )}
              {t === "result" ? "Result" : "SQL"}
            </button>
          ))}
        </div>

        {current === "result" && table && (
          <span className="text-[12px] text-faint">
            {table.rows.length} row{table.rows.length === 1 ? "" : "s"}
            {table.truncated && " (truncated)"}
          </span>
        )}
        {current === "sql" && (
          <button
            onClick={copySql}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-hover"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </header>

      {current === "result" && result && (
        <div className="min-w-0">
          {!table ? (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 text-[13px] leading-relaxed text-muted">
              {result}
            </pre>
          ) : (
            <div className="max-h-[360px] overflow-auto">
              <table className="min-w-max w-full border-collapse text-[13px]">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {table.headers.map((h, i) => (
                      <th
                        key={i}
                        className="whitespace-nowrap border-b border-line bg-hover px-3 py-1.5 text-right font-semibold text-muted"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, ri) => (
                    <tr key={ri} className="even:bg-surface/60 hover:bg-accent-soft/40">
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          title={cell}
                          className="whitespace-nowrap border-b border-line/50 px-3 py-1 text-right text-ink tabular-nums"
                        >
                          {formatCell(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {table.truncated && (
                <div className="bg-hover px-3 py-1.5 text-[12px] text-faint">result truncated…</div>
              )}
            </div>
          )}
        </div>
      )}

      {current === "sql" && sql && <HighlightedSql sql={sql} />}
    </section>
  );
}
