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
};

export type SchemaGraph = {
  tables: SchemaTable[];
  relations: SchemaRelation[];
};

function parseInlineReference(line: string, tableName: string): SchemaRelation | null {
  const match = line.match(
    /^("?[\w]+"?)\s+.+?\s+REFERENCES\s+"?([\w]+)"?\s*\(\s*"?([\w]+)"?\s*\)/i,
  );
  if (!match) return null;
  return {
    fromTable: tableName,
    fromColumn: match[1].replace(/"/g, ""),
    toTable: match[2],
    toColumn: match[3],
  };
}

function parseConstraintReference(line: string, tableName: string): SchemaRelation[] {
  const matches = [...line.matchAll(/FOREIGN KEY\s*\(\s*"?([\w]+)"?\s*\)\s*REFERENCES\s+"?([\w]+)"?\s*\(\s*"?([\w]+)"?\s*\)/gi)];
  return matches.map((match) => ({
    fromTable: tableName,
    fromColumn: match[1],
    toTable: match[2],
    toColumn: match[3],
  }));
}

export function parseSchemaGraph(result: string): SchemaGraph | null {
  const stripped = stripSystemNote(result);
  if (!stripped.includes('CREATE TABLE "')) return null;

  const matches = [...stripped.matchAll(/CREATE TABLE "([^"]+)" \(\n([\s\S]*?)\n\);\n*([\s\S]*?)(?=CREATE TABLE "|$)/g)];
  if (matches.length === 0) return null;

  const tables: SchemaTable[] = [];
  const relationMap = new Map<string, SchemaRelation>();

  matches.forEach((match) => {
    const [, tableName, body] = match;
    const rawLines = body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const columns: SchemaColumn[] = [];
    const constraints: string[] = [];

    rawLines.forEach((line) => {
      const cleaned = line.replace(/,$/, "");
      if (
        cleaned.startsWith("PRIMARY KEY") ||
        cleaned.startsWith("FOREIGN KEY") ||
        cleaned.startsWith("UNIQUE") ||
        cleaned.startsWith("CHECK")
      ) {
        constraints.push(cleaned);
        parseConstraintReference(cleaned, tableName).forEach((relation) => {
          relationMap.set(
            `${relation.fromTable}:${relation.fromColumn}:${relation.toTable}:${relation.toColumn}`,
            relation,
          );
        });
        return;
      }

      const colMatch = cleaned.match(/^("?[\w]+"?)\s+(.+)$/);
      if (!colMatch) {
        constraints.push(cleaned);
        return;
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
