import type { ReactNode } from "react";

/**
 * Minimal inline markdown for agent clarification text: **bold**, *italic*,
 * `code`, and numbered lists. Not a full parser — just enough so the raw
 * asterisks/backticks the model emits render as readable rich text.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${k++}`;
    if (tok.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {renderInline(tok.slice(2, -2), key)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code
          key={key}
          className="rounded bg-card px-1 py-0.5 font-mono text-[12px] text-accent ring-1 ring-inset ring-accent/20"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <em key={key} className="italic">
          {renderInline(tok.slice(1, -1), key)}
        </em>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  // break inline "1. … 2. …" enumerations onto their own lines
  const lines = text.replace(/\s+(\d+)\.\s+/g, "\n$1. ").split("\n");

  return (
    <div className={className}>
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const numbered = trimmed.match(/^(\d+)\.\s+(.*)$/s);
        if (numbered) {
          return (
            <div key={i} className="mt-1.5 flex gap-2">
              <span className="shrink-0 font-semibold text-accent">{numbered[1]}.</span>
              <span>{renderInline(numbered[2], `l${i}`)}</span>
            </div>
          );
        }
        return (
          <p key={i} className={i > 0 ? "mt-1.5" : undefined}>
            {renderInline(trimmed, `l${i}`)}
          </p>
        );
      })}
    </div>
  );
}
