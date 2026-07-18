import {
  BFF_BASE,
  expectArray,
  expectBoolean,
  expectLiteral,
  expectNumber,
  expectRecord,
  expectString,
  jsonFetch,
} from "./client";

export type TaskItem = {
  instance_id: string;
  source_id: string;
  database: string;
  amb_user_query: string;
  num_critical_ambiguity: number;
  num_knowledge_ambiguity: number;
  has_follow_up: boolean;
};

export type ModelInfo = {
  id: string;
  label: string;
  model: string;
  provider: string;
  available: boolean;
};

export type LlmProfile = {
  id: string;
  label: string;
  provider: "openai" | "gemini" | "zai" | "anthropic" | "minimax" | "xai" | "ollama" | string;
  model: string;
  api_base: string;
  enabled: boolean;
  available: boolean;
  source: "user" | "env" | string;
  read_only: boolean;
  api_key_masked: string;
};

export type LlmConfigsResponse = {
  default_model_id: string;
  profiles: LlmProfile[];
};

export type LocalModelStatus = {
  label: string;
  provider: string;
  model: string;
  api_base: string;
  model_url: string;
  model_path: string;
  downloaded: boolean;
  downloading: boolean;
  bytes_downloaded: number;
  total_bytes: number;
  speed_bps: number;
  eta_seconds: number;
  running: boolean;
  profile_id: string;
  error: string;
};

export type LocalModelSetupResponse = {
  ok: boolean;
  message: string;
  status: LocalModelStatus;
  configs: LlmConfigsResponse | null;
  profile_id: string;
};

export type ModelsResponse = {
  models: ModelInfo[];
  default: string;
};

export type DatabaseSchemaResponse = {
  database: string;
  schema: string;
  dialect: Dialect;
};

export type DataEngine = "postgres" | "mysql" | "sqlite" | "duckdb";
export type DemoGroupId = "bird" | "bird_interact_a";

export type DataSource = {
  id: string;
  source_group: string;
  engine: DataEngine;
  display_name: string;
  ready: boolean;
  source_type: "demo" | "user_connection" | string;
  database: string | null;
  db_path: string | null;
  schema_path: string | null;
  connection_id: string | null;
  description: string;
  reason: string;
};

export type UserConnection = {
  id: string;
  name: string;
  engine: DataEngine;
  mode: "local_path" | string;
  path: string;
  host: string;
  port: number | null;
  database: string;
  username: string;
  sslmode: string;
  location: string;
  ready: boolean;
  reason: string;
  created_at: string;
  updated_at: string;
  source: DataSource;
};

export type DatabaseFileImportResponse = {
  ok: boolean;
  message: string;
  path: string;
};

export type DemoConnection = {
  source_group: DemoGroupId;
  label: string;
  engine: DataEngine;
  description: string;
  connected: boolean;
  ready_count: number;
  reason: string;
};

export type StartFreechat = {
  task_id: string;
  mode: "free-chat";
  source: DataSource;
  database: string;
  databases: string[];
  user_query: string;
};

export type ResolveDataSourceResponse = {
  source: DataSource;
  reason: string;
};

export type TurnResponse = {
  task_id: string;
  mode: string;
  session_id: string;
  response: string;
  state: Record<string, unknown>;
  adk_available: boolean;
};

export type SessionSnapshot = {
  task_id: string;
  mode: string;
  state: Record<string, unknown>;
};

function parseTaskItem(value: unknown, index: number): TaskItem {
  const record = expectRecord(value, `tasks[${index}]`);
  return {
    instance_id: expectString(record.instance_id, `tasks[${index}].instance_id`),
    source_id: expectString(record.source_id, `tasks[${index}].source_id`),
    database: expectString(record.database, `tasks[${index}].database`),
    amb_user_query: expectString(record.amb_user_query, `tasks[${index}].amb_user_query`),
    num_critical_ambiguity: expectNumber(
      record.num_critical_ambiguity,
      `tasks[${index}].num_critical_ambiguity`,
    ),
    num_knowledge_ambiguity: expectNumber(
      record.num_knowledge_ambiguity,
      `tasks[${index}].num_knowledge_ambiguity`,
    ),
    has_follow_up: expectBoolean(record.has_follow_up, `tasks[${index}].has_follow_up`),
  };
}

export type Dialect = "postgres" | "mysql" | "sqlite" | "duckdb";

function parseDatabaseSchemaResponse(value: unknown): DatabaseSchemaResponse {
  const record = expectRecord(value, "database schema response");
  const dialectValue = typeof record.dialect === "string" ? record.dialect : "postgres";
  return {
    database: expectString(record.database, "database"),
    schema: expectString(record.schema, "schema"),
    dialect: dialectValue === "mysql" || dialectValue === "sqlite" || dialectValue === "duckdb" ? dialectValue : "postgres",
  };
}

function parseDataEngine(value: unknown): DataEngine {
  return value === "mysql" || value === "sqlite" || value === "duckdb" ? value : "postgres";
}

function parseDemoGroupId(value: unknown): DemoGroupId {
  if (value === "bird" || value === "bird_interact_a") return value;
  throw new Error(`Unexpected demo group id: ${String(value)}`);
}

function parseDataSource(value: unknown, index = 0): DataSource {
  const record = expectRecord(value, `sources[${index}]`);
  return {
    id: expectString(record.id, `sources[${index}].id`),
    source_group: expectString(record.source_group, `sources[${index}].source_group`),
    engine: parseDataEngine(record.engine),
    display_name: expectString(record.display_name, `sources[${index}].display_name`),
    ready: expectBoolean(record.ready, `sources[${index}].ready`),
    source_type: typeof record.source_type === "string" ? record.source_type : "demo",
    database: typeof record.database === "string" ? record.database : null,
    db_path: typeof record.db_path === "string" ? record.db_path : null,
    schema_path: typeof record.schema_path === "string" ? record.schema_path : null,
    connection_id: typeof record.connection_id === "string" ? record.connection_id : null,
    description: typeof record.description === "string" ? record.description : "",
    reason: typeof record.reason === "string" ? record.reason : "",
  };
}

function parseDataSourcesResponse(value: unknown): { sources: DataSource[] } {
  const record = expectRecord(value, "data sources response");
  return { sources: expectArray(record.sources, "sources", parseDataSource) };
}

function parseModelInfo(value: unknown, index: number): ModelInfo {
  const record = expectRecord(value, `models[${index}]`);
  const model = typeof record.model === "string" ? record.model : "";
  const label = expectString(record.label, `models[${index}].label`);
  return {
    id: expectString(record.id, `models[${index}].id`),
    label:
      model === "ollama_chat/qwen3:1.7b" || model === "openai/Qwen3-1.7B-Q4_K_M"
        ? "Local Model · Qwen3 1.7B"
        : label,
    model,
    provider: expectString(record.provider, `models[${index}].provider`),
    available: expectBoolean(record.available, `models[${index}].available`),
  };
}

function parseModelsResponse(value: unknown): ModelsResponse {
  const record = expectRecord(value, "models response");
  return {
    models: expectArray(record.models, "models", parseModelInfo),
    default: expectString(record.default, "default"),
  };
}

function parseLlmProfile(value: unknown, index: number): LlmProfile {
  const record = expectRecord(value, `profiles[${index}]`);
  return {
    id: expectString(record.id, `profiles[${index}].id`),
    label: expectString(record.label, `profiles[${index}].label`),
    provider: expectString(record.provider, `profiles[${index}].provider`),
    model: expectString(record.model, `profiles[${index}].model`),
    api_base: typeof record.api_base === "string" ? record.api_base : "",
    enabled: expectBoolean(record.enabled, `profiles[${index}].enabled`),
    available: expectBoolean(record.available, `profiles[${index}].available`),
    source: expectString(record.source, `profiles[${index}].source`),
    read_only: expectBoolean(record.read_only, `profiles[${index}].read_only`),
    api_key_masked:
      typeof record.api_key_masked === "string" ? record.api_key_masked : "",
  };
}

function parseLlmConfigsResponse(value: unknown): LlmConfigsResponse {
  const record = expectRecord(value, "llm configs response");
  return {
    default_model_id: expectString(record.default_model_id, "default_model_id"),
    profiles: expectArray(record.profiles, "profiles", parseLlmProfile),
  };
}

function parseLocalModelStatus(value: unknown): LocalModelStatus {
  const record = expectRecord(value, "local model status");
  return {
    label: expectString(record.label, "local model label"),
    provider: expectString(record.provider, "local model provider"),
    model: expectString(record.model, "local model id"),
    api_base: expectString(record.api_base, "local model api_base"),
    model_url: expectString(record.model_url, "local model url"),
    model_path: expectString(record.model_path, "local model path"),
    downloaded: expectBoolean(record.downloaded, "local model downloaded"),
    downloading: expectBoolean(record.downloading, "local model downloading"),
    bytes_downloaded: expectNumber(record.bytes_downloaded, "local model bytes_downloaded"),
    total_bytes: expectNumber(record.total_bytes, "local model total_bytes"),
    speed_bps: typeof record.speed_bps === "number" ? record.speed_bps : 0,
    eta_seconds: typeof record.eta_seconds === "number" ? record.eta_seconds : 0,
    running: expectBoolean(record.running, "local model running"),
    profile_id: typeof record.profile_id === "string" ? record.profile_id : "",
    error: typeof record.error === "string" ? record.error : "",
  };
}

function parseLocalModelSetupResponse(value: unknown): LocalModelSetupResponse {
  const record = expectRecord(value, "local model setup response");
  return {
    ok: expectBoolean(record.ok, "local model setup ok"),
    message: typeof record.message === "string" ? record.message : "",
    status: parseLocalModelStatus(record.status),
    configs: record.configs ? parseLlmConfigsResponse(record.configs) : null,
    profile_id: typeof record.profile_id === "string" ? record.profile_id : "",
  };
}

function parseTasksResponse(value: unknown): { tasks: TaskItem[]; dataset: string } {
  const record = expectRecord(value, "tasks response");
  return {
    tasks: expectArray(record.tasks, "tasks", parseTaskItem),
    dataset: expectString(record.dataset, "dataset"),
  };
}

function parseStartFreechatResponse(value: unknown): StartFreechat {
  const record = expectRecord(value, "freechat start response");
  const source = parseDataSource(record.source, 0);
  return {
    task_id: expectString(record.task_id, "task_id"),
    mode: expectLiteral(record.mode, "free-chat", "mode"),
    source,
    database: source.display_name,
    databases: [source.display_name],
    user_query: expectString(record.user_query, "user_query"),
  };
}

function parseResolveDataSourceResponse(value: unknown): ResolveDataSourceResponse {
  const record = expectRecord(value, "data source resolve response");
  return {
    source: parseDataSource(record.source, 0),
    reason: typeof record.reason === "string" ? record.reason : "",
  };
}

function parseTurnResponse(value: unknown): TurnResponse {
  const record = expectRecord(value, "turn response");
  return {
    task_id: expectString(record.task_id, "task_id"),
    mode: expectString(record.mode, "mode"),
    session_id: expectString(record.session_id, "session_id"),
    response: expectString(record.response, "response"),
    state: expectRecord(record.state, "state"),
    adk_available: expectBoolean(record.adk_available, "adk_available"),
  };
}

function parseSessionSnapshot(value: unknown): SessionSnapshot {
  const record = expectRecord(value, "session response");
  return {
    task_id: expectString(record.task_id, "task_id"),
    mode: expectString(record.mode, "mode"),
    state: expectRecord(record.state, "state"),
  };
}

function parseStatusResponse(value: unknown): { status: string } {
  const record = expectRecord(value, "status response");
  return { status: expectString(record.status, "status") };
}

function parseConnectionTestResponse(value: unknown): { ok: boolean; message: string } {
  const record = expectRecord(value, "connection test response");
  return {
    ok: expectBoolean(record.ok, "ok"),
    message: typeof record.message === "string" ? record.message : "",
  };
}

function parseDatabaseConnection(value: unknown, index = 0): UserConnection {
  const record = expectRecord(value, `connections[${index}]`);
  return {
    id: expectString(record.id, `connections[${index}].id`),
    name: expectString(record.name, `connections[${index}].name`),
    engine: parseDataEngine(record.engine),
    mode: typeof record.mode === "string" ? record.mode : "local_path",
    path: expectString(record.path, `connections[${index}].path`),
    host: typeof record.host === "string" ? record.host : "",
    port: typeof record.port === "number" ? record.port : null,
    database: typeof record.database === "string" ? record.database : "",
    username: typeof record.username === "string" ? record.username : "",
    sslmode: typeof record.sslmode === "string" ? record.sslmode : "",
    location: typeof record.location === "string" ? record.location : "",
    ready: expectBoolean(record.ready, `connections[${index}].ready`),
    reason: typeof record.reason === "string" ? record.reason : "",
    created_at: typeof record.created_at === "string" ? record.created_at : "",
    updated_at: typeof record.updated_at === "string" ? record.updated_at : "",
    source: parseDataSource(record.source, index),
  };
}

function parseConnectionsResponse(value: unknown): { connections: UserConnection[] } {
  const record = expectRecord(value, "connections response");
  return { connections: expectArray(record.connections, "connections", parseDatabaseConnection) };
}

function parseDemoConnection(value: unknown, index = 0): DemoConnection {
  const record = expectRecord(value, `connections[${index}]`);
  return {
    source_group: parseDemoGroupId(record.source_group),
    label: expectString(record.label, `connections[${index}].label`),
    engine: parseDataEngine(record.engine),
    description: typeof record.description === "string" ? record.description : "",
    connected: expectBoolean(record.connected, `connections[${index}].connected`),
    ready_count: expectNumber(record.ready_count, `connections[${index}].ready_count`),
    reason: typeof record.reason === "string" ? record.reason : "",
  };
}

function parseDemoConnectionsResponse(value: unknown): { connections: DemoConnection[] } {
  const record = expectRecord(value, "demo connections response");
  return { connections: expectArray(record.connections, "connections", parseDemoConnection) };
}

function parseDemoConnectionResponse(value: unknown): DemoConnection {
  return parseDemoConnection(value, 0);
}

function parseConnectionResponse(value: unknown): { connection: UserConnection } {
  const record = expectRecord(value, "connection response");
  return { connection: parseDatabaseConnection(record.connection, 0) };
}

function parseDatabaseConnectionTestResponse(value: unknown): {
  ok: boolean;
  message: string;
  schema_preview: string;
  path: string;
} {
  const record = expectRecord(value, "database connection test response");
  return {
    ok: expectBoolean(record.ok, "ok"),
    message: typeof record.message === "string" ? record.message : "",
    schema_preview: typeof record.schema_preview === "string" ? record.schema_preview : "",
    path: typeof record.path === "string" ? record.path : "",
  };
}

function parseDatabaseFileImportResponse(value: unknown): DatabaseFileImportResponse {
  const record = expectRecord(value, "database file import response");
  return {
    ok: expectBoolean(record.ok, "ok"),
    message: typeof record.message === "string" ? record.message : "",
    path: expectString(record.path, "path"),
  };
}

function parseTitleResponse(value: unknown): { title: string } {
  const record = expectRecord(value, "title response");
  return { title: expectString(record.title, "title") };
}

function parseAnalyzeResponse(value: unknown): { analysis: string } {
  const record = expectRecord(value, "analyze response");
  return { analysis: expectString(record.analysis, "analysis") };
}

function parseBranchAnswerResponse(value: unknown): { answer: string } {
  const record = expectRecord(value, "branch answer response");
  return { answer: expectString(record.answer, "answer") };
}

export type VisualizationSpec = {
  chart_type: "bar" | "line" | "scatter" | "histogram";
  title: string;
  x_key: string | null;
  y_key: string | null;
  value_key: string | null;
  x_label: string;
  y_label: string;
  reason: string;
  style: {
    accent: string;
    background: string;
    border: string;
    radius: string;
    font: string;
    density: string;
  } | null;
};

function parseVisualizationResponse(value: unknown): { spec: VisualizationSpec } {
  const record = expectRecord(value, "visualize response");
  const spec = expectRecord(record.spec, "visualize response.spec");
  const style = spec.style && typeof spec.style === "object"
    ? expectRecord(spec.style, "visualize response.spec.style")
    : null;
  const chartType = expectString(spec.chart_type, "visualize response.spec.chart_type");
  if (!["bar", "line", "scatter", "histogram"].includes(chartType)) {
    throw new Error("Unsupported chart type");
  }
  return {
    spec: {
      chart_type: chartType as VisualizationSpec["chart_type"],
      title: typeof spec.title === "string" ? spec.title : "",
      x_key: typeof spec.x_key === "string" ? spec.x_key : null,
      y_key: typeof spec.y_key === "string" ? spec.y_key : null,
      value_key: typeof spec.value_key === "string" ? spec.value_key : null,
      x_label: typeof spec.x_label === "string" ? spec.x_label : "",
      y_label: typeof spec.y_label === "string" ? spec.y_label : "",
      reason: typeof spec.reason === "string" ? spec.reason : "",
      style: style
        ? {
            accent: typeof style.accent === "string" ? style.accent : "",
            background: typeof style.background === "string" ? style.background : "",
            border: typeof style.border === "string" ? style.border : "",
            radius: typeof style.radius === "string" ? style.radius : "",
            font: typeof style.font === "string" ? style.font : "",
            density: typeof style.density === "string" ? style.density : "",
          }
        : null,
    },
  };
}

const SHORT_REQUEST_TIMEOUT_MS = 20000;
const ROUTE_REQUEST_TIMEOUT_MS = 30000;
const MODEL_REQUEST_TIMEOUT_MS = 240000;
const LOCAL_MODEL_SETUP_TIMEOUT_MS = 120000;

export const bff = {
  base: BFF_BASE,
  dataSources: () => jsonFetch("/data-sources", { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseDataSourcesResponse),
  demoDataSources: () => jsonFetch("/data-sources/demo", { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseDataSourcesResponse),
  demoConnections: () =>
    jsonFetch("/demo-connections", { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseDemoConnectionsResponse),
  connectDemoGroup: (source_group: DemoGroupId) =>
    jsonFetch("/demo-connections", { json: { source_group }, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseDemoConnectionResponse),
  disconnectDemoGroup: (source_group: DemoGroupId) =>
    jsonFetch("/demo-connections/disconnect", { json: { source_group }, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseDemoConnectionResponse),
  connections: () => jsonFetch("/connections", { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseConnectionsResponse),
  testDatabaseConnection: (payload: {
    engine: DataEngine;
    path?: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    sslmode?: string;
  }) =>
    jsonFetch("/connections/test", { json: payload, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseDatabaseConnectionTestResponse),
  importDatabaseFile: async (engine: Extract<DataEngine, "sqlite" | "duckdb">, file: File) => {
    const params = new URLSearchParams({ engine, filename: file.name });
    const response = await fetch(`${BFF_BASE}/connections/import-file?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    }
    return parseDatabaseFileImportResponse(await response.json());
  },
  createDatabaseConnection: (payload: {
    name: string;
    engine: DataEngine;
    path?: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    sslmode?: string;
  }) =>
    jsonFetch("/connections", { json: payload, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseConnectionResponse),
  updateDatabaseConnection: (id: string, payload: {
    name?: string;
    path?: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    sslmode?: string;
  }) =>
    jsonFetch(`/connections/${encodeURIComponent(id)}`, { method: "PATCH", json: payload, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseConnectionResponse),
  deleteDatabaseConnection: (id: string) =>
    jsonFetch(`/connections/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseStatusResponse),
  databaseSchema: (database: string) =>
    jsonFetch(`/databases/${encodeURIComponent(database)}/schema`, { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseDatabaseSchemaResponse),
  models: () => jsonFetch("/models", { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseModelsResponse),
  llmConfigs: () => jsonFetch("/llm/configs", { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseLlmConfigsResponse),
  localModelStatus: () => jsonFetch("/local-model/status", { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseLocalModelStatus),
  setupLocalModel: () => jsonFetch("/local-model/setup", { method: "POST", timeoutMs: LOCAL_MODEL_SETUP_TIMEOUT_MS }, parseLocalModelSetupResponse),
  createLlmConfig: (payload: {
    label: string;
    provider: "openai" | "gemini" | "zai" | "anthropic" | "minimax" | "xai" | "ollama" | "other";
    model: string;
    api_key: string;
    api_base: string;
    enabled: boolean;
    set_default?: boolean;
  }) => jsonFetch("/llm/configs", { json: payload, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseLlmConfigsResponse),
  updateLlmConfig: (
    id: string,
    payload: {
      label?: string;
      model?: string;
      api_key?: string;
      api_base?: string;
      enabled?: boolean;
      set_default?: boolean;
    },
  ) => jsonFetch(`/llm/configs/${encodeURIComponent(id)}`, { method: "PATCH", json: payload, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseLlmConfigsResponse),
  deleteLlmConfig: (id: string) =>
    jsonFetch(`/llm/configs/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseLlmConfigsResponse),
  setDefaultLlmConfig: (model_id: string) =>
    jsonFetch("/llm/configs/default", { json: { model_id }, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseLlmConfigsResponse),
  testLlmConfig: (id: string) =>
    jsonFetch(`/llm/configs/${encodeURIComponent(id)}/test`, { method: "POST", timeoutMs: ROUTE_REQUEST_TIMEOUT_MS }, parseConnectionTestResponse),
  testLlmDraft: (payload: {
    profile_id?: string;
    provider: "openai" | "gemini" | "zai" | "anthropic" | "minimax" | "xai" | "ollama" | "other";
    model?: string;
    api_key?: string;
    api_base?: string;
  }) => jsonFetch("/llm/configs/test", { json: payload, timeoutMs: ROUTE_REQUEST_TIMEOUT_MS }, parseConnectionTestResponse),
  tasks: (limit = 200) =>
    jsonFetch(`/tasks?limit=${limit}`, { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseTasksResponse),
  resolveDataSource: (query: string, model?: string | null) =>
    jsonFetch("/data-sources/resolve", { json: { query, model }, timeoutMs: ROUTE_REQUEST_TIMEOUT_MS }, parseResolveDataSourceResponse),
  startFreechat: (
    source_id: string,
    query: string,
    model?: string | null,
    parent_context?: string | null,
    signal?: AbortSignal,
  ) =>
    jsonFetch("/freechat/start", { json: { source_id, query, model, parent_context }, signal, timeoutMs: ROUTE_REQUEST_TIMEOUT_MS }, parseStartFreechatResponse),
  turn: (task_id: string, message: string, mode = "a-interact", model?: string | null) =>
    jsonFetch("/turn", { json: { task_id, message, mode, model }, timeoutMs: MODEL_REQUEST_TIMEOUT_MS }, parseTurnResponse),
  answerUser: (task_id: string, answer: string) =>
    jsonFetch("/answer_user", { json: { task_id, answer }, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseStatusResponse),
  cancel: (task_id: string) =>
    jsonFetch("/cancel", { json: { task_id }, timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseStatusResponse),
  session: (task_id: string) =>
    jsonFetch(`/session/${encodeURIComponent(task_id)}`, { method: "GET", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseSessionSnapshot),
  summaryTitle: (text: string) =>
    jsonFetch("/title", { json: { text }, timeoutMs: ROUTE_REQUEST_TIMEOUT_MS }, parseTitleResponse),
  analyze: (question: string, sql: string, result: string, model?: string | null) =>
    jsonFetch("/analyze", { json: { question, sql, result, model }, timeoutMs: MODEL_REQUEST_TIMEOUT_MS }, parseAnalyzeResponse),
  branchAnswer: (question: string, parent_context: string, model?: string | null) =>
    jsonFetch("/branch/answer", { json: { question, parent_context, model }, timeoutMs: MODEL_REQUEST_TIMEOUT_MS }, parseBranchAnswerResponse),
  visualize: (question: string, sql: string, result: string, prompt: string) =>
    jsonFetch("/visualize", { json: { question, sql, result, prompt }, timeoutMs: MODEL_REQUEST_TIMEOUT_MS }, parseVisualizationResponse),
  cleanup: (task_id: string) =>
    jsonFetch(`/cleanup/${encodeURIComponent(task_id)}`, { method: "POST", timeoutMs: SHORT_REQUEST_TIMEOUT_MS }, parseStatusResponse),
};
