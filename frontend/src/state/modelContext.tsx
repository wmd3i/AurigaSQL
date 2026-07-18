import { createContext, useContext } from "react";
import type { ModelInfo } from "../api/bff";

/** App-wide selected LLM model. Provided at the App root so the home composer
 *  (interactive picker) and the canvas/result bylines (read-only label) all
 *  reflect the same choice. The selected id is what gets sent to the backend. */
export type ModelCtx = {
  models: ModelInfo[];
  selectedId: string;
  setSelectedId: (id: string) => void;
};

export const ModelContext = createContext<ModelCtx>({
  models: [],
  selectedId: "",
  setSelectedId: () => {},
});

export function useModels(): ModelCtx {
  return useContext(ModelContext);
}

/** Human-facing label for the current selection (falls back to id, then "Model"). */
export function useSelectedModelLabel(): string {
  const { models, selectedId } = useModels();
  return models.find((m) => m.id === selectedId)?.label ?? selectedId ?? "Model";
}
