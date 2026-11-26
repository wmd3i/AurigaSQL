import { createContext, useContext } from "react";

export type SettingsTab = "general" | "models" | "data" | "about";

/** Opens the app Settings panel. Provided at the App root so any sidebar can
 *  open it without threading a prop through every page. Null when no provider. */
export const SettingsContext = createContext<((tab?: SettingsTab) => void) | null>(null);

export function useOpenSettings(): ((tab?: SettingsTab) => void) | null {
  return useContext(SettingsContext);
}
