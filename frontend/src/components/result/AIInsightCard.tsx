import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { bff } from "../../api/bff";
import { useModels } from "../../state/modelContext";
import { RichText } from "./RichText";

type AIInsightCardProps = {
  question: string;
  sql: string | null;
  result: string | null;
};

type AnalysisState = {
  key: string;
  status: "idle" | "loading" | "done" | "error";
  text: string;
  error: string;
};

const analysisCache = new Map<string, AnalysisState>();
const analysisRequests = new Map<string, Promise<AnalysisState>>();

function analysisKey(question: string, sql: string | null, result: string | null): string {
  return `${question}\u0000${sql ?? ""}\u0000${result ?? ""}`;
}

function requestAnalysis(
  key: string,
  question: string,
  sql: string | null,
  result: string,
  modelId: string | null,
): Promise<AnalysisState> {
  const cached = analysisCache.get(key);
  if (cached?.status === "done") return Promise.resolve(cached);

  const existing = analysisRequests.get(key);
  if (existing) return existing;

  const request = bff
    .analyze(question, sql ?? "", result, modelId)
    .then((response) => {
      const nextState: AnalysisState = {
        key,
        status: "done",
        text: response.analysis,
        error: "",
      };
      analysisCache.set(key, nextState);
      return nextState;
    })
    .catch((error: unknown) => {
      const nextState: AnalysisState = {
        key,
        status: "error",
        text: "",
        error: error instanceof Error ? error.message : "failed",
      };
      return nextState;
    })
    .finally(() => {
      analysisRequests.delete(key);
    });

  analysisRequests.set(key, request);
  return request;
}

function useAnalysis(
  question: string,
  sql: string | null,
  result: string | null,
  enabled: boolean,
  modelId: string | null,
  retryToken = 0,
) {
  const key = `${analysisKey(question, sql, result)}\u0000${modelId ?? ""}`;
  const [state, setState] = useState<AnalysisState>(() =>
    analysisCache.get(key) ?? { key, status: "idle", text: "", error: "" },
  );

  useEffect(() => {
    setState(analysisCache.get(key) ?? { key, status: "idle", text: "", error: "" });
  }, [key]);

  useEffect(() => {
    if (!enabled || !result) return;

    const cached = analysisCache.get(key);
    if (cached?.status === "done") {
      setState(cached);
      return;
    }

    let cancelled = false;
    const loadingState: AnalysisState = { key, status: "loading", text: "", error: "" };
    setState(loadingState);
    requestAnalysis(key, question, sql, result, modelId)
      .then((nextState) => {
        if (cancelled) return;
        setState(nextState);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const nextState: AnalysisState = {
          key,
          status: "error",
          text: "",
          error: error instanceof Error ? error.message : "failed",
        };
        setState(nextState);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, question, result, retryToken, sql]);

  return state;
}

export function AIInsightPrefetcher({ question, sql, result }: AIInsightCardProps) {
  const { selectedId } = useModels();
  useAnalysis(question, sql, result, !!result, selectedId || null);
  return null;
}

export function AIInsightCard({ question, sql, result }: AIInsightCardProps) {
  const { selectedId } = useModels();
  const [retryToken, setRetryToken] = useState(0);
  const analysis = useAnalysis(question, sql, result, !!result, selectedId || null, retryToken);

  return (
    <section className="rounded-2xl border border-line/80 bg-card p-4 shadow-[0_18px_36px_rgba(24,32,28,0.05)]">
      <div className="flex items-center gap-2 px-1">
        <Sparkles className="h-4 w-4 text-accent" />
        <div className="text-[13px] font-medium uppercase tracking-[0.12em] text-muted">AI INSIGHT</div>
      </div>

      <div className="mt-3 max-h-[160px] min-h-[72px] overflow-y-auto pr-1">
        {!result ? (
          <p className="text-[13px] leading-relaxed text-muted">
            Insight will appear once there is a result to analyze.
          </p>
        ) : analysis.status === "loading" || analysis.status === "idle" ? (
          <div className="flex items-center gap-2.5 text-[13px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            Analyzing result...
          </div>
        ) : analysis.status === "error" ? (
          <div className="flex items-start justify-between gap-3 text-[13px] leading-relaxed text-danger">
            <div className="flex min-w-0 items-start gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Couldn't generate an analysis. {analysis.error}</span>
            </div>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/25 px-2 py-1 text-[11px] font-medium text-danger transition hover:bg-danger/5"
              onClick={() => setRetryToken((value) => value + 1)}
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </button>
          </div>
        ) : analysis.text.trim() ? (
          <RichText text={analysis.text} className="text-[13.5px] leading-relaxed text-ink" />
        ) : (
          <p className="text-[13px] leading-relaxed text-muted">No analysis available for this result.</p>
        )}
      </div>
    </section>
  );
}
