import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  Lock,
  Unplug,
} from "lucide-react";
import {
  bff,
  type DataEngine,
  type DataSource,
  type DemoConnection,
  type DemoGroupId,
  type UserConnection,
} from "../../api/bff";
import { cn } from "../../lib/cn";
import { parseConnectionUri, VALID_SSL_MODES, type PostgresSslMode } from "../../lib/connectionUri";
import { DialectIcon, dialectLabel } from "./DialectIcon";
import { SchemaPreviewCard } from "./SchemaPreviewCard";

const ENGINE_CHOICES: DataEngine[] = ["postgres", "mysql", "duckdb", "sqlite"];
const DEMO_GROUP_IDS: DemoGroupId[] = ["bird", "bird_interact_a"];
type ConnectionMode = DataEngine | "demo" | null;

const SSL_MODE_HINTS: Record<PostgresSslMode, string> = {
  disable: "Plaintext connection without TLS. Best for local Docker or localhost demos.",
  allow: "Tries unencrypted first, then falls back to SSL if the server requires it.",
  prefer: "Tries SSL first without certificate verification; falls back to plaintext.",
  require: "Encrypts traffic with TLS but skips server certificate verification.",
  "verify-ca": "Encrypts and verifies the server certificate chain against a trusted CA.",
  "verify-full": "Strictest mode: verifies both the CA chain and the server hostname.",
};

type TestFeedback = {
  ok: boolean;
  message: string;
  latencyMs: number;
  schemaPreview: string;
};

export function DatabaseConnectionPanel(props: {
  onCreated: (source: DataSource) => Promise<void> | void;
  onUpdated?: (source: DataSource) => Promise<void> | void;
  onDemoGroupConnected?: (connection: DemoConnection) => void;
  editingConnection?: UserConnection | null;
  onCancelEdit?: () => void;
  showDemoOption?: boolean;
  onUseSource?: (source: DataSource) => void;
  onOpenInCanvas?: (source: DataSource) => void;
  className?: string;
}) {
  const showDemoOption = props.showDemoOption ?? true;
  const editing = props.editingConnection ?? null;
  const editingId = editing?.id ?? null;
  const isEditMode = editing !== null;

  const baseId = useId();
  const nameInputId = `${baseId}-name`;
  const hostInputId = `${baseId}-host`;
  const portInputId = `${baseId}-port`;
  const databaseInputId = `${baseId}-database`;
  const usernameInputId = `${baseId}-username`;
  const passwordInputId = `${baseId}-password`;
  const pathInputId = `${baseId}-path`;
  const pasteInputId = `${baseId}-paste`;

  const [engine, setEngine] = useState<DataEngine>("postgres");
  const [mode, setMode] = useState<ConnectionMode>(showDemoOption ? "demo" : "postgres");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [clearSavedPassword, setClearSavedPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sslmode, setSslmode] = useState<PostgresSslMode>("prefer");
  const [showPasteUrl, setShowPasteUrl] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "file" | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [demoConnections, setDemoConnections] = useState<DemoConnection[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"info" | "success" | "error">("error");
  const [testFeedback, setTestFeedback] = useState<TestFeedback | null>(null);
  const [savedSchemaText, setSavedSchemaText] = useState<string | null>(null);
  const [savedSchemaLoading, setSavedSchemaLoading] = useState(false);
  const [savedSchemaError, setSavedSchemaError] = useState<string | null>(null);
  const [copiedError, setCopiedError] = useState(false);
  const [copyErrorMsg, setCopyErrorMsg] = useState<string | null>(null);
  const [lastSavedSource, setLastSavedSource] = useState<DataSource | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const schemaPreviewWrapRef = useRef<HTMLDivElement>(null);
  const draftRevisionRef = useRef(0);
  const lastInitializedIdRef = useRef<string | null | undefined>(undefined);
  const latestEditingRef = useRef<UserConnection | null>(editing);
  latestEditingRef.current = editing;

  const isPostgres = engine === "postgres";
  const isNetworkEngine = engine === "postgres" || engine === "mysql";
  const selectedEngineLabel = dialectLabel(engine);
  const selectedEngineMode = mode !== null && mode !== "demo" ? mode : null;

  const demoGroups: DemoConnection[] = useMemo(
    () =>
      DEMO_GROUP_IDS.map(
        (groupId) =>
          demoConnections.find((item) => item.source_group === groupId) ?? {
            source_group: groupId,
            label: groupId === "bird" ? "BIRD SQLite" : "BIRD-Interact (SQLite Edition)",
            engine: "sqlite",
            description: "Bundled SQLite demo databases",
            connected: false,
            ready_count: 0,
            reason: "",
          },
      ),
    [demoConnections],
  );
  const connectedDemoGroups = demoGroups.filter((item) => item.connected);
  const demoConnected = connectedDemoGroups.length > 0;

  useEffect(() => {
    if (!showDemoOption) return;
    bff
      .demoConnections()
      .then((response) => setDemoConnections(response.connections))
      .catch(() => {});
  }, [showDemoOption]);

  function applyConnectionToForm(conn: UserConnection | null) {
    draftRevisionRef.current += 1;
    setBusy(null);
    setShowPasteUrl(false);
    setPasteUrl("");
    setPasteError(null);
    setMessage(null);
    setMessageTone("error");
    setTestFeedback(null);
    setCopiedError(false);
    setCopyErrorMsg(null);
    setShowPassword(false);
    setClearSavedPassword(false);

    if (!conn) {
      setEngine("postgres");
      setMode(showDemoOption ? "demo" : "postgres");
      setName("");
      setPath("");
      setHost("127.0.0.1");
      setPort("5432");
      setDatabase("");
      setUsername("");
      setPassword("");
      setSslmode("prefer");
      setLastSavedSource(null);
      setSavedSchemaText(null);
      setSavedSchemaLoading(false);
      setSavedSchemaError(null);
      return;
    }

    setEngine(conn.engine);
    setMode(conn.engine);
    setName(conn.name);
    setPath(conn.path || "");
    setHost(conn.host || "127.0.0.1");
    setPort(conn.port ? String(conn.port) : conn.engine === "mysql" ? "3306" : "5432");
    setDatabase(conn.database || "");
    setUsername(conn.username || "");
    setPassword("");
    setSslmode(
      (VALID_SSL_MODES as readonly string[]).includes(conn.sslmode)
        ? (conn.sslmode as PostgresSslMode)
        : "prefer",
    );
    setLastSavedSource(conn.source);
    setSavedSchemaText(null);
    setSavedSchemaError(null);
    setSavedSchemaLoading(false);
  }

  useEffect(() => {
    if (lastInitializedIdRef.current === editingId) return;
    lastInitializedIdRef.current = editingId;
    applyConnectionToForm(latestEditingRef.current);
  }, [editingId, showDemoOption]);

  useEffect(() => {
    const conn = latestEditingRef.current;
    if (!editingId || !conn || !conn.source.ready) {
      setSavedSchemaLoading(false);
      setSavedSchemaText(null);
      setSavedSchemaError(null);
      return;
    }

    let cancelled = false;
    setSavedSchemaLoading(true);
    setSavedSchemaError(null);
    bff
      .databaseSchema(conn.source.id)
      .then((res) => {
        if (!cancelled) setSavedSchemaText(res.schema);
      })
      .catch((err) => {
        if (!cancelled) setSavedSchemaError(String(err));
      })
      .finally(() => {
        if (!cancelled) setSavedSchemaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingId, editing?.source.ready, editing?.updated_at]);

  function invalidateDraftResults() {
    draftRevisionRef.current += 1;
    if (testFeedback !== null || message !== null) {
      setTestFeedback(null);
      setMessage(null);
      setMessageTone("error");
      setCopiedError(false);
      setCopyErrorMsg(null);
    }
  }

  function chooseEngine(item: DataEngine) {
    if (isEditMode) return;
    draftRevisionRef.current += 1;
    setEngine(item);
    setMode(item);
    if (item === "postgres" && (port === "3306" || !port.trim())) {
      setPort("5432");
    } else if (item === "mysql" && (port === "5432" || !port.trim())) {
      setPort("3306");
    }
    setMessage(null);
    setMessageTone("error");
    setTestFeedback(null);
    setCopiedError(false);
    setCopyErrorMsg(null);
  }

  function handleParseUrl() {
    const preferredLocal = engine === "duckdb" || engine === "sqlite" ? engine : undefined;
    const parsed = parseConnectionUri(pasteUrl, preferredLocal);
    if (!parsed.ok) {
      setPasteError(parsed.error);
      return;
    }
    const { value } = parsed;
    draftRevisionRef.current += 1;
    setPasteError(null);
    setEngine(value.engine);
    setMode(value.engine);
    if (!name.trim() && value.name) {
      setName(value.name);
    }
    if (value.engine === "postgres" || value.engine === "mysql") {
      setHost(value.host ?? "127.0.0.1");
      setPort(value.port ?? (value.engine === "mysql" ? "3306" : "5432"));
      setDatabase(value.database ?? "");
      setUsername(value.username ?? "");
      setPassword(value.password ?? "");
      setClearSavedPassword(false);
      if (value.engine === "postgres") {
        setSslmode(value.sslmode ?? "prefer");
      }
    } else {
      setPath(value.path ?? "");
    }
    setTestFeedback(null);
    setMessage("Parsed connection details. Click Test to verify.");
    setMessageTone("info");
    setPasteUrl("");
    setShowPasteUrl(false);
  }

  function buildTestPayload() {
    if (isNetworkEngine) {
      return {
        engine,
        host: host.trim(),
        port: Number(port),
        database: database.trim(),
        username: username.trim(),
        password,
        sslmode,
      };
    }
    return { engine, path: path.trim() };
  }

  function localEngine(): Extract<DataEngine, "sqlite" | "duckdb"> | null {
    return engine === "sqlite" || engine === "duckdb" ? engine : null;
  }

  function applySelectedPath(selectedPath: string) {
    setPath(selectedPath);
    invalidateDraftResults();
    if (!name.trim()) {
      const fileName = selectedPath.split(/[\\/]/).pop() ?? "";
      setName(fileName.replace(/\.(duckdb|sqlite3?|db)$/i, "") || fileName);
    }
  }

  async function selectFile() {
    const fileEngine = localEngine();
    if (!fileEngine) return;
    invalidateDraftResults();
    const requestRevision = draftRevisionRef.current;

    const desktopPicker = window.aurigaDesktop?.selectDatabaseFile;
    if (desktopPicker) {
      setBusy("file");
      try {
        const selectedPath = await desktopPicker(fileEngine);
        if (draftRevisionRef.current !== requestRevision) return;
        if (selectedPath) applySelectedPath(selectedPath);
      } catch (error) {
        if (draftRevisionRef.current !== requestRevision) return;
        setMessage(`Failed to select file: ${String(error)}`);
        setMessageTone("error");
      } finally {
        if (draftRevisionRef.current === requestRevision) setBusy(null);
      }
      return;
    }

    fileInputRef.current?.click();
  }

  async function importBrowserFile(file: File) {
    const fileEngine = localEngine();
    if (!fileEngine) return;
    invalidateDraftResults();
    const requestRevision = draftRevisionRef.current;
    setBusy("file");
    try {
      const result = await bff.importDatabaseFile(fileEngine, file);
      if (draftRevisionRef.current !== requestRevision) return;
      if (result.ok) {
        applySelectedPath(result.path);
        setMessage(result.message || "File selected");
        setMessageTone("info");
      } else {
        setMessage(result.message || "Selected file could not be validated");
        setMessageTone("error");
      }
    } catch (error) {
      if (draftRevisionRef.current !== requestRevision) return;
      setMessage(`Failed to import file: ${String(error)}`);
      setMessageTone("error");
    } finally {
      if (draftRevisionRef.current === requestRevision) setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function test() {
    if (isNetworkEngine && (!host.trim() || !port.trim() || !database.trim() || !username.trim())) {
      setMessage("Host, port, database, and username are required");
      setMessageTone("error");
      return;
    }
    if (!isNetworkEngine && !path.trim()) {
      setMessage("File path is required");
      setMessageTone("error");
      return;
    }
    const requestRevision = draftRevisionRef.current;
    setBusy("test");
    setMessage(null);
    setMessageTone("error");
    setTestFeedback(null);
    setCopiedError(false);
    setCopyErrorMsg(null);
    const startedAt = performance.now();
    try {
      const result = await bff.testDatabaseConnection(buildTestPayload());
      if (draftRevisionRef.current !== requestRevision) return;
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      const feedbackMsg = result.message || (result.ok ? "Connection succeeded" : "Connection failed");
      setTestFeedback({
        ok: result.ok,
        message: feedbackMsg,
        latencyMs,
        schemaPreview: result.schema_preview || "",
      });
      if (result.ok && !name.trim() && isNetworkEngine) {
        setName(database.trim() || host.trim());
      } else if (result.ok && !name.trim() && result.path) {
        const fileName = result.path.split("/").pop() ?? "";
        setName(fileName.replace(/\.(duckdb|sqlite3?|db)$/i, "") || fileName);
      }
      if (result.ok && result.schema_preview) {
        requestAnimationFrame(() => {
          schemaPreviewWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
    } catch (error) {
      if (draftRevisionRef.current !== requestRevision) return;
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      setTestFeedback({
        ok: false,
        message: String(error),
        latencyMs,
        schemaPreview: "",
      });
    } finally {
      if (draftRevisionRef.current === requestRevision) setBusy(null);
    }
  }

  async function save() {
    if (!name.trim()) {
      setMessage("Name is required");
      setMessageTone("error");
      return;
    }
    if (isNetworkEngine && (!host.trim() || !port.trim() || !database.trim() || !username.trim())) {
      setMessage("Host, port, database, and username are required");
      setMessageTone("error");
      return;
    }
    if (!isNetworkEngine && !path.trim()) {
      setMessage("Name and file path are required");
      setMessageTone("error");
      return;
    }
    if (
      editing &&
      isNetworkEngine &&
      !password &&
      !clearSavedPassword &&
      (host.trim() !== editing.host || username.trim() !== editing.username)
    ) {
      setMessage("Host or username changed — enter the password or check 'Clear saved password' before saving.");
      setMessageTone("error");
      return;
    }

    const requestRevision = draftRevisionRef.current;
    setBusy("save");
    setMessage(null);
    setTestFeedback(null);
    try {
      if (editing) {
        const patchPayload = isNetworkEngine
          ? {
              name: name.trim(),
              host: host.trim(),
              port: Number(port),
              database: database.trim(),
              username: username.trim(),
              sslmode,
              ...(clearSavedPassword ? { password: "" } : password ? { password } : {}),
            }
          : {
              name: name.trim(),
              path: path.trim(),
            };
        const result = await bff.updateDatabaseConnection(editing.id, patchPayload);
        if (draftRevisionRef.current !== requestRevision) return;
        lastInitializedIdRef.current = result.connection.id;
        setLastSavedSource(result.connection.source);
        setPassword("");
        setClearSavedPassword(false);
        setMessage("Connection updated");
        setMessageTone("success");
        await (props.onUpdated ? props.onUpdated(result.connection.source) : props.onCreated(result.connection.source));
      } else {
        const result = await bff.createDatabaseConnection({ name: name.trim(), ...buildTestPayload() });
        if (draftRevisionRef.current !== requestRevision) return;
        lastInitializedIdRef.current = result.connection.id;
        setLastSavedSource(result.connection.source);
        setPassword("");
        setMessage("Connection saved");
        setMessageTone("success");
        if (result.connection.source.ready) {
          setSavedSchemaLoading(true);
          bff
            .databaseSchema(result.connection.source.id)
            .then((res) => {
              setSavedSchemaText(res.schema);
              setSavedSchemaError(null);
            })
            .catch((err) => setSavedSchemaError(String(err)))
            .finally(() => setSavedSchemaLoading(false));
        }
        await props.onCreated(result.connection.source);
      }
    } catch (error) {
      if (draftRevisionRef.current !== requestRevision) return;
      setMessage(String(error));
      setMessageTone("error");
    } finally {
      if (draftRevisionRef.current === requestRevision) setBusy(null);
    }
  }

  async function selectDemoGroup(groupId: DemoGroupId) {
    setMode("demo");
    setPresetBusy(true);
    setMessage(null);
    try {
      const selected = await bff.connectDemoGroup(groupId);
      const latest = await bff.demoConnections().catch(() => null);
      if (latest) {
        setDemoConnections(latest.connections);
      } else {
        setDemoConnections((items) =>
          items.map((item) => (item.source_group === groupId ? selected : item)),
        );
      }
      setMessageTone(selected.ready_count > 0 ? "success" : "error");
      setMessage(
        selected.ready_count > 0
          ? `${groupId === "bird" ? "BIRD" : "BIRD-Interact"} connected.`
          : selected.reason || `Unable to connect ${groupId === "bird" ? "BIRD" : "BIRD-Interact"}.`,
      );
      props.onDemoGroupConnected?.(selected);
    } catch (error) {
      setMessageTone("error");
      setMessage(`Failed to connect demo data: ${String(error)}`);
    } finally {
      setPresetBusy(false);
    }
  }

  async function disconnectDemoGroups() {
    setMode("demo");
    setPresetBusy(true);
    setMessage(null);
    try {
      const results: DemoConnection[] = [];
      for (const groupId of DEMO_GROUP_IDS) {
        results.push(await bff.disconnectDemoGroup(groupId));
      }
      setDemoConnections((items) =>
        items.map((item) => results.find((result) => result.source_group === item.source_group) ?? item),
      );
      setMessageTone("info");
      setMessage(null);
      results.forEach((result) => props.onDemoGroupConnected?.(result));
    } catch (error) {
      setMessageTone("error");
      setMessage(`Failed to disconnect demo data: ${String(error)}`);
    } finally {
      setPresetBusy(false);
    }
  }

  function handleDemoClick() {
    setMode("demo");
    setMessage(null);
    setMessageTone(demoConnected ? "success" : "info");
  }

  async function copyTestError(text: string) {
    setCopyErrorMsg(null);
    if (!navigator.clipboard?.writeText) {
      setCopyErrorMsg("Clipboard unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedError(true);
    } catch {
      setCopyErrorMsg("Copy failed");
    }
  }

  const showingDraftSchema = Boolean(testFeedback?.ok && testFeedback.schemaPreview);
  const activeSchemaText = showingDraftSchema
    ? testFeedback!.schemaPreview
    : savedSchemaText;
  const savedSourceForActions = isEditMode
    ? (editing?.source.ready ? editing.source : null)
    : (lastSavedSource?.ready ? lastSavedSource : null);
  const actionsReady = Boolean(savedSourceForActions && !showingDraftSchema);

  return (
    <section
      className={cn(
        "rounded-[18px] border border-line/80 bg-card/86 p-4 shadow-sm backdrop-blur",
        props.className,
      )}
    >
      <div className="space-y-4">
        <div
          className={cn(
            "grid gap-2",
            showDemoOption
              ? "grid-cols-2 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
              : "grid-cols-2 sm:grid-cols-4",
          )}
        >
          {ENGINE_CHOICES.map((item) => {
            const selected = selectedEngineMode === item;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={selected}
                disabled={busy !== null || (isEditMode && item !== engine)}
                onClick={() => chooseEngine(item)}
                className={cn(
                  "flex h-10 items-center justify-center gap-2 rounded-xl border text-[12px] font-medium transition-colors",
                  selected
                    ? "border-accent/60 bg-accent-soft text-accent"
                    : "border-line bg-canvas text-muted hover:bg-hover hover:text-ink",
                  (busy !== null || (isEditMode && item !== engine)) &&
                    "cursor-not-allowed opacity-40 hover:bg-canvas hover:text-muted",
                )}
              >
                <DialectIcon dialect={item} className="h-4 w-4" />
                <span className="truncate">{dialectLabel(item)}</span>
              </button>
            );
          })}
          {showDemoOption && (
            <button
              type="button"
              aria-pressed={mode === "demo"}
              onClick={handleDemoClick}
              disabled={presetBusy}
              title="Choose demo data"
              className={cn(
                "flex h-10 items-center justify-center gap-2 rounded-xl border px-3 text-[12px] font-medium transition-colors",
                mode === "demo"
                  ? "border-accent/60 bg-accent-soft text-accent"
                  : "border-line bg-canvas text-muted hover:border-accent/50 hover:bg-accent-soft hover:text-accent",
              )}
            >
              {presetBusy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <Database className="h-4 w-4 shrink-0" />
              )}
              <span className="whitespace-nowrap">Demo</span>
            </button>
          )}
        </div>

        {showDemoOption && mode === "demo" && (
          <div className="space-y-3">
            <p className="text-[13px] font-semibold text-ink">Choose demo data</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {demoGroups.map((group) => {
                const selected = group.connected && connectedDemoGroups.length === 1;
                const label = group.source_group === "bird" ? "BIRD" : "BIRD-Interact";
                return (
                  <div
                    key={group.source_group}
                    className={cn(
                      "flex min-w-0 items-center rounded-2xl border transition-colors",
                      selected
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-line bg-canvas text-muted hover:border-accent/50 hover:bg-hover hover:text-ink",
                    )}
                  >
                    <button
                      type="button"
                      disabled={presetBusy}
                      aria-pressed={selected}
                      onClick={() => void selectDemoGroup(group.source_group)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 p-3 text-left"
                    >
                      <span className="truncate text-[13px] font-semibold">{label}</span>
                    </button>
                    {selected && (
                      <button
                        type="button"
                        disabled={presetBusy}
                        aria-label={`Disconnect ${label}`}
                        onClick={() => void disconnectDemoGroups()}
                        className="mr-2 inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-accent transition hover:bg-danger-soft hover:text-danger"
                      >
                        <Unplug className="h-3 w-3" />
                        Disconnect
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "min-h-6 text-[12px]",
                messageTone === "success" ? "text-accent" : messageTone === "error" && message ? "text-danger" : "text-muted",
              )}
            >
              {message ||
                (demoConnected
                  ? `${connectedDemoGroups[0]?.source_group === "bird" ? "BIRD" : "BIRD-Interact"} connected.`
                  : "Select a demo dataset to connect.")}
            </p>
          </div>
        )}

        {mode === null && <p className="text-[12px] text-muted">Demo data disconnected.</p>}

        {selectedEngineMode && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <DialectIcon dialect={engine} className="h-4 w-4" />
                <span className="truncate text-[13px] font-semibold text-ink">
                  {isEditMode ? `Edit ${editing.name}` : `${selectedEngineLabel} connection`}
                </span>
                {isEditMode && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                      editing.ready ? "bg-accent-soft text-accent" : "bg-danger-soft text-danger",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", editing.ready ? "bg-accent" : "bg-danger")} />
                    {editing.ready ? "Ready" : "Offline"}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {!isEditMode && (
                  <button
                    type="button"
                    aria-expanded={showPasteUrl}
                    onClick={() => {
                      setShowPasteUrl((prev) => {
                        if (prev) setPasteUrl("");
                        return !prev;
                      });
                      setPasteError(null);
                    }}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-medium transition",
                      showPasteUrl
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-line bg-canvas text-muted hover:bg-hover hover:text-ink",
                    )}
                  >
                    <ClipboardPaste className="h-3.5 w-3.5" />
                    Paste URL
                  </button>
                )}
                {isEditMode && props.onCancelEdit && (
                  <button
                    type="button"
                    onClick={props.onCancelEdit}
                    className="inline-flex h-7 items-center rounded-lg border border-line bg-canvas px-2.5 text-[11.5px] font-medium text-muted transition hover:bg-hover hover:text-ink"
                  >
                    New instead
                  </button>
                )}
              </div>
            </div>

            {showPasteUrl && !isEditMode && (
              <div className="space-y-2 rounded-2xl border border-accent/25 bg-accent-soft/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={pasteInputId} className="text-[11.5px] font-semibold text-ink">
                    Paste connection string
                  </label>
                  <span className="text-[10.5px] text-muted">postgresql://, mysql://, sqlite:///, duckdb:///</span>
                </div>
                <div className="flex gap-2">
                  <input
                    id={pasteInputId}
                    type="password"
                    value={pasteUrl}
                    onChange={(event) => {
                      setPasteUrl(event.target.value);
                      setPasteError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleParseUrl();
                      }
                    }}
                    placeholder="postgresql://user:pass@127.0.0.1:5433/db?sslmode=disable"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 font-mono text-[12px] text-ink outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={handleParseUrl}
                    className="inline-flex h-9 shrink-0 items-center rounded-xl bg-accent px-3.5 text-[12px] font-medium text-accent-ink transition hover:opacity-90"
                  >
                    Parse
                  </button>
                </div>
                {pasteError && (
                  <p role="alert" className="text-[11.5px] text-danger">
                    {pasteError}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-3" onChangeCapture={invalidateDraftResults}>
              <div>
                <label htmlFor={nameInputId} className="mb-1 block text-[12px] font-medium text-muted">
                  Name
                </label>
                <input
                  id={nameInputId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Demo Postgres"
                  className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                />
              </div>

              {isNetworkEngine ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-[1fr_84px] gap-2">
                    <div>
                      <label htmlFor={hostInputId} className="mb-1 block text-[12px] font-medium text-muted">
                        Host
                      </label>
                      <input
                        id={hostInputId}
                        value={host}
                        onChange={(event) => setHost(event.target.value)}
                        placeholder="127.0.0.1"
                        autoComplete="off"
                        spellCheck={false}
                        className="h-9 w-full rounded-xl border border-line bg-canvas px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
                      />
                    </div>
                    <div>
                      <label htmlFor={portInputId} className="mb-1 block text-[12px] font-medium text-muted">
                        Port
                      </label>
                      <input
                        id={portInputId}
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                        inputMode="numeric"
                        placeholder={engine === "mysql" ? "3306" : "5432"}
                        className="h-9 w-full rounded-xl border border-line bg-canvas px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor={databaseInputId} className="mb-1 block text-[12px] font-medium text-muted">
                      Database
                    </label>
                    <input
                      id={databaseInputId}
                      value={database}
                      onChange={(event) => setDatabase(event.target.value)}
                      placeholder="analytics"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-9 w-full rounded-xl border border-line bg-canvas px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <label htmlFor={usernameInputId} className="mb-1 block text-[12px] font-medium text-muted">
                        Username
                      </label>
                      <input
                        id={usernameInputId}
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder={engine === "mysql" ? "root" : "postgres"}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-9 w-full rounded-xl border border-line bg-canvas px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
                      />
                    </div>
                    <div>
                      <label htmlFor={passwordInputId} className="mb-1 block text-[12px] font-medium text-muted">
                        Password
                      </label>
                      <div className="relative">
                        <input
                          id={passwordInputId}
                          value={password}
                          disabled={clearSavedPassword}
                          onChange={(event) => {
                            setPassword(event.target.value);
                            if (event.target.value) setClearSavedPassword(false);
                          }}
                          type={showPassword ? "text" : "password"}
                          placeholder={
                            clearSavedPassword
                              ? "Password will be cleared"
                              : isEditMode
                                ? "Leave blank to keep saved"
                                : "Password"
                          }
                          autoComplete="new-password"
                          spellCheck={false}
                          className="h-9 w-full rounded-xl border border-line bg-canvas pl-3 pr-9 font-mono text-[12.5px] text-ink outline-none focus:border-accent disabled:opacity-50"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          title={showPassword ? "Hide password" : "Show password"}
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint transition hover:bg-hover hover:text-ink"
                        >
                          {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      {isEditMode && (
                        <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
                          <input
                            type="checkbox"
                            checked={clearSavedPassword}
                            onChange={(event) => {
                              setClearSavedPassword(event.target.checked);
                              if (event.target.checked) setPassword("");
                            }}
                            className="rounded border-line"
                          />
                          <span>Clear saved password</span>
                        </label>
                      )}
                    </div>
                  </div>

                  {isPostgres && (
                    <div className="space-y-1.5 rounded-xl border border-line/80 bg-surface/60 p-3">
                      <div className="flex items-center gap-1.5">
                        <Lock className="h-3.5 w-3.5 text-muted" />
                        <span className="text-[12px] font-medium text-muted">SSL mode</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(["disable", "prefer", "require", "allow", "verify-ca", "verify-full"] as const).map(
                          (item) => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => {
                                setSslmode(item);
                                invalidateDraftResults();
                              }}
                              aria-pressed={sslmode === item}
                              className={cn(
                                "rounded-lg border px-2.5 py-1 font-mono text-[11.5px] font-medium transition",
                                sslmode === item
                                  ? "border-accent bg-accent-soft text-accent"
                                  : "border-line bg-canvas text-muted hover:bg-hover hover:text-ink",
                              )}
                            >
                              {item}
                            </button>
                          ),
                        )}
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted">{SSL_MODE_HINTS[sslmode]}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <label htmlFor={pathInputId} className="mb-1 block text-[12px] font-medium text-muted">
                    File path
                  </label>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <input
                      id={pathInputId}
                      value={path}
                      onChange={(event) => {
                        setPath(event.target.value);
                        invalidateDraftResults();
                      }}
                      placeholder={
                        engine === "duckdb"
                          ? "Enter path or select a .duckdb file"
                          : "Enter path or select a .sqlite file"
                      }
                      className="h-9 w-full rounded-xl border border-line bg-canvas px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => void selectFile()}
                      disabled={busy !== null}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-accent/45 bg-card px-3 text-[13px] font-medium text-accent transition hover:bg-accent-soft disabled:opacity-60"
                    >
                      {busy === "file" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FolderOpen className="h-4 w-4" />
                      )}
                      Select File
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={engine === "duckdb" ? ".duckdb,.db" : ".sqlite,.sqlite3,.db"}
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importBrowserFile(file);
                    }}
                  />
                </div>
              )}
            </div>

            {isEditMode && !editing.ready && editing.reason && !testFeedback && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-[12px] text-danger"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{editing.reason}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="text-[11px] text-muted">
                {isEditMode && isNetworkEngine && !password && !clearSavedPassword
                  ? "Enter password to re-test, or leave blank on Save to keep existing."
                  : "Connections are verified read-only before saving."}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void test()}
                  disabled={busy !== null}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-canvas px-3 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
                >
                  {busy === "test" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Database className="h-3.5 w-3.5" />
                  )}
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy !== null}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-accent px-3.5 text-[12px] font-medium text-accent-ink transition hover:opacity-90 disabled:opacity-60"
                >
                  {busy === "save" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  {isEditMode ? "Save Changes" : "Save"}
                </button>
              </div>
            </div>

            {testFeedback && (
              <div
                role="status"
                aria-live="polite"
                className={cn(
                  "rounded-xl border px-3.5 py-2.5 text-[12px]",
                  testFeedback.ok
                    ? "border-accent/35 bg-accent-soft/60 text-ink"
                    : "border-danger/30 bg-danger-soft text-danger",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    {testFeedback.ok ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    ) : (
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium break-words">{testFeedback.message}</div>
                      {testFeedback.ok && (
                        <div className="mt-0.5 text-[11px] text-muted">
                          Read-only check passed · {testFeedback.latencyMs} ms
                        </div>
                      )}
                    </div>
                  </div>
                  {!testFeedback.ok && (
                    <button
                      type="button"
                      onClick={() => void copyTestError(testFeedback.message)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-danger/25 bg-card px-2 py-1 text-[11px] font-medium text-danger transition hover:bg-hover"
                    >
                      <Copy className="h-3 w-3" />
                      {copyErrorMsg || (copiedError ? "Copied" : "Copy")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {message && (
              <p
                role="status"
                aria-live="polite"
                className={cn(
                  "text-[12px]",
                  messageTone === "success"
                    ? "text-accent"
                    : messageTone === "info"
                      ? "text-muted"
                      : "text-danger",
                )}
              >
                {message}
              </p>
            )}

            <div ref={schemaPreviewWrapRef}>
              <SchemaPreviewCard
                schemaText={activeSchemaText}
                loading={!showingDraftSchema && savedSchemaLoading}
                error={!showingDraftSchema ? savedSchemaError : null}
                databaseName={
                  showingDraftSchema
                    ? (database.trim() || name.trim())
                    : (savedSourceForActions?.display_name || database.trim() || name.trim())
                }
                canAct={actionsReady}
                onUseInChat={
                  savedSourceForActions && props.onUseSource
                    ? () => props.onUseSource?.(savedSourceForActions)
                    : undefined
                }
                onOpenInCanvas={
                  savedSourceForActions && props.onOpenInCanvas
                    ? () => props.onOpenInCanvas?.(savedSourceForActions)
                    : undefined
                }
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
