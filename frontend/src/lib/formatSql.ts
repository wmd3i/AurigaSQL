const BREAK_BEFORE = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "WITH",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "CASE",
  "END",
];

const BREAK_AND_INDENT = ["ON", "AND", "OR", "WHEN", "THEN", "ELSE"];

function protectStrings(sql: string): { protectedSql: string; strings: string[] } {
  const strings: string[] = [];
  const protectedSql = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (match) => {
    const marker = `__SQL_STRING_${strings.length}__`;
    strings.push(match);
    return marker;
  });
  return { protectedSql, strings };
}

function restoreStrings(sql: string, strings: string[]): string {
  return sql.replace(/__SQL_STRING_(\d+)__/g, (_, index: string) => strings[Number(index)] ?? "");
}

export function ensureRunnableSql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) return "";
  return /;\s*$/.test(trimmed) ? trimmed : `${trimmed};`;
}

export function formatSql(sql: string): string {
  const raw = sql.trim();
  if (!raw) return "";

  const { protectedSql, strings } = protectStrings(raw);
  let formatted = protectedSql.replace(/\s+/g, " ").trim();

  for (const phrase of BREAK_BEFORE) {
    const escaped = phrase.replace(/\s+/g, "\\s+");
    formatted = formatted.replace(new RegExp(`\\s*\\b${escaped}\\b\\s*`, "gi"), `\n${phrase} `);
  }

  for (const phrase of BREAK_AND_INDENT) {
    const escaped = phrase.replace(/\s+/g, "\\s+");
    formatted = formatted.replace(new RegExp(`\\s+\\b${escaped}\\b\\s+`, "gi"), `\n  ${phrase} `);
  }

  formatted = formatted
    .replace(/\s*,\s*/g, ",\n  ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\n{2,}/g, "\n")
    .trim();

  formatted = restoreStrings(formatted, strings);

  const lines = formatted
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const formattedBody = lines
    .map((line) => {
      const upper = line.toUpperCase();
      if (/^(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION|WITH)\b/.test(upper)) {
        return line;
      }
      if (/^(JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL JOIN|CROSS JOIN)\b/.test(upper)) return line;
      if (/^CASE\b/.test(upper)) return `  ${line}`;
      if (/^WHEN\b/.test(upper)) return `    ${line}`;
      if (/^THEN\b/.test(upper)) return `      ${line}`;
      if (/^ELSE\b/.test(upper)) return `    ${line}`;
      if (/^END\b/.test(upper)) return `  ${line}`;
      if (/^(ON|AND|OR)\b/.test(upper)) return `  ${line}`;
      return `  ${line}`;
    })
    .join("\n");
  return ensureRunnableSql(formattedBody);
}
