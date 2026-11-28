import { useSyncExternalStore } from "react";

/** Which icon set marks each History entry (chat sidebar and canvas rail), or "off".
 *  Stored per browser like the theme; components re-render when it changes. */
export type HistoryIconStyle = "retroPets" | "pets" | "starSketch" | "starSeal" | "retroData" | "retroBlobs" | "off";

export const HISTORY_ICON_STYLES: HistoryIconStyle[] = ["retroPets", "pets", "starSketch", "starSeal", "retroData", "retroBlobs", "off"];

export const DEFAULT_HISTORY_ICON_STYLE: HistoryIconStyle = "retroPets";

const KEY = "aurigasql-history-icons";
const listeners = new Set<() => void>();

function isStyle(value: unknown): value is HistoryIconStyle {
  return (HISTORY_ICON_STYLES as unknown[]).includes(value);
}

export function getHistoryIconStyle(): HistoryIconStyle {
  try {
    const value = window.localStorage.getItem(KEY);
    return isStyle(value) ? value : DEFAULT_HISTORY_ICON_STYLE;
  } catch {
    return DEFAULT_HISTORY_ICON_STYLE; // No window or storage blocked: use the default.
  }
}

export function setHistoryIconStyle(style: HistoryIconStyle) {
  try {
    window.localStorage.setItem(KEY, style);
  } catch {
    // Not persisted; listeners below still see the change for this session.
    memory = style;
  }
  listeners.forEach((listener) => listener());
}

/* Fallback when storage is unavailable, so the picker still works for the session. */
let memory: HistoryIconStyle | null = null;

function snapshot(): HistoryIconStyle {
  return memory ?? getHistoryIconStyle();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Keep other windows/tabs of the app in step.
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useHistoryIconStyle(): HistoryIconStyle {
  // The app has no server rendering; static renders (tests) read storage the same way.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
