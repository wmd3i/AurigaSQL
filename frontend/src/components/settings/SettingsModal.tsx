import { useEffect, useState, type ReactNode } from "react";
import { Database, Download, ExternalLink, Info, Monitor, Moon, SlidersHorizontal, Sparkles, Sun, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../lib/cn";
import type { SettingsTab } from "../../state/settingsContext";
import { LlmConfigModal } from "./LlmConfigModal";

// Keep in sync with frontend/package.json "version".
const APP_VERSION = "0.1.0";
const REPO_URL = "https://github.com/wmd3i/AurigaSQL";

type Theme = "light" | "dark" | "system";

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Sun }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "models", label: "Models", icon: Sparkles },
  { id: "data", label: "Data", icon: Database },
  { id: "about", label: "About", icon: Info },
];

const THEMES: Array<{ id: Theme; label: string; icon: typeof Sun }> = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

/** Placeholder handler: these settings render but are not wired up yet. */
function comingSoon(feature: string) {
  toast.info(`${feature} isn't available yet`, { id: "settings-coming-soon" });
}

function Section(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[13.5px] font-semibold text-ink">{props.title}</h3>
        {props.description && <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{props.description}</p>}
      </div>
      {props.children}
    </section>
  );
}

function ActionRow(props: {
  title: string;
  description: string;
  action: string;
  icon: typeof Sun;
  danger?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className={cn("text-[13.5px] font-medium", props.danger ? "text-danger" : "text-ink")}>{props.title}</div>
        <div className="mt-0.5 text-[12.5px] leading-5 text-muted">{props.description}</div>
      </div>
      <button
        type="button"
        onClick={props.onClick}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition",
          props.danger
            ? "border-danger/30 text-danger hover:bg-danger-soft"
            : "border-line text-ink hover:bg-hover",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {props.action}
      </button>
    </div>
  );
}

function GeneralTab() {
  const [theme, setTheme] = useState<Theme>("light");
  const [systemPrompt, setSystemPrompt] = useState("");

  return (
    <div className="space-y-7">
      <Section title="Theme" description="Choose how AurigaSQL looks.">
        <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-full border border-line bg-surface p-0.5">
          {THEMES.map((option) => {
            const Icon = option.icon;
            const active = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(option.id)}
                title={option.id === "system" ? "Follow your computer's setting" : `${option.label} theme`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition",
                  active ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="System prompt"
        description="Added to the agent's built-in instructions for every question. Use it for business terms and rules."
      >
        <textarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={5}
          placeholder={"e.g. Our fiscal year starts in April.\n\"Revenue\" means amount minus refunds."}
          className="w-full resize-none rounded-xl border border-line bg-card px-3.5 py-3 text-[13.5px] leading-6 text-ink outline-none transition placeholder:text-faint focus:border-accent"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => comingSoon("Saving the system prompt")}
            className="rounded-full bg-invert px-4 py-1.5 text-[13px] font-medium text-invert-ink transition hover:opacity-90"
          >
            Save
          </button>
        </div>
      </Section>
    </div>
  );
}

function DataTab() {
  return (
    <Section title="Chats" description="Back up, restore or clear your chat history.">
      <div className="divide-y divide-line/70">
        <ActionRow
          title="Export chats"
          description="Download all chats as a JSON file."
          action="Export"
          icon={Download}
          onClick={() => comingSoon("Exporting chats")}
        />
        <ActionRow
          title="Import chats"
          description="Load chats from a JSON export."
          action="Import"
          icon={Upload}
          onClick={() => comingSoon("Importing chats")}
        />
        <ActionRow
          title="Delete all chats"
          description="Permanently remove every chat. This can't be undone."
          action="Delete all"
          icon={Trash2}
          danger
          onClick={() => comingSoon("Deleting all chats")}
        />
      </div>
    </Section>
  );
}

function AboutTab() {
  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: "Version", value: APP_VERSION },
    {
      label: "Source code",
      value: (
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
          github.com/wmd3i/AurigaSQL
          <ExternalLink className="h-3 w-3" />
        </a>
      ),
    },
    { label: "License", value: "MIT" },
  ];
  return (
    <div className="space-y-6">
      <div className="text-[22px] font-semibold tracking-tight text-ink">
        <span className="text-accent">Auriga</span>SQL
      </div>
      <dl className="divide-y divide-line/70 rounded-2xl border border-line">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 px-4 py-3 text-[13.5px]">
            <dt className="text-muted">{row.label}</dt>
            <dd className="text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function SettingsModal(props: {
  open: boolean;
  initialTab?: SettingsTab;
  onClose: () => void;
  onModelsChanged: (preferredModelId?: string) => Promise<void> | void;
}) {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? "general");

  useEffect(() => {
    if (props.open) setTab(props.initialTab ?? "general");
  }, [props.open, props.initialTab]);

  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,16,12,0.32)] p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="flex h-[min(600px,90vh)] w-full max-w-[760px] overflow-hidden rounded-[24px] border border-line bg-card shadow-[0_32px_100px_rgba(11,18,14,0.18)]">
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
          className="flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-line/70 bg-surface/60 px-3 py-5"
        >
          <h2 className="mb-3 px-2.5 text-[18px] font-semibold tracking-[-0.01em] text-ink">Settings</h2>
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13.5px] font-medium transition",
                  active ? "bg-card text-ink shadow-sm ring-1 ring-line/70" : "text-muted hover:bg-hover hover:text-ink",
                )}
              >
                <Icon className={cn("h-4 w-4", active && "text-accent")} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={props.onClose}
            title="Close"
            aria-label="Close"
            className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
          {tab === "models" ? (
            <div className="flex min-h-0 flex-1 flex-col pt-1">
              <LlmConfigModal embedded open onClose={props.onClose} onModelsChanged={props.onModelsChanged} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6 pr-14">
              {tab === "general" && <GeneralTab />}
              {tab === "data" && <DataTab />}
              {tab === "about" && <AboutTab />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
