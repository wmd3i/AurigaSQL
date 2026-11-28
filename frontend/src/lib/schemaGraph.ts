import { stripSystemNote } from "./stripSystemNote";

export type SchemaColumn = {
  name: string;
  type: string;
  meta?: string;
};

export type SchemaTable = {
  name: string;
  columns: SchemaColumn[];
  constraints: string[];
};

export type SchemaRelation = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  inferred?: boolean;
};

export type SchemaGraph = {
  tables: SchemaTable[];
  relations: SchemaRelation[];
};

function unquoteIdent(ident: string): string {
  const trimmed = ident.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineReference(line: string, tableName: string): SchemaRelation | null {
  const match = line.match(
    /^("?[\w]+"?|\[[^\]]+\]|`[^`]+`)\s+.+?\s+REFERENCES\s+("?[\w.]+"?|\[[^\]]+\]|`[^`]+`)\s*\(\s*("?[\w]+"?|\[[^\]]+\]|`[^`]+`)\s*\)/i,
  );
  if (!match) return null;
  return {
    fromTable: tableName,
    fromColumn: unquoteIdent(match[1]),
    toTable: unquoteIdent(match[2]),
    toColumn: unquoteIdent(match[3]),
  };
}

function parseConstraintReference(line: string, tableName: string): SchemaRelation[] {
  const matches = [
    ...line.matchAll(
      /FOREIGN KEY\s*\(\s*("?[\w]+"?|\[[^\]]+\]|`[^`]+`)\s*\)\s*REFERENCES\s+("?[\w.]+"?|\[[^\]]+\]|`[^`]+`)\s*\(\s*("?[\w]+"?|\[[^\]]+\]|`[^`]+`)\s*\)/gi,
    ),
  ];
  return matches.map((match) => ({
    fromTable: tableName,
    fromColumn: unquoteIdent(match[1]),
    toTable: unquoteIdent(match[2]),
    toColumn: unquoteIdent(match[3]),
  }));
}

/**
 * If a SQL comment starts at `i` (outside quotes), return the index of its last character;
 * otherwise return -1. Unterminated comments run to the end of the text.
 */
function sqlCommentEnd(text: string, i: number): number {
  if (text[i] === "-" && text[i + 1] === "-") {
    const nl = text.indexOf("\n", i + 2);
    return nl === -1 ? text.length - 1 : nl;
  }
  if (text[i] === "/" && text[i + 1] === "*") {
    const close = text.indexOf("*/", i + 2);
    return close === -1 ? text.length - 1 : close + 1;
  }
  return -1;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i + 1] === quote) {
        current += text[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    const commentEnd = sqlCommentEnd(text, i);
    if (commentEnd !== -1) {
      // Drop comments so their text (e.g. an apostrophe) never leaks into a column entry.
      current += " ";
      i = commentEnd;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitColumnNameAndType(entry: string): { name: string; type: string } {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("`")) {
    const quoteChar = trimmed[0];
    const endQuote = trimmed.indexOf(quoteChar, 1);
    if (endQuote !== -1) {
      return {
        name: trimmed.slice(1, endQuote),
        type: trimmed.slice(endQuote + 1).trim(),
      };
    }
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length <= 1) return { name: trimmed, type: "" };
  return {
    name: tokens[0],
    type: tokens.slice(1).join(" "),
  };
}

function inferRelationsFromIdColumns(tables: SchemaTable[]): SchemaRelation[] {
  const shortBuckets = new Map<string, SchemaTable[]>();
  const schemaOf = (name: string) => (name.includes(".") ? name.split(".")[0].toLowerCase() : "");
  const shortOf = (name: string) => (name.includes(".") ? name.split(".").pop()! : name).toLowerCase();

  tables.forEach((table) => {
    const key = shortOf(table.name);
    const bucket = shortBuckets.get(key) ?? [];
    bucket.push(table);
    shortBuckets.set(key, bucket);
  });

  const inferred: SchemaRelation[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    const sourceSchema = schemaOf(table.name);
    for (const col of table.columns) {
      if (!col.name.toLowerCase().endsWith("_id")) continue;
      const stem = col.name.slice(0, -3).toLowerCase();
      if (!stem) continue;
      const candidates = [
        ...(shortBuckets.get(`${stem}s`) ?? []),
        ...(shortBuckets.get(`${stem}es`) ?? []),
        ...(shortBuckets.get(stem) ?? []),
      ].filter((candidate) => candidate.name !== table.name);

      if (candidates.length === 0) continue;
      const sameSchema = sourceSchema
        ? candidates.filter((candidate) => schemaOf(candidate.name) === sourceSchema)
        : candidates;
      const resolved = sameSchema.length === 1 ? sameSchema[0] : candidates.length === 1 ? candidates[0] : null;
      if (!resolved) continue;

      const targetCol =
        resolved.columns.find((c) => c.name.toLowerCase() === "id") ??
        resolved.columns.find((c) => c.name.toLowerCase() === col.name.toLowerCase());
      if (!targetCol) continue;

      const key = `${table.name}:${col.name}:${resolved.name}:${targetCol.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inferred.push({
        fromTable: table.name,
        fromColumn: col.name,
        toTable: resolved.name,
        toColumn: targetCol.name,
        inferred: true,
      });
    }
  }
  return inferred;
}

function parseTableColumnsBlocks(stripped: string): SchemaGraph | null {
  const blockRegex = /^Table:\s*([^\n]+)\nColumns:\s*([^\n]+)/gm;
  const matches = [...stripped.matchAll(blockRegex)];
  if (matches.length === 0) return null;

  const rawEntries = matches.map((match) => ({
    rawName: match[1].trim(),
    colsRaw: match[2],
  }));
  const allPublic = rawEntries.every((item) => item.rawName.startsWith("public."));

  const tables: SchemaTable[] = rawEntries.map(({ rawName, colsRaw }) => {
    const tableName = allPublic && rawName.startsWith("public.") ? rawName.slice("public.".length) : rawName;
    const rawColumns = splitTopLevelCommas(colsRaw);
    const columns: SchemaColumn[] = rawColumns.map(splitColumnNameAndType);
    return { name: tableName, columns, constraints: [] };
  });

  return {
    tables,
    relations: inferRelationsFromIdColumns(tables),
  };
}

function extractCreateTableStatements(sql: string): Array<{ tableName: string; body: string }> {
  const results: Array<{ tableName: string; body: string }> = [];
  const headerRegex = /CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w]+)\.)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w]+)\s*\(/gi;

  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(sql)) !== null) {
    const tableName = unquoteIdent(match[1]);
    let idx = headerRegex.lastIndex;
    let depth = 1;
    let quote: "'" | '"' | "`" | null = null;
    const bodyStart = idx;

    for (; idx < sql.length; idx += 1) {
      const ch = sql[idx];
      if (quote) {
        if (ch === quote && sql[idx + 1] === quote) {
          idx += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      const commentEnd = sqlCommentEnd(sql, idx);
      if (commentEnd !== -1) {
        idx = commentEnd;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    if (depth === 0) {
      results.push({ tableName, body: sql.slice(bodyStart, idx) });
      headerRegex.lastIndex = idx + 1;
    }
  }
  return results;
}

/** Column names a table declares as its primary key, inline or via a table-level constraint. */
export function primaryKeyColumns(table: SchemaTable): Set<string> {
  const keys = new Set<string>();
  table.columns.forEach((col) => {
    if (col.meta && /\bPRIMARY\s+KEY\b/i.test(col.meta)) keys.add(col.name);
  });
  table.constraints.forEach((constraint) => {
    const match = constraint.match(/\bPRIMARY\s+KEY\s*\(([^)]*)\)/i);
    if (!match) return;
    match[1].split(",").forEach((ident) => {
      const name = unquoteIdent(ident.trim().split(/\s+/)[0] ?? "");
      if (name) keys.add(name);
    });
  });
  return keys;
}

export function parseSchemaGraph(result: string): SchemaGraph | null {
  const stripped = stripSystemNote(result);
  const ddlTables = extractCreateTableStatements(stripped);
  if (ddlTables.length === 0) {
    return parseTableColumnsBlocks(stripped);
  }

  const tables: SchemaTable[] = [];
  const relationMap = new Map<string, SchemaRelation>();

  ddlTables.forEach(({ tableName, body }) => {
    const entries = splitTopLevelCommas(body);
    const columns: SchemaColumn[] = [];
    const constraints: string[] = [];

    entries.forEach((rawEntry) => {
      const cleaned = rawEntry.trim();
      if (!cleaned) return;
      if (/^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\b|CHECK\b)/i.test(cleaned)) {
        constraints.push(cleaned);
        parseConstraintReference(cleaned, tableName).forEach((relation) => {
          relationMap.set(
            `${relation.fromTable}:${relation.fromColumn}:${relation.toTable}:${relation.toColumn}`,
            relation,
          );
        });
        return;
      }

      const colMatch = cleaned.match(/^("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w]+)\s+(.+)$/s);
      if (!colMatch) {
        constraints.push(cleaned);
        return;
      }

      const [, rawColName, rest] = colMatch;
      const colName = unquoteIdent(rawColName);
      const metaMatch = rest.match(/^(.+?)(\s+(?:NOT NULL|NULL|DEFAULT .+|PRIMARY KEY.*|REFERENCES .+))$/is);
      if (metaMatch) {
        columns.push({
          name: colName,
          type: metaMatch[1].trim(),
          meta: metaMatch[2].trim(),
        });
      } else {
        columns.push({
          name: colName,
          type: rest.trim(),
        });
      }

      const inlineReference = parseInlineReference(cleaned, tableName);
      if (inlineReference) {
        relationMap.set(
          `${inlineReference.fromTable}:${inlineReference.fromColumn}:${inlineReference.toTable}:${inlineReference.toColumn}`,
          inlineReference,
        );
      }
    });

    tables.push({ name: tableName, columns, constraints });
  });

  return {
    tables,
    relations: [...relationMap.values()],
  };
}
