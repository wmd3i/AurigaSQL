import { useMemo, useState } from "react";
import { Database, PanelLeft, PanelLeftClose, Settings2, SquarePen, Trash2 } from "lucide-react";
import type { DataSource } from "../../api/bff";
import type { Conversation } from "../../state/types";
import { DialectIcon } from "./DialectIcon";
import { useResizable } from "../../lib/useResizable";
import { ResizeHandle } from "../ResizeHandle";
import { cn } from "../../lib/cn";
import { inferDataEngine } from "../../lib/databaseEngine";

const SIDEBAR_BG = "app-shell-bg";
type SidebarSection = "chat" | "workspace";
type RecentItem = {
  key: string;
  primary: Conversation;
  conversations: Conversation[];
  latestAt: number;
};

function canvasWorkKey(conversationsById: Map<string, Conversation>, conv: Conversation) {
  if (conv.canvasWorkId) return conv.canvasWorkId;
  let current: Conversation | undefined = conv;
  const seen = new Set<string>();
  while (current?.parentThreadId && !seen.has(current.id)) {
    seen.add(current.id);
    current = conversationsById.get(current.parentThreadId);
  }
  return current?.id ?? conv.id;
}

function buildRecentItems(conversations: Conversation[]): RecentItem[] {
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const workspaceGroups = new Map<string, Conversation[]>();
  const items: RecentItem[] = [];

  conversations.forEach((conversation) => {
    if (conversation.mode !== "workspace") {
      items.push({
        key: conversation.id,
        primary: conversation,
        conversations: [conversation],
        latestAt: conversation.createdAt,
      });
      return;
    }
    const key = canvasWorkKey(conversationsById, conversation);
    workspaceGroups.set(key, [...(workspaceGroups.get(key) ?? []), conversation]);
  });

  workspaceGroups.forEach((group, key) => {
    const oldestFirst = [...group].sort((a, b) => a.createdAt - b.createdAt);
    const primary = oldestFirst.find((conversation) => !conversation.parentThreadId) ?? oldestFirst[0];
    items.push({
      key,
      primary,
      conversations: group,
      latestAt: Math.max(...group.map((conversation) => conversation.createdAt)),
    });
  });

  return items.sort((a, b) => b.latestAt - a.latestAt);
}

export function HomeSidebar(props: {
  conversations: Conversation[];
  onNewFlow: () => void;
  onOpen: (id: string) => void;
  onOpenWorkspaceSetup: () => void;
  onDeleteConversation?: (id: string) => void;
  activeSection?: SidebarSection;
  activeConversationId?: string | null;
  dataSources?: DataSource[];
  databases?: string[];
  selectedDataSourceId?: string | null;
  onSelectDataSource?: (source: DataSource) => void;
  onOpenLlmConfig?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { width, dragging, onPointerDown } = useResizable({
    initial: 288,
    min: 220,
    max: 480,
    edge: "right",
  });
  const readySources = (props.dataSources ?? []).filter((source) => source.ready);
  const activeConversation = props.conversations.find((conversation) => conversation.id === props.activeConversationId) ?? null;
  const recentItems = useMemo(() => buildRecentItems(props.conversations), [props.conversations]);
  const knownDatabases =
    readySources.length > 0
      ? Array.from(new Set(props.databases ?? [])).filter(Boolean)
      : [];
  const sourceDatabaseLabels = new Set(
    readySources.flatMap((source) => [source.display_name, source.database ?? ""]).filter(Boolean),
  );
  const chipItems = [
    ...readySources.map((source) => ({ kind: "source" as const, key: source.id, label: source.display_name, source })),
    ...knownDatabases
      .filter((database) => !sourceDatabaseLabels.has(database))
      .map((database) => ({ kind: "recent" as const, key: database, label: database })),
  ];

  if (collapsed) {
    return (
      <aside
        className={`flex w-14 shrink-0 flex-col items-center gap-3 border-r border-line/80 ${SIDEBAR_BG} px-2 py-4`}
      >
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelLeft className="h-5 w-5" />
        </button>
        <button
          onClick={props.onNewFlow}
          title="New chat"
          aria-label="New chat"
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
            props.activeSection === "chat"
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-hover hover:text-ink",
          )}
        >
          <SquarePen className="h-4 w-4" />
        </button>
        <button
          onClick={props.onOpenWorkspaceSetup}
          title="Connect db"
          aria-label="Connect db"
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
            props.activeSection === "workspace"
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-hover hover:text-ink",
          )}
        >
          <Database className="h-4 w-4" />
        </button>
        <button
          onClick={props.onOpenLlmConfig}
          title="Settings"
          aria-label="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      style={{ width }}
      className={`relative flex shrink-0 flex-col border-r border-line/80 ${SIDEBAR_BG} px-4 py-4`}
    >
      {/* Brand + collapse */}
      <div className="mb-4 flex items-center justify-between px-2">
        <button
          onClick={props.onNewFlow}
          title="Start a new conversation"
          className="rounded-md text-[24px] font-semibold tracking-tight transition-opacity hover:opacity-75"
        >
          <span className="text-accent">Auriga</span>
          <span className="font-semibold text-ink">SQL</span>
        </button>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <PanelLeftClose className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="mb-5 space-y-2">
        <button
          onClick={props.onNewFlow}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl px-3 py-3 text-[15px] transition-colors",
            props.activeSection === "chat"
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-hover hover:text-ink",
          )}
        >
          <SquarePen className="h-[17px] w-[17px]" />
          New chat
        </button>
        <button
          onClick={props.onOpenWorkspaceSetup}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-[14px] transition-colors",
            props.activeSection === "workspace"
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-hover hover:text-ink",
          )}
        >
          <Database className="h-[16px] w-[16px]" />
          Connect data
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-2 px-2 text-[16px] font-semibold text-muted">Recents</div>
        {recentItems.length === 0 && (
          <p className="px-2 text-[12px] text-faint">No conversations yet.</p>
        )}
        {recentItems.map((item) => {
          const c = item.primary;
          const selected = item.conversations.some((conversation) => conversation.id === props.activeConversationId);
          return (
            <div
              key={item.key}
              className={cn(
                "group flex items-start gap-2 rounded-xl px-3 py-2.5 transition-colors",
                selected ? "bg-accent-soft" : "hover:bg-hover",
              )}
            >
              <button
                onClick={() => props.onOpen(c.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className={cn("block w-full truncate text-[14.5px]", selected ? "text-accent" : "text-ink")}>
                  {c.summary ?? c.title}
                </span>
                <div className={cn("mt-1 flex items-center gap-1.5 text-[12px]", selected ? "text-accent/75" : "text-faint")}>
                  <DialectIcon dialect={c.source?.engine ?? inferDataEngine(c.database)} className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {c.database}
                    {c.databases.length > 1 ? ` +${c.databases.length - 1}` : ""}
                  </span>
                </div>
              </button>
              {props.onDeleteConversation && (
                <button
                  type="button"
                  aria-label="Delete conversation"
                  title="Delete conversation"
                  onClick={(event) => {
                    event.stopPropagation();
                    item.conversations.forEach((conversation) => props.onDeleteConversation?.(conversation.id));
                  }}
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-faint opacity-0 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {chipItems.length > 0 && (
        <section className="mt-3 border-t border-line/60 px-2 pt-3">
          <div className="mb-2 px-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">Databases</div>
          <div className={cn("flex max-h-44 flex-wrap gap-1 overflow-y-auto pr-1", chipItems.length > 8 && "pb-1")}>
            {chipItems.map((item) => {
              const selected =
                item.kind === "source"
                  ? props.selectedDataSourceId === item.source.id || activeConversation?.source?.id === item.source.id
                  : activeConversation?.database === item.label || activeConversation?.databases.includes(item.label);
              const dialect = item.kind === "source" ? item.source.engine : inferDataEngine(item.label);
              const title =
                item.kind === "source"
                  ? item.source.db_path ?? item.source.database ?? item.source.display_name
                  : "From recent conversations";
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    if (item.kind === "source") {
                      props.onSelectDataSource?.(item.source);
                      return;
                    }
                    const conversation = props.conversations.find((candidate) =>
                      candidate.database === item.label || candidate.databases.includes(item.label),
                    );
                    if (conversation) props.onOpen(conversation.id);
                  }}
                  title={title}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                    selected
                      ? "border-accent bg-accent-soft text-accent shadow-[0_6px_18px_rgba(19,130,117,0.12)]"
                      : "border-line/80 bg-card/80 text-muted hover:border-accent/35 hover:bg-hover hover:text-ink",
                  )}
                >
                  <DialectIcon dialect={dialect} className="h-2.5 w-2.5 shrink-0 opacity-90" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="mt-3 border-t border-line px-2 pt-2">
        <button
          type="button"
          onClick={props.onOpenLlmConfig}
          className="flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left transition hover:bg-hover"
        >
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Settings2 className="h-3.5 w-3.5" />
          </div>
          <span className="flex-1 text-[14px] text-ink">Settings</span>
        </button>
      </div>

      <ResizeHandle edge="right" dragging={dragging} onPointerDown={onPointerDown} />
    </aside>
  );
}
