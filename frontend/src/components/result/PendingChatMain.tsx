import { CheckCircle2, Pause } from "lucide-react";
import type { QueryMode } from "../../state/types";
import { FlowModeSwitch } from "../FlowModeSwitch";
import { QuestionBubble, RunningState } from "./AgentResultPage";

// Reserve the same space as the open Steps rail in the chat.
const STEPS_RAIL_SPACE = "hidden w-[356px] shrink-0 xl:block";

export function PendingChatMain(props: {
  title: string;
  database?: string;
  onStop: () => void;
  onModeChange: (mode: QueryMode) => void;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 border-b border-line/80 bg-transparent px-6 py-2.5">
        <div className="mx-auto flex w-full max-w-[1480px] items-center">
          <FlowModeSwitch mode="agent" onModeChange={props.onModeChange} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-5">
        <div className="mx-auto flex w-full max-w-[1480px] items-start gap-10 xl:gap-14">
          <div className="min-w-0 flex-1 xl:pr-6">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
              <QuestionBubble text={props.title} />
              <div className="flex flex-col gap-5" role="status">
                {props.database ? (
                  <>
                    <p className="flex items-center gap-1.5 text-[13px] text-muted">
                      <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-accent" />
                      Using <span className="font-medium text-ink">{props.database}</span>
                    </p>
                    <RunningState currentStep="Starting" />
                  </>
                ) : (
                  <RunningState
                    title="Choosing a database"
                    currentStep="Matching your question to your connected data"
                  />
                )}
              </div>
            </div>
          </div>
          <div aria-hidden="true" className={STEPS_RAIL_SPACE} />
        </div>
      </div>

      <div className="shrink-0 bg-transparent px-6 pb-2 pt-3">
        <div className="mx-auto flex w-full max-w-[1480px] gap-10 xl:gap-14">
          <div className="min-w-0 flex-1 xl:pr-6">
            <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-[23px] border border-line bg-card px-3.5 py-2 shadow-sm">
              <textarea
                rows={1}
                disabled
                placeholder="AurigaSQL is working…"
                className="max-h-36 min-h-[23px] w-full resize-none border-0 bg-transparent px-1 py-0 text-[15px] leading-[23px] text-ink placeholder:text-faint focus:outline-none"
              />
              <button
                type="button"
                aria-label="Pause"
                title="Pause AurigaSQL"
                onClick={props.onStop}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pause text-invert-ink hover:opacity-90"
              >
                <Pause className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-1.5 text-center text-[11px] text-faint">
              AurigaSQL can make mistakes. Check important results.
            </p>
          </div>
          <div aria-hidden="true" className={STEPS_RAIL_SPACE} />
        </div>
      </div>
    </main>
  );
}
