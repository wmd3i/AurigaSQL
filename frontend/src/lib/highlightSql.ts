export type SqlTokenType =
  | "keyword"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "operator"
  | "plain";

export type SqlToken = { text: string; type: SqlTokenType };

// Reserved words get the keyword color; common types are included so casts like
// `::numeric` read well. Everything is matched case-insensitively.
const KEYWORDS = new Set([
  "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "BETWEEN", "BY", "CASE",
  "CAST", "CHECK", "COLUMN", "CONSTRAINT", "CREATE", "CROSS", "CURRENT_DATE",
  "CURRENT_TIME", "CURRENT_TIMESTAMP", "DATABASE", "DEFAULT", "DELETE", "DESC",
  "DISTINCT", "DROP", "ELSE", "END", "EXCEPT", "EXISTS", "FALSE", "FETCH",
  "FILTER", "FOREIGN", "FROM", "FULL", "GROUP", "HAVING", "IN", "INDEX", "INNER",
  "INSERT", "INTERSECT", "INTO", "IS", "JOIN", "KEY", "LEFT", "LIKE", "LIMIT",
  "NATURAL", "NOT", "NULL", "NULLS", "OFFSET", "ON", "OR", "ORDER", "OUTER",
  "OVER", "PARTITION", "PRIMARY", "REFERENCES", "RIGHT", "SELECT", "SET", "TABLE",
  "THEN", "TRUE", "UNION", "UNIQUE", "UPDATE", "USING", "VALUES", "VIEW", "WHEN",
  "WHERE", "WINDOW", "WITH", "WITHIN", "ILIKE", "RETURNING", "RECURSIVE",
  "BIGINT", "BOOLEAN", "BYTEA", "CHAR", "DATE", "DECIMAL", "DOUBLE", "FLOAT",
  "INT", "INTEGER", "INTERVAL", "JSON", "JSONB", "NUMERIC", "PRECISION", "REAL",
  "SERIAL", "SMALLINT", "TEXT", "TIME", "TIMESTAMP", "UUID", "VARCHAR",
]);

const TOKEN_RE =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'|"(?:[^"]|"")*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|(\s+)|([^\s])/g;

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(sql)) !== null) {
    const [full, comment, str, num, word, ws, other] = m;
    if (comment !== undefined) {
      tokens.push({ text: full, type: "comment" });
    } else if (str !== undefined) {
      tokens.push({ text: full, type: "string" });
    } else if (num !== undefined) {
      tokens.push({ text: full, type: "number" });
    } else if (word !== undefined) {
      if (KEYWORDS.has(word.toUpperCase())) {
        tokens.push({ text: full, type: "keyword" });
      } else {
        const rest = sql.slice(TOKEN_RE.lastIndex);
        tokens.push({ text: full, type: /^\s*\(/.test(rest) ? "function" : "plain" });
      }
    } else if (ws !== undefined) {
      tokens.push({ text: full, type: "plain" });
    } else if (other !== undefined) {
      tokens.push({ text: full, type: /[(),;]/.test(other) ? "plain" : "operator" });
    }
  }
  return tokens;
}
