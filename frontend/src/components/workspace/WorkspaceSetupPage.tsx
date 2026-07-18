import { ArrowLeft, Database } from "lucide-react";
import type { Conversation } from "../../state/types";
import { DatabaseConnectionPanel } from "../home/DatabaseConnectionPanel";
import { HomeSidebar } from "../home/HomeSidebar";

export function WorkspaceSetupPage(props: {
  conversations: Conversation[];
  onNewFlow: () => void;
  onBack: () => void;
  onOpen: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onOpenLlmConfig: () => void;
}) {
  return (
    <div className="app-shell-bg flex h-screen w-screen overflow-hidden text-ink">
      <HomeSidebar
        conversations={props.conversations}
        activeSection="workspace"
        onNewFlow={props.onNewFlow}
        onOpenWorkspaceSetup={() => {}}
        onOpen={props.onOpen}
        onDeleteConversation={props.onDeleteConversation}
        onOpenLlmConfig={props.onOpenLlmConfig}
      />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6 sm:px-8 lg:px-12">
        <button
          type="button"
          onClick={props.onBack}
          className="absolute left-3 top-6 inline-flex items-center gap-2 rounded-full border border-line bg-card/90 px-3 py-2 text-[13px] font-semibold text-muted shadow-sm transition hover:bg-hover hover:text-ink sm:left-4 lg:left-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6 pt-4 sm:pt-6">
          <header>
            <div>
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Database className="h-5 w-5" />
              </div>
              <h1 className="text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-4xl">Data Connections</h1>
              <p className="mt-2 text-[15px] text-muted">Connect a database</p>
            </div>
          </header>

          <DatabaseConnectionPanel onCreated={() => {}} />
        </div>
      </main>
    </div>
  );
}
