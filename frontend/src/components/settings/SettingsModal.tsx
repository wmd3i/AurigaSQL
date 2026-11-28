import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  Database,
  Download,
  ExternalLink,
  Info,
  Monitor,
  Moon,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { DataSource } from "../../api/bff";
import { cn } from "../../lib/cn";
import type { SettingsTab } from "../../state/settingsContext";
import {
  ACCENTS,
  getAccent,
  getThemePreference,
  setAccent,
  setThemePreference,
  type AccentColor,
  type ThemePreference,
} from "../../lib/theme";
import {
  desktopNotificationsSupported,
  getDesktopNotifications,
  setDesktopNotifications,
} from "../../lib/notifications";
import { DataConnectionModal } from "../home/DataConnectionModal";
import { LlmConfigModal, type EmbeddedHeader } from "./LlmConfigModal";

// Keep in sync with frontend/package.json "version".
const APP_VERSION = "0.1.0";
const REPO_URL = "https://github.com/wmd3i/AurigaSQL";

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Sun }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "models", label: "Models", icon: Sparkles },
  { id: "connections", label: "Connections", icon: Database },
  { id: "data", label: "Data", icon: Archive },
  { id: "about", label: "About", icon: Info },
];

const THEMES: Array<{
  id: ThemePreference;
  label: string;
  icon: typeof Sun;
  hint: string;
}> = [
  { id: "light", label: "Light", icon: Sun, hint: "Light theme" },
  { id: "dark", label: "Dark", icon: Moon, hint: "Dark theme" },
  {
    id: "system",
    label: "System",
    icon: Monitor,
    hint: "Follow your computer's light or dark setting",
  },
];

/** Swatch colors (light shade) for the accent picker. */
const ACCENT_SWATCH: Record<AccentColor, { label: string; color: string }> = {
  plain: { label: "Plain", color: "" },
  teal: { label: "Teal", color: "#0f766e" },
  indigo: { label: "Indigo", color: "#4f46e5" },
  violet: { label: "Violet", color: "#7c3aed" },
  amber: { label: "Amber", color: "#b45309" },
};

/** Placeholder handler: these settings render but are not wired up yet. */
function comingSoon(feature: string) {
  toast.info(`${feature} isn't available yet`, { id: "settings-coming-soon" });
}

function Section(props: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[13.5px] font-semibold text-ink">{props.title}</h3>
        {props.description && (
          <p className="mt-0.5 text-[12.5px] leading-5 text-muted">
            {props.description}
          </p>
        )}
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
        <div
          className={cn(
            "text-[13.5px] font-medium",
            props.danger ? "text-danger" : "text-ink",
          )}
        >
          {props.title}
        </div>
        <div className="mt-0.5 text-[12.5px] leading-5 text-muted">
          {props.description}
        </div>
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
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  const [accent, setAccentState] = useState<AccentColor>(getAccent);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [desktopNotify, setDesktopNotify] = useState(getDesktopNotifications);
  const notifySupported = desktopNotificationsSupported();

  async function toggleDesktopNotify() {
    const next = await setDesktopNotifications(!desktopNotify);
    setDesktopNotify(next);
    if (!desktopNotify && !next) {
      toast.error("Notifications are blocked for this site. Allow them in your browser settings, then try again.", {
        id: "desktop-notify-blocked",
      });
    }
  }

  return (
    <div className="space-y-7">
      <Section
        title="Theme"
        description="Light, dark or follow your computer, plus an accent color."
      >
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="radiogroup"
            aria-label="Mode"
            className="inline-flex rounded-full border border-line bg-surface p-0.5"
          >
            {THEMES.map((option) => {
              const Icon = option.icon;
              const active = theme === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setTheme(option.id);
                    setThemePreference(option.id);
                  }}
                  title={option.hint}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition",
                    active
                      ? "bg-card text-ink shadow-sm"
                      : "text-muted hover:text-ink",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {option.label}
                </button>
              );
            })}
          </div>
          <span aria-hidden className="h-6 w-px bg-line" />
          <div
            role="radiogroup"
            aria-label="Accent color"
            className="flex items-center gap-1.5"
          >
            {ACCENTS.map((id) => {
              const swatch = ACCENT_SWATCH[id];
              const active = accent === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={swatch.label}
                  onClick={() => {
                    setAccentState(id);
                    setAccent(id);
                  }}
                  className={cn(
                    "group relative flex h-8 w-8 items-center justify-center rounded-full border-2 transition",
                    active
                      ? "border-ink/40"
                      : "border-transparent hover:border-line",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full",
                      // Plain = no color, so its swatch is the text color (black in light, light grey in dark).
                      id === "plain" && "bg-ink",
                    )}
                    style={id === "plain" ? undefined : { background: swatch.color }}
                  >
                    {active && (
                      <Check className={cn("h-3.5 w-3.5", id === "plain" ? "text-canvas" : "text-white")} />
                    )}
                  </span>
                  {/* Instant label on hover / keyboard focus (the native title tooltip is slow). */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-invert px-2 py-0.5 text-[11.5px] font-medium text-invert-ink opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  >
                    {swatch.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <Section
        title="Notifications"
        description="When a chat you're not viewing finishes, you'll see a pop-up in the app."
      >
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-ink">Desktop notifications</div>
            <div className="mt-0.5 text-[12.5px] leading-5 text-muted">
              {notifySupported
                ? "Also notify you when AurigaSQL is in the background."
                : "This browser doesn't support desktop notifications."}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={desktopNotify}
            aria-label="Desktop notifications"
            disabled={!notifySupported}
            onClick={() => void toggleDesktopNotify()}
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition disabled:opacity-40",
              desktopNotify ? "bg-accent" : "bg-line",
            )}
          >
            <span
              className={cn(
                "inline-block h-5 w-5 rounded-full shadow-sm transition-transform",
                desktopNotify ? "translate-x-[18px] bg-accent-ink" : "translate-x-0.5 bg-white",
              )}
            />
          </button>
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
          placeholder={
            'e.g. Our fiscal year starts in April.\n"Revenue" means amount minus refunds.'
          }
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
    <Section
      title="Chats"
      description="Back up, restore or clear your chat history."
    >
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
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent hover:underline"
        >
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
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 px-4 py-3 text-[13.5px]"
          >
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
  /** Open the Models tab on the "Add a model" form. */
  addModel?: boolean;
  onClose: () => void;
  onModelsChanged: (preferredModelId?: string) => Promise<void> | void;
  onDataSourcesChanged?: (source?: DataSource) => Promise<void> | void;
  onSelectDataSourceAndClose?: (source: DataSource) => void;
  onOpenDataSourceInCanvas?: (source: DataSource) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? "general");
  // Applies only to the first Models view after opening; switching tabs and back shows the list.
  const [addModel, setAddModel] = useState(Boolean(props.addModel));
  // Sub-page header from embedded tabs (e.g. "Add a model" or "Connections · Demo Postgres" with a back arrow).
  const [subHeader, setSubHeader] = useState<EmbeddedHeader | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setTab(props.initialTab ?? "general");
    setAddModel(Boolean(props.addModel));
  }, [props.open, props.initialTab, props.addModel]);

  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const isConnectionsTab = tab === "connections";
  const hasEmbeddedHeader = tab === "models" || tab === "connections";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-[24px] border border-line bg-card shadow-[0_32px_100px_rgba(11,18,14,0.18)] transition-[max-width,height] duration-200 md:flex-row",
          isConnectionsTab
            ? "h-[min(780px,92vh)] max-w-[1040px]"
            : "h-[min(600px,90vh)] max-w-[760px]",
        )}
      >
        <nav
          role="tablist"
          aria-label="Settings sections"
          className="flex w-full shrink-0 flex-row flex-wrap items-center gap-1 border-b border-line/70 bg-surface/60 px-3 py-3 md:w-[184px] md:flex-col md:items-stretch md:gap-0.5 md:border-b-0 md:border-r md:py-5"
        >
          <h2
            id="settings-dialog-title"
            className="mr-2 px-2.5 text-[18px] font-semibold tracking-[-0.01em] text-ink md:mb-3 md:mr-0"
          >
            Settings
          </h2>
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                id={`settings-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`settings-panel-${item.id}`}
                onClick={() => {
                  if (item.id !== tab) setSubHeader(null);
                  setTab(item.id);
                  setAddModel(false);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13.5px] font-medium transition md:gap-2.5",
                  active
                    ? "bg-card text-ink shadow-sm ring-1 ring-line/70"
                    : "text-muted hover:bg-hover hover:text-ink",
                )}
              >
                <Icon className={cn("h-4 w-4", active && "text-accent")} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header row keeps the close button out of the content area, so no tab's content can sit under it. */}
          <header className="flex shrink-0 items-center gap-3 border-b border-line/50 pb-3 pl-6 pr-4 pt-4">
            {hasEmbeddedHeader && subHeader?.onBack && (
              <button
                type="button"
                onClick={subHeader.onBack}
                disabled={subHeader.backDisabled}
                title={tab === "connections" ? "Back to new connection" : "Back to models"}
                aria-label={tab === "connections" ? "Back to new connection" : "Back to models"}
                className="-ml-2 -mr-1 flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-hover hover:text-ink disabled:opacity-45"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <h2 className="flex-1 truncate text-[15px] font-semibold text-ink">
              {(hasEmbeddedHeader && subHeader?.title) ||
                TABS.find((item) => item.id === tab)?.label}
            </h2>
            <button
              type="button"
              onClick={props.onClose}
              title="Close"
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          {tab === "models" ? (
            <div
              id="settings-panel-models"
              role="tabpanel"
              aria-labelledby="settings-tab-models"
              className="flex min-h-0 flex-1 flex-col"
            >
              <LlmConfigModal
                embedded
                open
                startInAdd={addModel}
                onHeaderChange={setSubHeader}
                onClose={props.onClose}
                onModelsChanged={props.onModelsChanged}
              />
            </div>
          ) : tab === "connections" ? (
            <div
              id="settings-panel-connections"
              role="tabpanel"
              aria-labelledby="settings-tab-connections"
              className="flex min-h-0 flex-1 flex-col"
            >
              <DataConnectionModal
                embedded
                open
                onHeaderChange={setSubHeader}
                onClose={props.onClose}
                onChanged={props.onDataSourcesChanged ?? (() => {})}
                onSelectAndClose={props.onSelectDataSourceAndClose}
                onOpenInCanvas={props.onOpenDataSourceInCanvas}
              />
            </div>
          ) : (
            <div
              id={`settings-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`settings-tab-${tab}`}
              className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4"
            >
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
