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
  it("defaults to light with plain accent regardless of the system theme", () => {
    const { dataset } = stubBrowserEnv({}, true);
    expect(getThemePreference()).toBe("light");
    expect(getAccent()).toBe("plain");
    expect(ACCENTS).toContain("yellow");

    initTheme();
    expect(dataset.theme).toBe("light");
    expect(dataset.accent).toBe("plain");
  });

  it("persists light, yellow accent, and respects system dark mode", () => {
    const { dataset, storage } = stubBrowserEnv({}, true);
    setThemePreference("light");
    setAccent("yellow");
    expect(storage.get("aurigasql-theme")).toBe("light");
    expect(storage.get("aurigasql-accent")).toBe("yellow");
    expect(dataset.theme).toBe("light");
    expect(dataset.accent).toBe("yellow");

    applyTheme("system");
    expect(dataset.theme).toBe("dark");
  });

  it("restores the previous light-yellow preference as light while preserving its accent", () => {
    const { dataset } = stubBrowserEnv({ "aurigasql-theme": "light-yellow", "aurigasql-accent": "yellow" });
    initTheme();
    expect(getThemePreference()).toBe("light");
    expect(dataset.theme).toBe("light");
    expect(dataset.accent).toBe("yellow");
  });
});
