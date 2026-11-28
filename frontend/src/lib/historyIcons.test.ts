import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HISTORY_ICON_STYLE, getHistoryIconStyle, setHistoryIconStyle } from "./historyIcons";

/* Node has no window: give the module a minimal one with in-memory storage. */
function installWindow() {
  const store = new Map<string, string>();
  const target = new EventTarget();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  });
  return store;
}

describe("history icon preference", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installWindow();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to Retro Pets", () => {
    expect(DEFAULT_HISTORY_ICON_STYLE).toBe("retroPets");
    expect(getHistoryIconStyle()).toBe("retroPets");
  });

  it("remembers the chosen set, including off", () => {
    setHistoryIconStyle("starSeal");
    expect(getHistoryIconStyle()).toBe("starSeal");
    setHistoryIconStyle("off");
    expect(getHistoryIconStyle()).toBe("off");
  });

  it("ignores an unknown stored value", () => {
    store.set("aurigasql-history-icons", "critters");
    expect(getHistoryIconStyle()).toBe("retroPets");
  });

  it("falls back to the default without a window", () => {
    vi.unstubAllGlobals();
    expect(getHistoryIconStyle()).toBe("retroPets");
  });
});
