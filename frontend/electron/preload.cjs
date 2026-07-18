const { contextBridge, ipcRenderer } = require("electron");

const backendBaseArg = process.argv.find((arg) => arg.startsWith("--aurigasql-bff-base="));
const backendBase = backendBaseArg ? backendBaseArg.slice("--aurigasql-bff-base=".length) : "";

contextBridge.exposeInMainWorld("aurigaDesktop", {
  platform: process.platform,
  backendBase: backendBase || undefined,
  selectDatabaseFile: (engine) => ipcRenderer.invoke("database:select-file", engine),
  getBundledModel: () => ipcRenderer.invoke("model:get-bundled"),
  restartBackend: () => ipcRenderer.invoke("app:restart-backend"),
});
