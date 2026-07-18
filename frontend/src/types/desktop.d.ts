import type { DataEngine } from "../api/bff";

export type BundledModelProfile = {
  id?: string;
  label: string;
  provider: "openai" | "gemini" | "zai" | "anthropic" | "minimax" | "xai" | "ollama";
  model: string;
  apiKey: string;
  apiBase: string;
};

declare global {
  interface Window {
    aurigaDesktop?: {
      platform: NodeJS.Platform;
      backendBase?: string;
      selectDatabaseFile?: (engine: Extract<DataEngine, "sqlite" | "duckdb">) => Promise<string>;
      getBundledModel?: () => Promise<BundledModelProfile | null>;
      restartBackend?: () => Promise<{ ok: boolean; message?: string }>;
    };
  }
}

export {};
