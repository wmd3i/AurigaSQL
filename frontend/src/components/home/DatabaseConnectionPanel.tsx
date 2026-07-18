import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Database,
  FolderOpen,
  Loader2,
  Unplug,
} from "lucide-react";
import { bff, type DemoConnection, type DemoGroupId, type DataEngine, type DataSource } from "../../api/bff";
import { cn } from "../../lib/cn";
import { DialectIcon, dialectLabel } from "./DialectIcon";

type SslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
const ENGINE_CHOICES: DataEngine[] = ["postgres", "mysql", "duckdb", "sqlite"];
const DEMO_GROUP_IDS: DemoGroupId[] = ["bird", "bird_interact_a"];
type ConnectionMode = DataEngine | "demo" | null;

export function DatabaseConnectionPanel(props: {
  onCreated: (source: DataSource) => void;
  onDemoGroupConnected?: (connection: DemoConnection) => void;
  className?: string;
}) {
  const [engine, setEngine] = useState<DataEngine>("postgres");
  const [mode, setMode] = useState<ConnectionMode>("demo");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sslmode, setSslmode] = useState<SslMode>("prefer");
  const [busy, setBusy] = useState<"test" | "save" | "file" | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [demoConnections, setDemoConnections] = useState<DemoConnection[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isPostgres = engine === "postgres";
  const isNetworkEngine = engine === "postgres" || engine === "mysql";
  const selectedEngineLabel = dialectLabel(engine);
  const selectedEngineMode = mode !== null && mode !== "demo" ? mode : null;
  const demoGroups: DemoConnection[] = useMemo(
    () => DEMO_GROUP_IDS.map((groupId) => demoConnections.find((item) => item.source_group === groupId) ?? {
      source_group: groupId,
      label: groupId === "bird" ? "BIRD SQLite" : "BIRD-Interact Demo (SQLite Edition)",
      engine: "sqlite",
      description: "Bundled SQLite demo databases",
      connected: false,
      ready_count: 0,
      reason: "",
    }),
    [demoConnections],
  );
  const connectedDemoGroups = demoGroups.filter((item) => item.connected);
  const demoConnected = connectedDemoGroups.length > 0;

  useEffect(() => {
    bff.demoConnections()
      .then((response) => setDemoConnections(response.connections))
      .catch(() => {});
  }, []);

  function chooseEngine(item: DataEngine) {
    setEngine(item);
    setMode(item);
    if (item === "postgres" && port === "3306") {
      setPort("5432");
    } else if (item === "mysql" && port === "5432") {
      setPort("3306");
    }
    setOk(false);
    setMessage(null);
  }

  function payload() {
    if (isNetworkEngine) {
      return {
        engine,
        host,
        port: Number(port),
        database,
        username,
        password,
        sslmode,
      };
    }
    return { engine, path };
  }

  function localEngine(): Extract<DataEngine, "sqlite" | "duckdb"> | null {
    return engine === "sqlite" || engine === "duckdb" ? engine : null;
  }

  function applySelectedPath(selectedPath: string) {
    setPath(selectedPath);
    setOk(false);
    if (!name.trim()) {
      const fileName = selectedPath.split(/[\\/]/).pop() ?? "";
      setName(fileName.replace(/\.(duckdb|sqlite3?|db)$/i, "") || fileName);
    }
  }

  async function selectFile() {
    const fileEngine = localEngine();
    if (!fileEngine) return;
    setMessage(null);
    setOk(false);

    const desktopPicker = window.aurigaDesktop?.selectDatabaseFile;
    if (desktopPicker) {
      setBusy("file");
      try {
        const selectedPath = await desktopPicker(fileEngine);
        if (selectedPath) applySelectedPath(selectedPath);
      } catch (error) {
        setMessage(`Failed to select file: ${String(error)}`);
      } finally {
        setBusy(null);
      }
      return;
    }

    fileInputRef.current?.click();
  }

  async function importBrowserFile(file: File) {
    const fileEngine = localEngine();
    if (!fileEngine) return;
    setBusy("file");
    setMessage(null);
    setOk(false);
    try {
      const result = await bff.importDatabaseFile(fileEngine, file);
      applySelectedPath(result.path);
      setOk(result.ok);
      setMessage(result.message || "File selected");
    } catch (error) {
      setMessage(`Failed to import file: ${String(error)}`);
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function test() {
    if (isNetworkEngine && (!host.trim() || !port.trim() || !database.trim() || !username.trim())) {
      setMessage("Host, port, database, and username are required");
      setOk(false);
      return;
    }
    if (!isNetworkEngine && !path.trim()) {
      setMessage("File path is required");
      setOk(false);
      return;
    }
    setBusy("test");
    setMessage(null);
    setOk(false);
    try {
      const result = await bff.testDatabaseConnection(payload());
      setOk(result.ok);
      setMessage(result.message || (result.ok ? "Connection succeeded" : "Connection failed"));
      if (result.ok && !name.trim() && isNetworkEngine) {
        setName(database.trim() || host.trim());
      } else if (result.ok && !name.trim() && result.path) {
        const fileName = result.path.split("/").pop() ?? "";
        setName(fileName.replace(/\.(duckdb|sqlite3?|db)$/i, "") || fileName);
      }
    } catch (error) {
      setOk(false);
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!name.trim()) {
      setMessage("Name is required");
      setOk(false);
      return;
    }
    if (isNetworkEngine && (!host.trim() || !port.trim() || !database.trim() || !username.trim())) {
      setMessage("Host, port, database, and username are required");
      setOk(false);
      return;
    }
    if (!isNetworkEngine && !path.trim()) {
      setMessage("Name and file path are required");
      setOk(false);
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const result = await bff.createDatabaseConnection({ name, ...payload() });
      props.onCreated(result.connection.source);
      setName("");
      setPath("");
      setDatabase("");
      setPassword("");
      setMessage("Connection saved");
      setOk(true);
    } catch (error) {
      setOk(false);
      setMessage(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function selectDemoGroup(groupId: DemoGroupId) {
    setMode("demo");
    setPresetBusy(true);
    setMessage(null);
    try {
      const results: DemoConnection[] = [];
      for (const otherDemoGroupId of DEMO_GROUP_IDS) {
        if (otherDemoGroupId !== groupId) {
          results.push(await bff.disconnectDemoGroup(otherDemoGroupId));
        }
      }
      const selected = await bff.connectDemoGroup(groupId);
      results.push(selected);
      setDemoConnections((items) => [
        ...items.filter((item) => !DEMO_GROUP_IDS.includes(item.source_group)),
        ...results,
      ]);
      setOk(selected.ready_count > 0);
      setMessage(
        selected.ready_count > 0
          ? `${groupId === "bird" ? "BIRD" : "BIRD-Interact"} connected.`
          : selected.reason || `Unable to connect ${groupId === "bird" ? "BIRD" : "BIRD-Interact"}.`,
      );
      results.forEach((result) => props.onDemoGroupConnected?.(result));
    } catch (error) {
      setOk(false);
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
      setDemoConnections((items) => items.map(
        (item) => results.find((result) => result.source_group === item.source_group) ?? item,
      ));
      setMode("demo");
      setOk(false);
      setMessage(null);
      results.forEach((result) => props.onDemoGroupConnected?.(result));
    } catch (error) {
      setOk(false);
      setMessage(`Failed to disconnect demo data: ${String(error)}`);
    } finally {
      setPresetBusy(false);
    }
  }

  function handleDemoClick() {
    setMode("demo");
    setOk(demoConnected);
    setMessage(null);
  }

  return (
    <section className={cn("rounded-[18px] border border-line/80 bg-card/86 p-4 shadow-sm backdrop-blur", props.className)}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
          {ENGINE_CHOICES.map((item) => {
            const selected = selectedEngineMode === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => chooseEngine(item)}
                className={cn(
                  "flex h-10 items-center justify-center gap-2 rounded-xl border text-[12px] font-medium transition-colors",
                  selected
                    ? "border-accent/60 bg-accent-soft text-accent"
                    : "border-line bg-canvas text-muted hover:bg-hover hover:text-ink",
                )}
              >
                <DialectIcon dialect={item} className="h-4 w-4" />
                <span className="truncate">{dialectLabel(item)}</span>
              </button>
            );
          })}
          <button
            type="button"
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
        </div>

        {mode === "demo" && (
          <div className="space-y-3">
            <p className="text-[13px] font-semibold text-ink">Choose demo data</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {demoGroups.map((group) => {
                const selected = group.connected && connectedDemoGroups.length === 1;
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
                      onClick={() => void selectDemoGroup(group.source_group)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 p-3 text-left"
                    >
                      <span className="truncate text-[13px] font-semibold">
                        {group.source_group === "bird" ? "BIRD" : "BIRD-Interact"}
                      </span>
                    </button>
                    {selected && (
                      <button
                        type="button"
                        disabled={presetBusy}
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
            <p className={cn("min-h-6 text-[12px]", ok ? "text-accent" : "text-muted")}>
              {message || (demoConnected
                ? `${connectedDemoGroups[0]?.source_group === "bird" ? "BIRD" : "BIRD-Interact"} connected.`
                : "Select a demo dataset to connect.")}
            </p>
          </div>
        )}

        {mode === null && (
          <p className="text-[12px] text-muted">Demo data disconnected.</p>
        )}

        {selectedEngineMode && (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <DialectIcon dialect={engine} className="h-4 w-4" />
              <span className="truncate text-[13px] font-semibold text-ink">{selectedEngineLabel} connection</span>
            </div>

            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Analytics"
                className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>

            {isNetworkEngine ? (
              <div className="space-y-3">
              <div className="grid grid-cols-[1fr_76px] gap-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted">Host</span>
                  <input
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="127.0.0.1"
                    className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted">Port</span>
                  <input
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    inputMode="numeric"
                    placeholder={engine === "mysql" ? "3306" : "5432"}
                    className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-muted">Database</span>
                <input
                  value={database}
                  onChange={(event) => setDatabase(event.target.value)}
                  placeholder="analytics"
                  className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted">Username</span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={engine === "mysql" ? "root" : "postgres"}
                    className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted">Password</span>
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    placeholder="Password"
                    className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </label>
              </div>
              {isPostgres && (
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted">SSL mode</span>
                  <select
                    value={sslmode}
                    onChange={(event) => setSslmode(event.target.value as SslMode)}
                    className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                  >
                    {(["prefer", "require", "disable", "allow", "verify-ca", "verify-full"] as const).map((mode) => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ) : (
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted">File path</span>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <input
                  value={path}
                  onChange={(event) => {
                    setPath(event.target.value);
                    setOk(false);
                    setMessage(null);
                  }}
                  placeholder={engine === "duckdb" ? "Enter path or select a .duckdb file" : "Enter path or select a .sqlite file"}
                  className="h-9 w-full rounded-xl border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={selectFile}
                  disabled={busy !== null}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-accent/45 bg-card px-3 text-[13px] font-medium text-accent transition hover:bg-accent-soft disabled:opacity-60"
                >
                  {busy === "file" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
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
            </label>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={test}
              disabled={busy !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-canvas px-3 text-[12px] text-ink transition hover:bg-hover disabled:opacity-60"
            >
              {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
              Test
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-accent px-3 text-[12px] font-medium text-white transition hover:opacity-90 disabled:opacity-60"
            >
              {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>

          {message && (
            <p className={cn("text-[12px]", ok ? "text-accent" : "text-danger")}>
              {message}
            </p>
          )}
          </>
        )}
      </div>
    </section>
  );
}
