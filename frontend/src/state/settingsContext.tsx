import { createContext, useContext } from "react";

export type SettingsTab = "general" | "models" | "connections" | "data" | "about";

/** Opens the app Settings panel. Provided at the App root so any sidebar can
 *  open it without threading a prop through every page. Null when no provider. */
export type OpenSettingsOptions = {
  /** Models tab only: open straight on the "Add a model" form instead of the saved-models list. */
  addModel?: boolean;
};

export type OpenSettings = (tab?: SettingsTab, options?: OpenSettingsOptions) => void;

export const SettingsContext = createContext<OpenSettings | null>(null);

export function useOpenSettings(): OpenSettings | null {
  return useContext(SettingsContext);
}
