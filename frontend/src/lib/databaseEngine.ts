import type { DataEngine } from "../api/bff";

export function normalizeDataEngine(value: unknown): DataEngine {
  return value === "mysql" || value === "duckdb" || value === "sqlite" ? value : "postgres";
}

export function inferDataEngine(name: string | null | undefined): DataEngine {
  const value = (name ?? "").toLowerCase();
  if (value.includes("duckdb") || value.endsWith(".duckdb")) return "duckdb";
  if (value.includes("mysql")) return "mysql";
  if (
    value.includes("sqlite") ||
    value.endsWith(".sqlite") ||
    value.endsWith(".sqlite3") ||
    value.endsWith(".db")
  ) {
    return "sqlite";
  }
  return "postgres";
}
