import { describe, expect, it } from "vitest";
import { parseSchemaGraph, primaryKeyColumns } from "./schemaGraph";

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

  it("ignores -- and /* */ comments, including apostrophes inside them", () => {
    const schema = [
      "CREATE TABLE users (",
      "  id INTEGER PRIMARY KEY, -- user's id",
      "  name TEXT",
      ");",
      "CREATE TABLE products (",
      "  id INTEGER, -- the id",
      "  title TEXT, /* shown in the catalog, don't truncate */",
      "  price REAL",
      ");",
    ].join("\n");

    const graph = parseSchemaGraph(schema);
    expect(graph?.tables.map((t) => t.name)).toEqual(["users", "products"]);
    expect(graph?.tables[0].columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(graph?.tables[1].columns.map((c) => c.name)).toEqual(["id", "title", "price"]);
    expect(graph?.tables[1].constraints).toEqual([]);
  });
});

describe("primaryKeyColumns", () => {
  it("matches exact identifiers from PRIMARY KEY (...) instead of substrings", () => {
    const graph = parseSchemaGraph(
      [
        "CREATE TABLE orders (",
        "  id INTEGER,",
        "  user_id INTEGER,",
        '  "order_no" TEXT,',
        '  CONSTRAINT pk_orders PRIMARY KEY (user_id, "order_no")',
        ");",
        "CREATE TABLE items (id INTEGER PRIMARY KEY, item_id INTEGER);",
      ].join("\n"),
    );
    expect([...primaryKeyColumns(graph!.tables[0])].sort()).toEqual(["order_no", "user_id"]);
    expect([...primaryKeyColumns(graph!.tables[1])]).toEqual(["id"]);
  });
});
