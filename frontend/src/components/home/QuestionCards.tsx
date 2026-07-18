import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TaskItem } from "../../api/bff";

export function QuestionCards(props: {
  tasks: TaskItem[];
  onPick: (t: TaskItem) => void;
}) {
  const [batchIndex, setBatchIndex] = useState(0);
  const taskSignature = props.tasks.map((task) => task.instance_id).join("|");
  const batchSize = 3;
  const batchCount = Math.max(1, Math.ceil(props.tasks.length / batchSize));
  const shown = Array.from(
    { length: Math.min(batchSize, props.tasks.length) },
    (_, index) => props.tasks[(batchIndex * batchSize + index) % props.tasks.length],
  );

  useEffect(() => {
    setBatchIndex(0);
  }, [taskSignature]);

  if (shown.length === 0) return null;
  return (
    <section className="w-full">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-ink">Sample questions</h3>
        {props.tasks.length > batchSize && (
          <button
            type="button"
            onClick={() => setBatchIndex((current) => (current + 1) % batchCount)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-muted transition hover:bg-hover hover:text-ink"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {shown.map((t) => (
          <button
            key={t.instance_id}
            onClick={() => props.onPick(t)}
            className="rounded-[18px] border border-line bg-card px-4 py-3 text-left shadow-sm transition-transform hover:-translate-y-0.5 hover:bg-hover"
          >
            <div className="line-clamp-3 text-[13px] leading-6 text-ink">{t.amb_user_query}</div>
          </button>
        ))}
      </div>
    </section>
  );
}
