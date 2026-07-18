const TOOL_LABELS: Record<string, string> = {
  ask: "Ask for clarification",
  ask_user: "Ask for clarification",
  describe_postgres_table: "Inspect table schema",
  execute_sql: "Run SQL",
  explain_postgres_query: "Explain SQL plan",
  explain_sqlite_query: "Explain SQL plan",
  get_all_column_meanings: "Explain table columns",
  get_all_external_knowledge_names: "Browse domain topics",
  get_all_knowledge_definitions: "Review domain knowledge",
  get_column_meaning: "Explain a column",
  get_knowledge_definition: "Look up domain knowledge",
  get_schema: "Inspect database schema",
  list_duckdb_tables: "Inspect database schema",
  list_postgres_tables: "Inspect database schema",
  list_sqlite_tables: "Inspect database schema",
  run_duckdb_readonly: "Run SQL",
  run_postgres_readonly: "Run SQL",
  run_sqlite_readonly: "Run SQL",
  sample_duckdb_rows: "Sample table rows",
  sample_postgres_rows: "Sample table rows",
  sample_sqlite_rows: "Sample table rows",
  submit: "Submit final SQL",
  submit_sql: "Submit final SQL",
  validate_duckdb_query: "Validate SQL",
  validate_postgres_query: "Validate SQL",
  validate_sql: "Validate SQL",
  validate_sqlite_query: "Validate SQL",
};

function humanizeToolSubject(raw: string): string {
  return raw
    .split(/[._]/g)
    .filter(Boolean)
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .join(" ")
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

export function humanizeToolName(toolName?: string | null): string {
  if (!toolName) return "Use tool";
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];

  if (toolName.startsWith("get_all_")) {
    return `Review ${humanizeToolSubject(toolName.slice("get_all_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("get_")) {
    return `Look up ${humanizeToolSubject(toolName.slice("get_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("execute_")) {
    return `Run ${humanizeToolSubject(toolName.slice("execute_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("run_")) {
    return `Run ${humanizeToolSubject(toolName.slice("run_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("list_")) {
    return `Inspect ${humanizeToolSubject(toolName.slice("list_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("sample_")) {
    return `Sample ${humanizeToolSubject(toolName.slice("sample_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("validate_")) {
    return `Validate ${humanizeToolSubject(toolName.slice("validate_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("explain_")) {
    return `Explain ${humanizeToolSubject(toolName.slice("explain_".length)).toLowerCase()}`;
  }
  if (toolName.startsWith("search_")) {
    return `Search ${humanizeToolSubject(toolName.slice("search_".length)).toLowerCase()}`;
  }

  return humanizeToolSubject(toolName);
}
