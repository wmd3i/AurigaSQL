import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  MessageCircleQuestion,
  PanelRight,
  PanelRightClose,
  Pause,
  RotateCcw,
  Sparkles,
  SlidersHorizontal,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";
import { bff, type DataSource } from "../../api/bff";
import { cn } from "../../lib/cn";
import type { Conversation } from "../../state/types";
import { buildNodes, type ThreadNode } from "../../lib/buildNodes";
import { extractAgentResult } from "../../lib/extractAgentResult";
import { buildRounds, type RoundClarification } from "../../lib/buildRounds";
import { splitQuestions } from "../../lib/splitQuestions";
import { DialectIcon } from "../home/DialectIcon";
import { HomeSidebar } from "../home/HomeSidebar";
import { ResizeHandle } from "../ResizeHandle";
import { useResizable } from "../../lib/useResizable";
import { ResultArtifact } from "./ResultArtifact";
import { ProcessTimeline, buildCheckpointGroups, buildCheckpoints, type CheckpointGroup } from "./ProcessTimeline";
import { RichText } from "./RichText";
import { AIInsightCard, AIInsightPrefetcher } from "./AIInsightCard";
import { VisualizationCard } from "./VisualizationCard";

type Clarification = { q: string; a: string | null };

function isSqlExecutionNode(node: ThreadNode): boolean {
  return node.kind === "tool" && (node.title === "execute_sql" || node.title === "run_postgres_readonly");
}

function revertNodeIdsByRound(conversation: Conversation): Record<number, string> {
  const nodes = buildNodes(conversation.timeline, conversation.title);
  const out: Record<number, string> = {};
  let roundIndex = -1;
  let bucket: ThreadNode[] = [];

  const flush = () => {
    if (roundIndex < 0) return;
    const answer = [...bucket].reverse().find((node) => node.kind === "answer");
    const executed = [...bucket].reverse().find((node) => isSqlExecutionNode(node) && node.result !== undefined);
    const fallback = [...bucket].reverse().find((node) => node.kind !== "question");
    const target = answer ?? executed ?? fallback;
    if (target) out[roundIndex] = target.id;
  };

  nodes.forEach((node) => {
    if (node.kind === "question") {
      flush();
      roundIndex += 1;
      bucket = [];
    } else {
      bucket.push(node);
    }
  });
  flush();

  return out;
}

function IconHint({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="group relative">
      {children}
      <div className="pointer-events-none absolute right-0 top-[calc(100%+8px)] z-30 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <div className="whitespace-nowrap rounded-xl border border-line bg-card px-3 py-1.5 text-[12px] text-ink shadow-sm">
          {label}
        </div>
      </div>
    </div>
  );
}

/** The open clarification. If the agent asked several questions in one turn,
 *  they become tabs — answer any subset, then submit the combined reply. */
function OpenClarification({ question, onAnswer }: { question: string; onAnswer: (text: string) => void }) {
  const subs = useMemo(() => splitQuestions(question), [question]);
  const single = subs.length <= 1;
  const [active, setActive] = useState(0);
  const [answers, setAnswers] = useState<string[]>(() => subs.map(() => ""));

  const setActiveAnswer = (v: string) =>
    setAnswers((prev) => prev.map((a, i) => (i === active ? v : a)));

  const submit = () => {
    if (single) {
      const a = answers[0]?.trim();
      if (a) onAnswer(a);
      return;
    }
    // Require every clarification answered — submitting partial replies would
    // silently drop the unanswered ones and let the agent run on assumptions.
    const firstEmpty = subs.findIndex((_, i) => !(answers[i] ?? "").trim());
    if (firstEmpty !== -1) {
      setActive(firstEmpty); // jump to the first one still missing an answer
      return;
    }
    const parts = subs.map((q, i) => ({ q, a: (answers[i] ?? "").trim() }));
    // label each so the agent knows which question each answer belongs to
    onAnswer(parts.map((p) => `${p.q}\n→ ${p.a}`).join("\n\n"));
  };

  if (single) {
    return (
      <>
        <RichText text={subs[0] ?? question} className="text-[14px] leading-relaxed text-ink" />
        <div className="mt-3 flex items-end gap-2 rounded-xl border border-line bg-card p-2">
          <textarea
            rows={1}
            value={answers[0] ?? ""}
            onChange={(e) => setActiveAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Type your answer…"
            className="min-h-[24px] w-full resize-none border-0 bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
          />
          <button
            aria-label="Send answer"
            onClick={submit}
            disabled={!(answers[0] ?? "").trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-invert text-invert-ink hover:opacity-90 disabled:cursor-not-allowed disabled:bg-hover disabled:text-faint disabled:opacity-100 disabled:hover:opacity-100"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </>
    );
  }

  const answeredCount = answers.filter((a) => a.trim()).length;

  return (
    <div>
      {/* question tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-line pb-2.5">
        {subs.map((_, i) => {
          const filled = (answers[i] ?? "").trim() !== "";
          return (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={cn(
                "flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                active === i ? "bg-accent text-invert-ink" : "bg-card text-muted hover:bg-hover",
              )}
            >
              Clarification {i + 1}
              {filled && <Check className={cn("h-3 w-3", active === i ? "text-invert-ink" : "text-accent")} />}
            </button>
          );
        })}
      </div>

      {/* active question + its answer */}
      <div className="mt-3">
        <RichText text={subs[active]} className="text-[14px] leading-relaxed text-ink" />
        <textarea
          rows={2}
          value={answers[active] ?? ""}
          onChange={(e) => setActiveAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={`Answer clarification ${active + 1}…`}
          className="mt-3 w-full resize-none rounded-xl border border-line bg-card p-3 text-[14px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12px] text-faint">
          Answer all to continue — {answeredCount}/{subs.length} answered
        </span>
        <button
          onClick={submit}
          disabled={answeredCount < subs.length}
          className="inline-flex items-center gap-1.5 rounded-full bg-invert px-4 py-2 text-[13px] font-medium text-invert-ink hover:opacity-90 disabled:opacity-40"
        >
          <ArrowUp className="h-4 w-4" />
          Submit
        </button>
      </div>
    </div>
  );
}

/** Each clarification round is its own entry: answered ones are read-only, the
 *  open one expands into tabs when it bundles multiple questions. */
function ClarificationThread({
  items,
  onAnswer,
}: {
  items: Clarification[];
  onAnswer: (text: string) => void;
}) {
  return (
    <section className="rounded-2xl border border-accent/40 bg-accent-soft/40 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold text-accent">
        <Sparkles className="h-4 w-4" />
        AurigaSQL needs a bit more detail
      </div>
      <div className="flex flex-col gap-3">
        {items.map((it, i) =>
          it.a !== null ? (
            <div key={i} className="rounded-xl border border-line bg-card p-3.5 shadow-sm">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
                <MessageCircleQuestion className="h-3.5 w-3.5" />
                Answered
              </div>
              <RichText text={it.q} className="text-[14px] leading-relaxed text-ink" />
              <div className="mt-3 flex gap-2 rounded-lg bg-surface px-3 py-2 text-[13px]">
                <span className="shrink-0 font-medium text-accent">You</span>
                <span className="whitespace-pre-wrap text-ink">{it.a}</span>
              </div>
            </div>
          ) : (
            <div key={i} className="rounded-xl border border-line bg-card p-3.5 shadow-sm">
              <OpenClarification question={it.q} onAnswer={onAnswer} />
            </div>
          ),
        )}
      </div>
    </section>
  );
}

/** A user turn, rendered as a right-aligned chat bubble. The database context
 *  rides along the first question only. */
function QuestionBubble({ text, database }: { text: string; database?: string }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md border border-accent/20 bg-accent-soft px-4 py-2.5 text-[15px] font-medium leading-relaxed text-ink">
        {text}
      </div>
    </div>
  );
}

function RunningState({ currentStep }: { currentStep: string | null }) {
  return (
    <section className="flex items-center gap-3.5 rounded-2xl border border-line bg-card px-5 py-4 shadow-sm">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/20" />
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Sparkles className="h-4 w-4" />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="shimmer-text text-[14px] font-semibold">Working on your answer</p>
        <p className="mt-0.5 truncate text-[13px] text-muted">
          {currentStep ? currentStep : "Exploring the database"}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-accent"
            style={{ animation: "dot-bounce 1.4s ease-in-out infinite", animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
    </section>
  );
}

export function AgentResultPage(props: {
  conversation: Conversation;
  conversations: Conversation[];
  onShowProcess: () => void;
  onNewFlow: () => void;
  onOpen: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onRevertConversation?: (id: string, nodeId: string) => void;
  onAnswer: (id: string, text: string) => void;
  onFollowUp: (database: string, query: string) => Promise<void>;
  onStop: (id: string) => void;
  onOpenWorkspaceSetup: () => void;
  onOpenLlmConfig?: () => void;
  dataSources?: DataSource[];
}) {
  const conv = props.conversation;
  const result = extractAgentResult(conv);
  // Transcript of every Q&A round so follow-ups append instead of overwriting.
  const rounds = useMemo(() => buildRounds(conv), [conv]);
  const revertNodes = useMemo(() => revertNodeIdsByRound(conv), [conv]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followUpInputRef = useRef<HTMLTextAreaElement>(null);

  const isRunning = conv.status === "starting" || conv.status === "active";
  const isWaiting = conv.status === "waiting_user" && !!conv.pendingQuestion;
  // Final products surface once the turn settles. "stopped" is terminal too —
  // show whatever partial products the agent produced before being aborted.
  const isDone = conv.status === "done" || conv.status === "stopped";

  const [followUp, setFollowUp] = useState("");
  const [sending, setSending] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [toolsCardOpen, setToolsCardOpen] = useState(true);
  const [openInsightRounds, setOpenInsightRounds] = useState<Record<number, boolean>>({});
  const [visualizationInlineOpen, setVisualizationInlineOpen] = useState(false);
  const [visualizationCardOpen, setVisualizationCardOpen] = useState(false);
  const [selectedVisualizationRoundIndex, setSelectedVisualizationRoundIndex] = useState<number | null>(null);
  const [rightSidebarTab, setRightSidebarTab] = useState<"visualization" | "trace">("trace");
  const [openTraceTabs, setOpenTraceTabs] = useState<string[]>([]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const processPanel = useResizable({ initial: 420, min: 320, max: 720, edge: "left" });
  const checkpoints = useMemo(() => buildCheckpoints(conv), [conv]);
  const checkpointGroups = useMemo(() => buildCheckpointGroups(conv), [conv]);
  const [openStepGroups, setOpenStepGroups] = useState<Record<string, boolean>>({});
  // The just-sent follow-up, shown optimistically until the SSE echo turns it
  // into a real round (avoids a "did my message send?" gap).
  const [pendingFollowUp, setPendingFollowUp] = useState<string | null>(null);
  const [fallbackSidebarSources, setFallbackSidebarSources] = useState<DataSource[]>([]);
  const showOptimistic =
    pendingFollowUp !== null && rounds[rounds.length - 1]?.question !== pendingFollowUp;
  // The agent is occupied (or a send is mid-flight): composer shows Stop, not send.
  const busy = isRunning || sending || showOptimistic;
  const latestRound = rounds[rounds.length - 1] ?? null;
  const currentQuestionText = showOptimistic && pendingFollowUp ? pendingFollowUp : latestRound?.question ?? conv.title;
  const latestCheckpointGroup = checkpointGroups[checkpointGroups.length - 1] ?? null;
  const needsCurrentStepPlaceholder =
    (showOptimistic || isRunning) &&
    currentQuestionText.trim() !== "" &&
    latestCheckpointGroup?.question !== currentQuestionText;
  const visibleCheckpointGroups = useMemo<CheckpointGroup[]>(
    () =>
      needsCurrentStepPlaceholder
        ? [
            ...checkpointGroups,
            {
              id: showOptimistic ? "pending-follow-up" : "current-working-question",
              question: currentQuestionText,
              checkpoints: [],
            },
          ]
        : checkpointGroups,
    [checkpointGroups, currentQuestionText, needsCurrentStepPlaceholder, showOptimistic],
  );

  const processWorking = isRunning && !conv.pendingQuestion;
  // Canvas-mode compaction can fold away standalone reasoning nodes, but the
  // result page should still expose the details rail whenever there are trace
  // checkpoints such as SQL/result output.
  const hasProcess = visibleCheckpointGroups.length > 0 || processWorking;

  useEffect(() => {
    if (selectedToolId && checkpoints.some((cp) => cp.nodeId === selectedToolId)) return;
    setSelectedToolId(checkpoints.at(-1)?.nodeId ?? null);
  }, [checkpoints, selectedToolId]);

  useEffect(() => {
    const node = followUpInputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 144)}px`;
  }, [followUp]);

  useEffect(() => {
    setToolsCardOpen(true);
    setOpenInsightRounds({});
    setVisualizationInlineOpen(false);
    setVisualizationCardOpen(false);
    setSelectedVisualizationRoundIndex(null);
    setRightSidebarTab("trace");
    setOpenTraceTabs([]);
    setSelectedToolId(null);
    setOpenStepGroups({});
    setProcessOpen(false);
  }, [conv.id]);

  useEffect(() => {
    let cancelled = false;
    bff.demoDataSources()
      .then((response) => {
        if (cancelled) return;
        const sources = [...response.sources];
        if (conv.source && !sources.some((source) => source.id === conv.source?.id)) {
          sources.unshift(conv.source);
        }
        setFallbackSidebarSources(sources);
      })
      .catch(() => {
        if (!cancelled && conv.source) setFallbackSidebarSources([conv.source]);
      });
    return () => {
      cancelled = true;
    };
  }, [conv.id, conv.source]);

  useEffect(() => {
    const latestGroupId = visibleCheckpointGroups.at(-1)?.id;
    if (!latestGroupId) return;
    setOpenStepGroups((prev) => {
      if (prev[latestGroupId]) return prev;
      return { [latestGroupId]: true };
    });
  }, [visibleCheckpointGroups]);

  useEffect(() => {
    if (!processOpen) return;
    setToolsCardOpen(true);
  }, [processOpen]);

  useEffect(() => {
    if (rightSidebarTab !== "visualization") return;
    if (visualizationCardOpen) return;
    if (selectedToolId) {
      setRightSidebarTab("trace");
      return;
    }
    if (!processOpen) {
      setRightSidebarTab("trace");
    }
  }, [rightSidebarTab, visualizationCardOpen, selectedToolId, processOpen]);

  // Drop the optimistic placeholder only once its real round lands. If the SSE
  // user-message echo is delayed or lost, keeping the placeholder is less
  // confusing than moving the in-flight turn back onto the previous answer.
  useEffect(() => {
    if (pendingFollowUp === null) return;
    const landed = rounds[rounds.length - 1]?.question === pendingFollowUp;
    if (landed) setPendingFollowUp(null);
  }, [rounds, pendingFollowUp]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [conv.timeline.length, conv.status, showOptimistic]);

  async function submitFollowUp() {
    const text = followUp.trim();
    if (!text || sending) return;
    setSending(true);
    setPendingFollowUp(text);
    setFollowUp("");
    try {
      await props.onFollowUp(conv.database, text);
    } catch {
      setPendingFollowUp(null);
    } finally {
      setSending(false);
    }
  }

  function handleStop() {
    setSending(false);
    setPendingFollowUp(null);
    props.onStop(conv.id);
  }

  function openTraceForStep(stepId: string) {
    setOpenTraceTabs([stepId]);
    setSelectedToolId(stepId);
    setRightSidebarTab("trace");
    setProcessOpen(true);
  }

  function toggleInsightRound(roundIndex: number) {
    setOpenInsightRounds((prev) => ({ ...prev, [roundIndex]: !prev[roundIndex] }));
  }

  function showVisualizationForRound(roundIndex: number) {
    setSelectedVisualizationRoundIndex(roundIndex);
    setVisualizationInlineOpen(true);
    setVisualizationCardOpen(false);
  }

  function toggleStepGroup(groupId: string) {
    setOpenStepGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }

  function openVisualizationRail(roundIndex?: number) {
    if (roundIndex !== undefined) {
      setSelectedVisualizationRoundIndex(roundIndex);
    }
    setVisualizationInlineOpen(false);
    setVisualizationCardOpen(true);
    setRightSidebarTab("visualization");
    setProcessOpen(true);
  }

  function closeVisualizationRail() {
    setVisualizationCardOpen(false);
    setVisualizationInlineOpen(true);
    if (openTraceTabs.length > 0) {
      setRightSidebarTab("trace");
      setProcessOpen(true);
    } else {
      setProcessOpen(false);
      setRightSidebarTab("trace");
    }
  }

  function closeTraceTab(stepId: string) {
    setOpenTraceTabs([]);
    if (selectedToolId === stepId) setSelectedToolId(null);
    setProcessOpen(false);
  }

  function toggleProcessPanel() {
    if (!processOpen) {
      const stepId = selectedToolId ?? checkpoints.at(-1)?.nodeId;
      if (stepId) openTraceForStep(stepId);
      return;
    }
    setRightSidebarTab("trace");
    setProcessOpen(false);
  }

  const latestRoundQuestion = rounds[rounds.length - 1]?.question ?? conv.title;
  const currentQuestionWaitingForResult =
    showOptimistic || (isRunning && !!latestRound && latestRound.result === null);
  const latestVisualizableRound = currentQuestionWaitingForResult
    ? null
    : [...rounds].reverse().find((round) => !!round.result) ?? null;
  const selectedVisualizationRound =
    selectedVisualizationRoundIndex === null
      ? null
      : rounds.find((round) => round.index === selectedVisualizationRoundIndex && !!round.result) ?? null;
  const activeVisualizationRound = currentQuestionWaitingForResult
    ? null
    : selectedVisualizationRound ?? latestVisualizableRound;
  const showVisualizationCard = activeVisualizationRound !== null;
  const showStepsCard = visibleCheckpointGroups.length > 0 || processWorking;
  const selectedTraceCheckpoint = selectedToolId
    ? checkpoints.find((checkpoint) => checkpoint.nodeId === selectedToolId) ?? null
    : null;
  const traceOpenTabIds = selectedTraceCheckpoint ? [selectedTraceCheckpoint.nodeId] : openTraceTabs;
  const visualizationQuestion = activeVisualizationRound?.question ?? latestRoundQuestion;
  const visualizationSql = activeVisualizationRound?.sql ?? result.sql;
  const visualizationResult = activeVisualizationRound?.result ?? result.result;
  const rightRailWidth =
    toolsCardOpen || (showVisualizationCard && visualizationInlineOpen)
      ? "w-[356px]"
      : "w-[84px]";
  const headerRailWidth =
    toolsCardOpen || (showVisualizationCard && visualizationInlineOpen)
      ? "xl:w-[356px]"
      : "xl:w-[84px]";
  const sidebarSources = props.dataSources?.length ? props.dataSources : fallbackSidebarSources;

  return (
    <div className="app-shell-bg flex h-screen w-screen overflow-hidden text-ink">
      <HomeSidebar
        conversations={props.conversations}
        activeConversationId={conv.id}
        onNewFlow={props.onNewFlow}
        onOpenWorkspaceSetup={props.onOpenWorkspaceSetup}
        onOpen={props.onOpen}
        onDeleteConversation={props.onDeleteConversation}
        dataSources={sidebarSources}
        selectedDataSourceId={conv.source?.id ?? null}
        onOpenLlmConfig={props.onOpenLlmConfig}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {hasProcess && (
          <header className="flex shrink-0 border-b border-line/80 bg-transparent px-6 py-2.5">
            <div className="mx-auto flex w-full max-w-[1480px] items-center justify-end gap-10 xl:gap-14">
              <div className="hidden min-w-0 flex-1 xl:block xl:pr-6" />
              <div className={cn("flex w-auto shrink-0 justify-end gap-2", headerRailWidth)}>
                <IconHint label={toolsCardOpen ? "Hide steps" : "Show steps"}>
                  <button
                    onClick={() => setToolsCardOpen((v) => !v)}
                    aria-label={toolsCardOpen ? "Hide steps" : "Show steps"}
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-2xl text-muted transition-colors",
                      toolsCardOpen
                        ? "bg-accent-soft text-accent"
                        : "bg-transparent hover:border hover:border-line hover:bg-card hover:text-ink",
                    )}
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                  </button>
                </IconHint>
                <IconHint label={processOpen ? "Hide details" : "Show details"}>
                  <button
                    onClick={toggleProcessPanel}
                    aria-label={processOpen ? "Hide details" : "Show details"}
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-2xl text-muted transition-colors",
                      processOpen
                        ? "bg-accent-soft text-accent"
                        : "bg-transparent hover:border hover:border-line hover:bg-card hover:text-ink",
                    )}
                  >
                    {processOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
                  </button>
                </IconHint>
                <IconHint label="Canvas Mode">
                  <button
                    onClick={props.onShowProcess}
                    aria-label="Canvas Mode"
                    className="flex h-10 w-10 items-center justify-center rounded-2xl bg-transparent text-muted transition-colors hover:border hover:border-line hover:bg-card hover:text-ink"
                  >
                    <Workflow className="h-4 w-4" />
                  </button>
                </IconHint>
              </div>
            </div>
          </header>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-5">
          <div className="mx-auto flex w-full max-w-[1480px] items-start gap-10 xl:gap-14">
            <div className="min-w-0 flex-1 xl:pr-6">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                {/* Error — conversation level */}
                {conv.status === "error" && (
                  <section className="rounded-2xl border border-danger bg-danger-soft p-4">
                    <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-danger">
                      <TriangleAlert className="h-4 w-4" />
                      Something went wrong
                    </div>
                    <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-danger">
                      {conv.error}
                    </pre>
                  </section>
                )}

                {/* Transcript — each round keeps its own question + products */}
                {rounds.map((round, i) => {
                  const isLast = i === rounds.length - 1;
                  const showProducts = !isLast || isDone;
                  const roundHasOutput = round.answerText || round.result || round.sql;
                  const revertedToThisStep = isLast && conv.status === "stopped" && !roundHasOutput;
                  const roundVisualizationOpen =
                    visualizationInlineOpen && activeVisualizationRound?.index === round.index;

                  const clarItems: RoundClarification[] = [...round.clarifications];
                  if (isLast && conv.pendingQuestion && !clarItems.some((c) => c.a === null)) {
                    clarItems.push({ q: conv.pendingQuestion, a: null });
                  }

                  return (
                    <section
                      key={round.index}
                      className={cn(
                        "flex flex-col gap-3",
                        i > 0 && "border-t border-line/70 pt-5",
                      )}
                    >
                      <QuestionBubble
                        text={round.question}
                        database={i === 0 ? conv.database : undefined}
                      />

                      {isLast && isWaiting && clarItems.length > 0 && (
                        <ClarificationThread
                          items={clarItems}
                          onAnswer={(text) => props.onAnswer(conv.id, text)}
                        />
                      )}

                      {showProducts && (
                        <>
                          {/* {round.answerText && (
                            <section className="rounded-2xl border border-accent/30 bg-accent-soft/50 p-5 shadow-sm">
                              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-accent">
                                <Sparkles className="h-4 w-4" />
                                Answer
                              </div>
                              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
                                {round.answerText}
                              </p>
                            </section>
                          )} */}

                          <ResultArtifact result={round.result} sql={round.sql} question={round.question} />
                          {round.result && (
                            <AIInsightPrefetcher question={round.question} sql={round.sql} result={round.result} />
                          )}

                          {round.result && (
                            <>
                              <div className="mt-0 flex flex-col gap-3">
                                <div className="flex justify-end gap-1.5 pr-1">
                                  <IconHint label={roundVisualizationOpen ? "Hide visualization" : "Show visualization"}>
                                    <button
                                      onClick={() => {
                                        if (roundVisualizationOpen) {
                                          setVisualizationInlineOpen(false);
                                          setVisualizationCardOpen(false);
                                        } else {
                                          showVisualizationForRound(round.index);
                                        }
                                      }}
                                      aria-label={roundVisualizationOpen ? "Hide visualization" : "Show visualization"}
                                      className={cn(
                                        "flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors",
                                        roundVisualizationOpen
                                          ? "bg-accent-soft text-accent"
                                          : "hover:bg-hover hover:text-ink",
                                      )}
                                    >
                                      <BarChart3 className="h-4 w-4" />
                                    </button>
                                  </IconHint>
                                  <IconHint label={openInsightRounds[round.index] ? "Hide AI insight" : "Show AI insight"}>
                                    <button
                                      onClick={() => toggleInsightRound(round.index)}
                                      aria-label={openInsightRounds[round.index] ? "Hide AI insight" : "Show AI insight"}
                                      className={cn(
                                        "flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors",
                                        openInsightRounds[round.index]
                                          ? "bg-accent-soft text-accent"
                                          : "hover:bg-hover hover:text-ink",
                                      )}
                                    >
                                      <Sparkles className="h-4 w-4" />
                                    </button>
                                  </IconHint>
                                  {props.onRevertConversation && revertNodes[round.index] && (
                                    <IconHint label="Revert to previous step">
                                      <button
                                        onClick={() => props.onRevertConversation?.(conv.id, revertNodes[round.index])}
                                        aria-label="Revert to previous step"
                                        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"
                                      >
                                        <RotateCcw className="h-4 w-4" />
                                      </button>
                                    </IconHint>
                                  )}
                                </div>

                                {openInsightRounds[round.index] && (
                                  <AIInsightCard question={round.question} sql={round.sql} result={round.result} />
                                )}
                              </div>
                            </>
                          )}

                          {!roundHasOutput && (
                            <section className="rounded-2xl border border-dashed border-line bg-card p-6 text-center text-[13px] text-muted">
                              {revertedToThisStep
                                ? "Reverted to this step. You can revise the question or continue from here."
                                : "No result was produced. Open the details panel to see what happened."}
                            </section>
                          )}
                        </>
                      )}

                      {isLast && isRunning && !showOptimistic && <RunningState currentStep={result.currentStep} />}
                    </section>
                  );
                })}

                {showOptimistic && pendingFollowUp && (
                  <section className="flex flex-col gap-3 border-t border-line/70 pt-5">
                    <QuestionBubble text={pendingFollowUp} />
                    <RunningState currentStep={result.currentStep} />
                  </section>
                )}
              </div>
            </div>

            {hasProcess && (
              <aside className={cn("sticky top-0 hidden shrink-0 xl:block", rightRailWidth)}>
                <div className={cn("space-y-2.5", !toolsCardOpen && "flex flex-col items-end")}>
                  {toolsCardOpen && showStepsCard && (
                    <>
                      <div className="rounded-2xl border border-line/80 bg-card p-3.5 shadow-[0_18px_36px_rgba(24,32,28,0.06)]">
                        <div className="flex items-center gap-2 px-1">
                          <SlidersHorizontal className="h-4 w-4 text-accent" />
                          <div className="text-[13px] font-medium uppercase tracking-[0.12em] text-muted">STEPS</div>
                        </div>

                        <div className="mt-2.5 max-h-[245px] space-y-1.5 overflow-y-auto pr-1">
                          {visibleCheckpointGroups.map((group, groupIndex) => {
                            const open = !!openStepGroups[group.id];
                            const latest = groupIndex === visibleCheckpointGroups.length - 1;
                            return (
                              <section key={group.id} className="rounded-xl border border-line/60 bg-surface/50">
                                <button
                                  onClick={() => toggleStepGroup(group.id)}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                                >
                                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-card text-[10px] font-semibold text-muted ring-1 ring-line/70">
                                    {groupIndex + 1}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[12.5px] font-medium text-ink">
                                      {latest ? "Current question" : `Question ${groupIndex + 1}`}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11px] text-muted">{group.question}</span>
                                  </span>
                                  <ChevronDown className={cn("h-4 w-4 shrink-0 text-faint transition-transform", open && "rotate-180")} />
                                </button>

                                {open && (
                                  <div className="space-y-0.5 px-1.5 pb-1.5">
                                    {group.checkpoints.length === 0 ? (
                                      <div className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] text-muted">
                                        <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse text-accent" />
                                        <span>Working on this question</span>
                                      </div>
                                    ) : (
                                      group.checkpoints.map((cp) => (
                                        <button
                                          key={cp.nodeId}
                                          onClick={() => openTraceForStep(cp.nodeId)}
                                          className={cn(
                                            "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                                            selectedToolId === cp.nodeId ? "bg-accent-soft" : "hover:bg-hover/80",
                                          )}
                                        >
                                          <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
                                            {cp.order}
                                          </span>
                                          <span className="min-w-0 flex-1">
                                            <span className="block truncate text-[13px] font-medium text-ink">{cp.label}</span>
                                          </span>
                                          <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
                                        </button>
                                      ))
                                    )}
                                  </div>
                                )}
                              </section>
                            );
                          })}
                        </div>
                      </div>

                      {showVisualizationCard && visualizationInlineOpen && (
                        <VisualizationCard
                          question={visualizationQuestion}
                          sql={visualizationSql}
                          result={visualizationResult}
                          size="inline"
                          action={
                            <button
                              onClick={() => openVisualizationRail()}
                              className={cn(
                                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                                visualizationCardOpen
                                  ? "border-accent/55 bg-accent-soft/80 text-accent"
                                  : "border-line bg-card text-muted hover:border-line/90 hover:text-ink",
                              )}
                            >
                              <BarChart3 className="h-3.5 w-3.5" />
                              {visualizationCardOpen ? "Hide Enlarge" : "Enlarge"}
                            </button>
                          }
                        />
                      )}

                    </>
                  )}
                  {!toolsCardOpen && showVisualizationCard && visualizationInlineOpen && (
                    <VisualizationCard
                      question={visualizationQuestion}
                      sql={visualizationSql}
                      result={visualizationResult}
                      size="inline"
                      action={
                        <button
                          onClick={() => openVisualizationRail()}
                          className={cn(
                            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                            visualizationCardOpen
                              ? "border-accent/55 bg-accent-soft/80 text-accent"
                              : "border-line bg-card text-muted hover:border-line/90 hover:text-ink",
                          )}
                        >
                          <BarChart3 className="h-3.5 w-3.5" />
                          {visualizationCardOpen ? "Hide Enlarge" : "Enlarge"}
                        </button>
                      }
                    />
                  )}
                </div>
              </aside>
            )}
          </div>
        </div>

        {/* Follow-up composer — continues this same thread with full context.
            While the agent is busy, the send button becomes a Stop button. */}
        <div className="shrink-0 bg-transparent px-6 pb-2 pt-3">
          <div className="mx-auto flex w-full max-w-[1480px] gap-10 xl:gap-14">
            <div className="min-w-0 flex-1 xl:pr-6">
              <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-[23px] border border-line bg-card px-3.5 py-2 shadow-sm">
                <textarea
                  ref={followUpInputRef}
                  rows={1}
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (!busy) void submitFollowUp();
                    }
                  }}
                  placeholder={busy ? "AurigaSQL is working…" : "Ask anything"}
                  className="max-h-36 min-h-[23px] w-full resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 text-[15px] leading-[23px] text-ink placeholder:text-faint focus:outline-none"
                />
                {busy ? (
                  <button
                    aria-label="Pause"
                    title="Pause AurigaSQL"
                    onClick={handleStop}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pause text-invert-ink hover:opacity-90"
                  >
                    <Pause className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    aria-label="Ask"
                    onClick={() => void submitFollowUp()}
                    disabled={!followUp.trim()}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-invert text-invert-ink hover:opacity-90 disabled:cursor-not-allowed disabled:bg-hover disabled:text-faint disabled:opacity-100 disabled:hover:opacity-100"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-center text-[11px] text-faint">
                AurigaSQL can make mistakes. Check important results.
              </p>
            </div>
            {hasProcess && <div className={cn("hidden shrink-0 xl:block", rightRailWidth)} />}
          </div>
        </div>
      </main>

      {/* Far-right sidebar — one selected step owns the detail rail at a time. */}
      {hasProcess && (processOpen || visualizationCardOpen) && (
        <aside
          style={{ width: processPanel.width }}
          className="app-shell-bg relative flex shrink-0 flex-col border-l border-line/70"
        >
          <ResizeHandle
            edge="left"
            dragging={processPanel.dragging}
            onPointerDown={processPanel.onPointerDown}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {rightSidebarTab === "visualization" && showVisualizationCard && visualizationCardOpen ? (
                <div className="p-4">
                  <VisualizationCard
                    question={visualizationQuestion}
                    sql={visualizationSql}
                    result={visualizationResult}
                    size="rail"
                    chrome={false}
                  />
                </div>
              ) : (
                <ProcessTimeline
                  conversation={conv}
                  openTabIds={traceOpenTabIds}
                  selectedId={selectedTraceCheckpoint?.nodeId ?? selectedToolId}
                  onSelect={setSelectedToolId}
                  onCloseTab={closeTraceTab}
                  hideTabs
                />
              )}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
