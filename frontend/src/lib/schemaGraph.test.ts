import { describe, expect, it } from "vitest";
import { parseSchemaGraph } from "./schemaGraph";

describe("parseSchemaGraph", () => {
  it("parses PostgreSQL Table/Columns blocks and infers *_id relations", () => {
    const schema = [
      "Table: public.credit_accounts",
      "Columns: id integer, customer_id integer, credit_limit numeric(10, 2), balance numeric",
      "",
      "Table: public.customers",
      "Columns: id integer, name text, segment text",
    ].join("\n");

    const graph = parseSchemaGraph(schema);
    expect(graph).not.toBeNull();
    expect(graph?.tables.map((t) => t.name)).toEqual(["credit_accounts", "customers"]);
    expect(graph?.tables[0].columns).toEqual([
      { name: "id", type: "integer" },
      { name: "customer_id", type: "integer" },
      { name: "credit_limit", type: "numeric(10, 2)" },
      { name: "balance", type: "numeric" },
    ]);
    expect(graph?.relations).toEqual([
      {
        fromTable: "credit_accounts",
        fromColumn: "customer_id",
        toTable: "customers",
        toColumn: "id",
        inferred: true,
      },
    ]);
  });

  it("handles quoted identifiers, MySQL enum values with commas/parens, and multi-schema tables", () => {
    const schema = [
      "Table: public.orders",
      'Columns: "order id" integer, status enum(\'a(b\', \'c\'), customer_id integer',
      "",
      "Table: public.customers",
      "Columns: id integer, name text",
      "",
      "Table: staging.customers",
      "Columns: id integer, name text",
    ].join("\n");

    const graph = parseSchemaGraph(schema);
    expect(graph?.tables.map((t) => t.name)).toEqual([
      "public.orders",
      "public.customers",
      "staging.customers",
    ]);
    expect(graph?.tables[0].columns).toEqual([
      { name: "order id", type: "integer" },
      { name: "status", type: "enum('a(b', 'c')" },
      { name: "customer_id", type: "integer" },
    ]);
    expect(graph?.relations).toEqual([
      {
        fromTable: "public.orders",
        fromColumn: "customer_id",
        toTable: "public.customers",
        toColumn: "id",
        inferred: true,
      },
    ]);
  });

  it("parses SQLite unquoted, single-line, and semicolon-less CREATE TABLE DDL", () => {
    const ddl = `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id)
)`;

    const graph = parseSchemaGraph(ddl);
    expect(graph?.tables).toHaveLength(2);
    expect(graph?.tables[0].name).toBe("customers");
    expect(graph?.relations).toEqual([
      {
        fromTable: "orders",
        fromColumn: "customer_id",
        toTable: "customers",
        toColumn: "id",
      },
    ]);
  });
});
