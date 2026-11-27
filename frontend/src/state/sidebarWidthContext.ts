import { createContext, type Dispatch } from "react";
import type { Action } from "./types";

export const SidebarWidthContext = createContext<{
  width: number;
  dispatch: Dispatch<Action>;
} | null>(null);
