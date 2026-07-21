const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_NAME = "AurigaSQL";
const APP_ICON = path.join(__dirname, "assets", "icon.png");
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:5173";
const BACKEND_PORT = Number(process.env.AURIGASQL_BFF_PORT || "6013");
const BACKEND_BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;
let backendProcess = null;
let backendRestartCount = 0;
let backendStopRequested = false;
let quitting = false;

// `electron .` runs through Electron's generic development executable. Set the
// product identity explicitly so the development shell matches packaged builds.
app.setName(APP_NAME);

ipcMain.handle("app:restart-backend", async () => {
  if (!app.isPackaged) return { ok: false, message: "Backend restart is only managed in packaged app mode." };
  await stopBackend();
  await startPackagedBackend({ force: true });
  await waitForBackendReady(BACKEND_BASE_URL, 45000);
  return { ok: true };
});

ipcMain.handle("model:get-bundled", async () => {
  try {
    return require("./bundled-model.cjs");
  } catch (_error) {
    return null;
  }
});

ipcMain.handle("database:select-file", async (_event, engine) => {
  const filters =
    engine === "duckdb"
      ? [{ name: "DuckDB databases", extensions: ["duckdb", "db"] }]
      : [{ name: "SQLite databases", extensions: ["sqlite", "sqlite3", "db"] }];
  const result = await dialog.showOpenDialog({
    title: "Select database file",
    properties: ["openFile"],
    filters: [...filters, { name: "All files", extensions: ["*"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return "";
  return result.filePaths[0];
});

function isAllowedAppUrl(url) {
  if (!app.isPackaged) {
    return url.startsWith(DEV_SERVER_URL);
  }
  return url.startsWith("file://") || url.startsWith("data:text/html");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: APP_NAME,
    icon: APP_ICON,
    backgroundColor: "#f7f4ee",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [
        `--aurigasql-bff-base=${app.isPackaged ? BACKEND_BASE_URL : process.env.AURIGASQL_BFF_BASE || ""}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  installAppMenu(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  if (app.isPackaged) {
    win.loadURL(loadingPageUrl());
    startPackagedBackend()
      .then(() => waitForBackendReady(BACKEND_BASE_URL, 45000))
      .then(() => {
        win.loadFile(path.join(__dirname, "../dist/index.html"));
      })
      .catch((error) => {
        win.loadURL(errorPageUrl(error));
      });
  } else {
    win.loadURL(DEV_SERVER_URL);
  }
}

function installAppMenu(win) {
  const logPath = backendLogPath();
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Restart Backend",
          accelerator: "CmdOrCtrl+Alt+R",
          click: async () => {
            if (!app.isPackaged) return;
            win.loadURL(loadingPageUrl("Restarting AurigaSQL..."));
            try {
              await stopBackend();
              await startPackagedBackend({ force: true });
              await waitForBackendReady(BACKEND_BASE_URL, 45000);
              win.loadFile(path.join(__dirname, "../dist/index.html"));
            } catch (error) {
              win.loadURL(errorPageUrl(error));
            }
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload", accelerator: "CmdOrCtrl+R" },
        { role: "forceReload", accelerator: "CmdOrCtrl+Shift+R" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Troubleshooting",
          click: () => {
            dialog.showMessageBox(win, {
              type: "info",
              title: "AurigaSQL Troubleshooting",
              message: "If AurigaSQL gets stuck",
              detail:
                "1. Use Pause in the canvas toolbar to stop the current run.\n" +
                "2. Press Command+R to reload the window.\n" +
                "3. Press Command+Option+R to restart the bundled backend service.\n\n" +
                `Backend logs are stored in ${logPath}.`,
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function loadingPageUrl(message = "AurigaSQL is loading") {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        align-items: center;
        background: #f7f4ee;
        color: #17211f;
        display: flex;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
      }
      .wrap { text-align: center; }
      .brand { font-size: 42px; font-weight: 760; letter-spacing: 0; margin-bottom: 14px; }
      .brand span { color: #0f8278; }
      .sub { color: #73817d; font-size: 18px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="brand"><span>Auriga</span>SQL</div>
      <div class="sub">${escapeHtml(message)}</div>
    </div>
  </body>
</html>
`)}`;
}

function errorPageUrl(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        align-items: center;
        background: #f7f4ee;
        color: #17211f;
        display: flex;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
      }
      .panel { max-width: 640px; padding: 28px; }
      .title { font-size: 30px; font-weight: 720; margin-bottom: 12px; }
      .message { color: #687671; font-size: 16px; line-height: 1.55; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div class="panel">
      <div class="title">AurigaSQL could not start</div>
      <div class="message">${escapeHtml(message)}</div>
    </div>
  </body>
</html>
`)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function startPackagedBackend(options = {}) {
  if (!options.force && await backendHealthOk(BACKEND_BASE_URL)) return;
  const resourcesDir = process.resourcesPath;
  const backendExecutableName = process.platform === "win32" ? "aurigasql-bff.exe" : "aurigasql-bff";
  const llamaServerName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const executable = path.join(resourcesDir, "backend", backendExecutableName);
  if (!fs.existsSync(executable)) {
    throw new Error(`Bundled backend was not found at ${executable}`);
  }
  const userDataDir = app.getPath("userData");
  const logPath = backendLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  backendProcess = spawn(executable, [], {
    cwd: userDataDir,
    env: {
      ...process.env,
      AURIGASQL_DESKTOP: "1",
      AURIGASQL_BFF_PORT: String(BACKEND_PORT),
      AURIGASQL_RESOURCES_DIR: resourcesDir,
      AURIGASQL_DATASETS_DIR: path.join(resourcesDir, "datasets"),
      AURIGASQL_LLAMA_SERVER_PATH: path.join(resourcesDir, "llama.cpp", llamaServerName),
      AURIGASQL_USER_DATA_DIR: userDataDir,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProcess.stdout.pipe(logStream, { end: false });
  backendProcess.stderr.pipe(logStream, { end: false });
  backendProcess.once("exit", (code, signal) => {
    const expectedStop = backendStopRequested || signal === "SIGTERM";
    const shouldRestart = !quitting && !expectedStop && code !== 0 && backendRestartCount < 2;
    if (code !== 0 && !expectedStop) {
      logStream.write(`\nBackend exited with code=${code} signal=${signal}\n`);
    }
    backendProcess = null;
    if (backendStopRequested) backendStopRequested = false;
    if (shouldRestart) {
      backendRestartCount += 1;
      logStream.write(`Restarting backend (${backendRestartCount}/2)\n`);
      startPackagedBackend({ force: true }).catch((error) => {
        logStream.write(`Backend restart failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      });
    }
  });
}

function backendHealthOk(baseUrl) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/health`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForBackendReady(baseUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await backendHealthOk(baseUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Backend did not become ready at ${baseUrl}. Check the backend log in ${backendLogPath()}`);
}

function backendLogPath() {
  return path.join(app.getPath("userData"), "logs", "backend.log");
}

function stopBackend(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const proc = backendProcess;
    if (!proc) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (backendProcess === proc) backendProcess = null;
      resolve();
    };
    proc.once("exit", finish);
    try {
      backendStopRequested = true;
      proc.kill("SIGTERM");
    } catch (_error) {
      finish();
      return;
    }
    setTimeout(() => {
      if (settled) return;
      try {
        proc.kill("SIGKILL");
      } catch (_error) {
        // The process may have already exited between the timeout and the kill.
      }
      finish();
    }, timeoutMs).unref?.();
  });
}

app.on("before-quit", () => {
  quitting = true;
  void stopBackend(1000);
});

app.whenReady().then(() => {
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock.setIcon(APP_ICON);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
