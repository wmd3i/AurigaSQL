import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import App from "./App";
import "./index.css";
import { initTheme } from "./lib/theme";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster
      position="top-right"
      closeButton
      toastOptions={{
        style: {
          background: "var(--card)",
          color: "var(--ink)",
          border: "1px solid var(--line)",
          borderRadius: "16px",
        },
      }}
    />
  </StrictMode>,
);
