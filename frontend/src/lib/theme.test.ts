import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENTS,
  applyTheme,
  getAccent,
  getThemePreference,
  initTheme,
  setAccent,
  setThemePreference,
} from "./theme";

function stubBrowserEnv(initialStorage: Record<string, string> = {}, prefersDark = false) {
  const storage = new Map(Object.entries(initialStorage));
  const dataset: Record<string, string> = {};
  const listeners: Array<() => void> = [];

  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    matchMedia: () => ({
      matches: prefersDark,
      addEventListener: (_event: string, cb: () => void) => {
        listeners.push(cb);
      },
    }),
  });

  return { dataset, storage, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preferences", () => {
  it("defaults to light-yellow theme with amber accent", () => {
    const { dataset } = stubBrowserEnv();
    expect(getThemePreference()).toBe("light-yellow");
    expect(getAccent()).toBe("amber");
    expect(ACCENTS).toContain("yellow");

    initTheme();
    expect(dataset.theme).toBe("light-yellow");
    expect(dataset.accent).toBe("amber");
  });

  it("persists light-yellow, yellow accent, and respects system dark mode", () => {
    const { dataset, storage } = stubBrowserEnv({}, true);
    setThemePreference("light-yellow");
    setAccent("yellow");
    expect(storage.get("aurigasql-theme")).toBe("light-yellow");
    expect(storage.get("aurigasql-accent")).toBe("yellow");
    expect(dataset.theme).toBe("light-yellow");
    expect(dataset.accent).toBe("yellow");

    applyTheme("system");
    expect(dataset.theme).toBe("dark");
  });
});
