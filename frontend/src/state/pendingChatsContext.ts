import { createContext, type Dispatch } from "react";
import type { Action, PendingHistoryChat } from "./types";

export const PendingChatsContext = createContext<{
  chats: PendingHistoryChat[];
  dispatch: Dispatch<Action>;
} | null>(null);
