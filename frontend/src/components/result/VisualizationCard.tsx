import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart3, Sigma, ZoomIn, ZoomOut } from "lucide-react";
import { parseResultTable, type ResultTable } from "../../lib/parseResultTable";
import { cn } from "../../lib/cn";

type VisualizationCardProps = {
  question: string;
  sql: string | null;
  result: string | null;
  action?: ReactNode;
  size?: "inline" | "rail";
  chrome?: boolean;
};

type ChartMode = "bar" | "histogram" | "line" | "scatter";

type SeriesPoint = {
  label: string;
  value: number;
};

type ScatterPoint = {
  x: number;
  y: number;
};

const MIN_ROWS_FOR_HISTOGRAM = 8;

function formatMetric(value: number) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatTick(value: number) {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/, "");
  if (abs >= 0.1) return value.toFixed(2).replace(/\.?0+$/, "");
  return value.toPrecision(2);
}

function niceStep(rawStep: number) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * power;
}

function buildNiceTicks(minValue: number, maxValue: number, count = 4) {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return { min: 0, max: 1, ticks: buildRangeTicks(0, 1, count) };
  }
  if (minValue === maxValue) {
    const pad = Math.abs(minValue) > 0 ? Math.abs(minValue) * 0.15 : 1;
    minValue -= pad;
    maxValue += pad;
  }

  const step = niceStep((maxValue - minValue) / Math.max(count - 1, 1));
  const niceMin = Math.floor(minValue / step) * step;
  const niceMax = Math.ceil(maxValue / step) * step;
  const tickCount = Math.max(2, Math.round((niceMax - niceMin) / step) + 1);
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const value = niceMin + step * index;
    const ratio = (value - niceMin) / (niceMax - niceMin || 1);
    return { value, ratio };
  });
  return { min: niceMin, max: niceMax, ticks };
}

function buildRangeTicks(minValue: number, maxValue: number, count = 4) {
  const spread = maxValue - minValue || 1;
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    return {
      value: minValue + spread * ratio,
      ratio,
    };
  });
}

function buildCountTicks(maxValue: number) {
  const cappedMax = Math.max(1, Math.ceil(maxValue));
  return Array.from({ length: cappedMax + 1 }, (_, index) => {
    const ratio = cappedMax === 0 ? 0 : index / cappedMax;
    return {
      value: index,
      top: `${(1 - ratio) * 100}%`,
    };
  });
}

function isNumericCell(value: string) {
  return /^-?\d+(?:\.\d+)?$/.test(value.trim());
}

function isDateLike(value: string) {
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value.trim()) || !Number.isNaN(Date.parse(value.trim()));
}

function analyzeTable(table: ResultTable) {
  const numericCols: number[] = [];
  const labelCols: number[] = [];
  const dateLikeCols: number[] = [];

  table.headers.forEach((_, index) => {
    const values = table.rows.map((row) => row[index] ?? "").filter((value) => value !== "");
    if (values.length === 0) return;
    const numeric = values.every(isNumericCell);
    if (numeric) {
      numericCols.push(index);
      return;
    }
    if (values.every(isDateLike)) dateLikeCols.push(index);
    labelCols.push(index);
  });

  return { numericCols, labelCols, dateLikeCols };
}

function inferChart(table: ResultTable): ChartMode | null {
  const { numericCols, labelCols, dateLikeCols } = analyzeTable(table);
  if (table.rows.length < 1 || numericCols.length === 0) return null;
  if (dateLikeCols.length > 0 && numericCols.length > 0) return "line";
  if (labelCols.length > 0 && numericCols.length > 0) return "bar";
  if (numericCols.length >= 2) return "scatter";
  if (numericCols.length === 1 && table.rows.length >= MIN_ROWS_FOR_HISTOGRAM) return "histogram";
  if (numericCols.length === 1) return "bar";
  return null;
}

function clampRows<T>(rows: T[], limit: number) {
  return rows.slice(0, limit);
}

function getColumnIndex(table: ResultTable, key?: string | null, fallback = 0) {
  if (!key) return fallback;
  const index = table.headers.findIndex((header) => header === key);
  return index === -1 ? fallback : index;
}

function getBarSeries(table: ResultTable, xKey?: string | null, yKey?: string | null): SeriesPoint[] {
  const { numericCols, labelCols } = analyzeTable(table);
  const valueIndex = getColumnIndex(table, yKey, numericCols[0]);
  const labelIndex = getColumnIndex(table, xKey, labelCols[0] ?? 0);
  return clampRows(
    table.rows
      .map((row) => ({
        label: String(row[labelIndex] ?? "").trim() || `Row`,
        value: Number(row[valueIndex]),
      }))
      .filter((row) => Number.isFinite(row.value)),
    8,
  );
}

function getLineSeries(table: ResultTable, xKey?: string | null, yKey?: string | null): SeriesPoint[] {
  const { numericCols, dateLikeCols, labelCols } = analyzeTable(table);
  const valueIndex = getColumnIndex(table, yKey, numericCols[0]);
  const labelIndex = getColumnIndex(table, xKey, dateLikeCols[0] ?? labelCols[0] ?? 0);
  return clampRows(
    table.rows
      .map((row) => ({
        label: String(row[labelIndex] ?? "").trim() || `Row`,
        value: Number(row[valueIndex]),
      }))
      .filter((row) => Number.isFinite(row.value)),
    10,
  );
}

function getScatterSeries(table: ResultTable, xKey?: string | null, yKey?: string | null): ScatterPoint[] {
  const { numericCols } = analyzeTable(table);
  const xIndex = getColumnIndex(table, xKey, numericCols[0]);
  const yIndex = getColumnIndex(table, yKey, numericCols[1] ?? numericCols[0]);
  return clampRows(
    table.rows
      .map((row) => ({
        x: Number(row[xIndex]),
        y: Number(row[yIndex]),
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    18,
  );
}

function getHistogramBins(table: ResultTable, valueKey?: string | null) {
  const { numericCols } = analyzeTable(table);
  const valueIndex = getColumnIndex(table, valueKey, numericCols[0]);
  const values = table.rows
    .map((row) => Number(row[valueIndex]))
    .filter((value) => Number.isFinite(value));

  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ label: `${min.toFixed(2)}`, count: values.length }];

  const binCount = Math.min(6, Math.max(4, Math.ceil(Math.sqrt(values.length))));
  const step = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    start: min + step * index,
    end: index === binCount - 1 ? max : min + step * (index + 1),
    count: 0,
  }));

  values.forEach((value) => {
    const rawIndex = Math.floor((value - min) / step);
    const index = Math.min(binCount - 1, Math.max(0, rawIndex));
    bins[index].count += 1;
  });

  return bins.map((bin) => ({
    label: `${bin.start.toFixed(1)}-${bin.end.toFixed(1)}`,
    count: bin.count,
  }));
}

function ChartShell({
  title,
  controls,
  footer,
  action,
  children,
}: {
  title: string;
  controls: ReactNode;
  footer?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line/80 bg-card p-3.5 shadow-[0_18px_36px_rgba(24,32,28,0.05)]">
      <div className="flex items-start justify-between gap-3 px-1">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-accent" />
            <div className="text-[13px] font-medium uppercase tracking-[0.12em] text-muted">VISUALIZATION</div>
          </div>
          <div className="mt-0.5 text-[10.5px] font-medium text-faint">Source: final SQL result</div>
        </div>
        {action}
      </div>

      <div className="mt-2.5">{controls}</div>

      <div className="mt-2.5">
        <div className="mb-2 truncate text-[13px] font-medium text-ink">{title}</div>
        {children}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </section>
  );
}

function MiniSwitch({
  modes,
  current,
  onChange,
}: {
  modes: ChartMode[];
  current: ChartMode | null;
  onChange: (mode: ChartMode) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {modes.map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
            current === mode
              ? "border-accent bg-accent-soft text-accent"
              : "border-line bg-card text-muted hover:bg-hover",
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function AxisSelect({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  className?: string;
}) {
  if (options.length === 0) return null;
  return (
    <label className={cn("flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-card px-2 py-1 text-[11px] text-muted", className)}>
      <span className="shrink-0 font-medium uppercase tracking-[0.08em] text-faint">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[11px] font-medium text-ink outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyVisualization({ reason, expanded = false }: { reason: string; expanded?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", expanded ? "h-[260px]" : "h-[120px]")}>
      <Sigma className="h-6 w-6 text-faint" />
      <p className="mt-3 text-[13px] font-medium text-ink">No chart yet</p>
      <p className="mt-1 max-w-[240px] text-[12px] leading-relaxed text-muted">{reason}</p>
    </div>
  );
}

function AxisLabels({
  xLabel,
  yLabel,
}: {
  xLabel: string;
  yLabel: string;
}) {
  return (
    <div className="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">{yLabel}</div>
  );
}

function BarChartView({
  data,
  xLabel,
  yLabel,
  expanded = false,
  zoom = 1,
}: {
  data: SeriesPoint[];
  xLabel: string;
  yLabel: string;
  expanded?: boolean;
  zoom?: number;
}) {
  const dataMin = Math.min(...data.map((item) => item.value));
  const dataMax = Math.max(...data.map((item) => item.value));
  const domainMin = dataMin >= 0 ? 0 : dataMin;
  const domainMax = dataMax <= 0 ? 0 : dataMax;
  const scale = buildNiceTicks(domainMin, domainMax, 4);
  const chartHeight = expanded ? Math.round(240 * zoom) : 96;
  const valueToNumber = (value: number) => (1 - (value - scale.min) / (scale.max - scale.min || 1)) * 100;
  const baselineTop = valueToNumber(0);
  return (
    <div className="space-y-2">
      <AxisLabels xLabel={xLabel} yLabel={yLabel} />
      <div className="relative pl-8">
        <div className="absolute bottom-0 left-0 top-0 w-7">
          {scale.ticks.map((tick, index) => (
            <div
              key={index}
              className="absolute left-0 -translate-y-1/2 text-[10px] text-faint"
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {formatTick(tick.value)}
            </div>
          ))}
        </div>
        <div className="relative flex gap-3" style={{ height: chartHeight }}>
          <div className="absolute bottom-0 left-0 top-0 w-px bg-line/70" />
          <div className="absolute left-0 right-0 h-px bg-line/70" style={{ top: `${baselineTop}%` }} />
          {data.map((item) => {
            const valueTop = valueToNumber(item.value);
            const barTop = Math.min(valueTop, baselineTop);
            const rawHeight = Math.abs(valueTop - baselineTop);
            const barHeight = item.value === 0 ? 0 : Math.max(4, rawHeight);
            const labelTop = item.value >= 0
              ? `calc(${barTop}% - 18px)`
              : `calc(${barTop + barHeight}% + 4px)`;
            return (
              <div key={item.label} className="relative min-w-0 flex-1">
                <span
                  className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-ink"
                  style={{ top: labelTop }}
                >
                  {formatMetric(item.value)}
                </span>
                  <div
                    className={cn(
                      "absolute left-1/2 w-[70%] min-w-[16px] max-w-[42px] -translate-x-1/2 rounded-sm",
                      item.value >= 0 ? "bg-accent" : "bg-[#9eb8b4]",
                    )}
                    style={{ top: `${barTop}%`, height: `${barHeight}%` }}
                    title={item.value.toFixed(2)}
                  />
              </div>
            );
          })}
        </div>
      </div>
      <div className="pl-8">
        <div
          className="mt-1 grid gap-x-3 gap-y-1 text-[10px] text-muted"
          style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}
        >
          {data.map((item) => (
            <div key={item.label} className="truncate text-center">
              {item.label}
            </div>
          ))}
        </div>
        <div className="mt-2 pr-1 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-faint">{xLabel}</div>
      </div>
    </div>
  );
}

function HistogramView({
  bins,
  xLabel,
  yLabel,
  expanded = false,
  zoom = 1,
}: {
  bins: Array<{ label: string; count: number }>;
  xLabel: string;
  yLabel: string;
  expanded?: boolean;
  zoom?: number;
}) {
  const max = Math.max(...bins.map((item) => item.count), 1);
  const ticks = buildCountTicks(max);
  const chartHeight = expanded ? Math.round(240 * zoom) : 96;
  const barAreaHeight = expanded ? Math.round(208 * zoom) : 76;
  return (
    <div className="space-y-2">
      <AxisLabels xLabel={xLabel} yLabel={yLabel} />
      <div className="relative pl-8">
        <div className="absolute bottom-0 left-0 top-0 w-7">
          {ticks.map((tick, index) => (
            <div
              key={index}
              className="absolute left-0 -translate-y-1/2 text-[10px] text-faint"
              style={{ top: tick.top }}
            >
              {tick.value}
            </div>
          ))}
        </div>
        <div className="relative flex items-end gap-2" style={{ height: chartHeight }}>
          <div className="absolute bottom-0 left-0 top-0 w-px bg-line/70" />
          <div className="absolute bottom-0 left-0 right-0 h-px bg-line/70" />
          {bins.map((bin) => (
            <div key={bin.label} className="flex min-w-0 flex-1 items-end justify-center">
              <div className="flex w-full items-end justify-center" style={{ height: barAreaHeight }}>
                <div
                  className="w-[82%] min-w-[18px] rounded-sm bg-accent"
                  style={{ height: `${Math.max(12, (bin.count / max) * 100)}%` }}
                  title={`${bin.count}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="pl-8">
        <div
          className="grid gap-x-2 gap-y-1 text-[10px] text-faint"
          style={{ gridTemplateColumns: `repeat(${bins.length}, minmax(0, 1fr))` }}
        >
          {bins.map((bin) => (
            <div key={`${bin.label}-count`} className="truncate text-center font-medium">
              {bin.count}
            </div>
          ))}
        </div>
        <div
          className="mt-1 grid gap-x-2 gap-y-1 text-[10px] text-muted"
          style={{ gridTemplateColumns: `repeat(${bins.length}, minmax(0, 1fr))` }}
        >
          {bins.map((bin) => (
            <div key={bin.label} className="truncate text-center">
              {bin.label}
            </div>
          ))}
        </div>
        <div className="mt-2 pr-1 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-faint">{xLabel}</div>
      </div>
    </div>
  );
}

function LineChartView({
  data,
  xLabel,
  yLabel,
  expanded = false,
  zoom = 1,
}: {
  data: SeriesPoint[];
  xLabel: string;
  yLabel: string;
  expanded?: boolean;
  zoom?: number;
}) {
  const width = expanded ? 340 : 280;
  const height = expanded ? Math.round(240 * zoom) : 110;
  const min = Math.min(...data.map((item) => item.value));
  const max = Math.max(...data.map((item) => item.value));
  const spread = max - min || 1;
  const yTicks = buildRangeTicks(min, max).reverse();

  const points = data.map((item, index) => {
    const x = data.length === 1 ? width / 2 : (index / (data.length - 1)) * width;
    const y = height - ((item.value - min) / spread) * (height - 20) - 10;
    return { x, y, label: item.label, value: item.value };
  });

  return (
    <div className="space-y-2">
      <AxisLabels xLabel={xLabel} yLabel={yLabel} />
      <div className="relative pl-10">
        <div className="absolute bottom-[22px] left-0 top-0 w-8">
          {yTicks.map((tick, index) => (
            <div
              key={index}
              className="absolute left-0 -translate-y-1/2 text-[10px] text-faint"
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {formatTick(tick.value)}
            </div>
          ))}
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible" style={{ height }}>
          <line x1="10" y1={height - 10} x2={width} y2={height - 10} stroke="rgba(169,181,176,0.8)" strokeWidth="1" />
          <line x1="10" y1="0" x2="10" y2={height - 10} stroke="rgba(169,181,176,0.8)" strokeWidth="1" />
          <path
            d={points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")}
            fill="none"
            stroke="#1b8d86"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {points.map((point) => (
            <circle key={point.label} cx={point.x} cy={point.y} r="4" fill="#1b8d86" />
          ))}
        </svg>
      </div>
      <div
        className="grid gap-x-2 gap-y-1 pl-10 text-[10px] text-muted"
        style={{ gridTemplateColumns: `repeat(${Math.min(data.length, 3)}, minmax(0, 1fr))` }}
      >
        {data.map((point) => (
          <div key={point.label} className="truncate text-center">
            {point.label}
          </div>
        ))}
      </div>
      <div className="pl-10 pr-1 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-faint">{xLabel}</div>
    </div>
  );
}

function ScatterChartView({
  data,
  xLabel,
  yLabel,
  expanded = false,
  zoom = 1,
}: {
  data: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  expanded?: boolean;
  zoom?: number;
}) {
  const width = expanded ? 340 : 280;
  const height = expanded ? Math.round(240 * zoom) : 110;
  const minX = Math.min(...data.map((item) => item.x));
  const maxX = Math.max(...data.map((item) => item.x));
  const minY = Math.min(...data.map((item) => item.y));
  const maxY = Math.max(...data.map((item) => item.y));
  const spreadX = maxX - minX || 1;
  const spreadY = maxY - minY || 1;
  const xTicks = buildRangeTicks(minX, maxX);
  const yTicks = buildRangeTicks(minY, maxY).reverse();

  return (
    <div className="space-y-2">
      <AxisLabels xLabel={xLabel} yLabel={yLabel} />
      <div className="relative pl-10">
        <div className="absolute bottom-[22px] left-0 top-0 w-8">
          {yTicks.map((tick, index) => (
            <div
              key={index}
              className="absolute left-0 -translate-y-1/2 text-[10px] text-faint"
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {formatTick(tick.value)}
            </div>
          ))}
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible" style={{ height }}>
          <line x1="10" y1={height - 10} x2={width} y2={height - 10} stroke="rgba(169,181,176,0.8)" strokeWidth="1" />
          <line x1="10" y1="0" x2="10" y2={height - 10} stroke="rgba(169,181,176,0.8)" strokeWidth="1" />
          {data.map((point, index) => {
            const x = ((point.x - minX) / spreadX) * (width - 20) + 10;
            const y = height - ((point.y - minY) / spreadY) * (height - 20) - 10;
            return <circle key={`${point.x}-${point.y}-${index}`} cx={x} cy={y} r="5" fill="#1b8d86" opacity="0.85" />;
          })}
        </svg>
      </div>
      <div
        className="grid gap-x-2 gap-y-1 pl-10 text-[10px] text-muted"
        style={{ gridTemplateColumns: `repeat(${xTicks.length}, minmax(0, 1fr))` }}
      >
        {xTicks.map((tick, index) => (
          <div key={index} className="truncate text-center">
            {formatTick(tick.value)}
          </div>
        ))}
      </div>
      <div className="pl-10 pr-1 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-faint">{xLabel}</div>
    </div>
  );
}

export function VisualizationCard({ question, sql, result, action, size = "inline", chrome = true }: VisualizationCardProps) {
  void question;
  void sql;
  const table = useMemo(() => (result ? parseResultTable(result) : null), [result]);
  const inferred = useMemo(() => (table ? inferChart(table) : null), [table]);
  const availableModes = useMemo<ChartMode[]>(() => {
    if (!table || !inferred) return [];
    const { numericCols, labelCols, dateLikeCols } = analyzeTable(table);
    const modes: ChartMode[] = [];
    if (labelCols.length > 0 && numericCols.length > 0) modes.push("bar");
    if (dateLikeCols.length > 0 && numericCols.length > 0) modes.push("line");
    if (numericCols.length >= 2) modes.push("scatter");
    if (numericCols.length >= 1 && table.rows.length >= MIN_ROWS_FOR_HISTOGRAM) modes.push("histogram");
    return Array.from(new Set(modes));
  }, [table, inferred]);
  const analysis = useMemo(
    () => (table ? analyzeTable(table) : { numericCols: [], labelCols: [], dateLikeCols: [] }),
    [table],
  );
  const allColumns = table?.headers ?? [];
  const numericColumns = analysis.numericCols.map((index) => allColumns[index]).filter(Boolean);

  const [mode, setMode] = useState<ChartMode | null>(null);
  const [selectedXKey, setSelectedXKey] = useState<string | null>(null);
  const [selectedYKey, setSelectedYKey] = useState<string | null>(null);
  const [selectedValueKey, setSelectedValueKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setMode(inferred);
    setSelectedXKey(null);
    setSelectedYKey(null);
    setSelectedValueKey(null);
    setZoom(1);
  }, [result, inferred]);

  const resolvedMode = mode ?? inferred;
  const isRail = size === "rail";
  const pickColumn = (selected: string | null, options: string[], fallback: string) =>
    selected && options.includes(selected) ? selected : fallback;

  function getAxisControls() {
    const primaryNumeric = numericColumns[0] ?? "";
    const secondaryNumeric = numericColumns[1] ?? primaryNumeric;
    const xFallback = allColumns[analysis.labelCols[0] ?? analysis.dateLikeCols[0] ?? 0] ?? "";
    const lineXFallback = allColumns[analysis.dateLikeCols[0] ?? analysis.labelCols[0] ?? 0] ?? "";
    const xKey =
      resolvedMode === "scatter"
        ? pickColumn(selectedXKey, numericColumns, primaryNumeric)
        : resolvedMode === "line"
          ? pickColumn(selectedXKey, allColumns, lineXFallback)
          : pickColumn(selectedXKey, allColumns, xFallback);
    const yKey = pickColumn(selectedYKey, numericColumns, resolvedMode === "scatter" ? secondaryNumeric : primaryNumeric);
    const valueKey = pickColumn(selectedValueKey, numericColumns, primaryNumeric);

    if (resolvedMode === "bar" || resolvedMode === "line") {
      return (
        <div className="flex flex-wrap gap-2">
          <AxisSelect className="flex-1 basis-[150px]" label="X" value={xKey} options={allColumns} onChange={setSelectedXKey} />
          <AxisSelect className="flex-1 basis-[150px]" label="Y" value={yKey} options={numericColumns} onChange={setSelectedYKey} />
        </div>
      );
    }
    if (resolvedMode === "scatter") {
      return (
        <div className="flex flex-wrap gap-2">
          <AxisSelect className="flex-1 basis-[150px]" label="X" value={xKey} options={numericColumns} onChange={setSelectedXKey} />
          <AxisSelect className="flex-1 basis-[150px]" label="Y" value={yKey} options={numericColumns} onChange={setSelectedYKey} />
        </div>
      );
    }
    if (resolvedMode === "histogram") {
      return (
        <div className="flex flex-wrap gap-2">
          <AxisSelect className="flex-1 basis-[220px]" label="Value" value={valueKey} options={numericColumns} onChange={setSelectedValueKey} />
        </div>
      );
    }
    return null;
  }

  function renderControlPanel() {
    return (
      <div className="space-y-2">
        {availableModes.length > 0 && resolvedMode && (
          <div className="flex flex-wrap items-center gap-1.5">
            <MiniSwitch
              modes={availableModes}
              current={resolvedMode}
              onChange={(nextMode) => {
                setMode(nextMode);
              }}
            />
          </div>
        )}
      </div>
    );
  }

  if (!table) {
    if (!chrome) {
      return (
        <div className="px-2 py-3">
          <EmptyVisualization reason="This result is plain text, so there is no structured table to plot yet." expanded={isRail} />
        </div>
      );
    }
    return (
      <ChartShell
        title="Chart preview"
        controls={renderControlPanel()}
        action={action}
      >
        <EmptyVisualization reason="This result is plain text, so there is no structured table to plot yet." expanded={isRail} />
      </ChartShell>
    );
  }

  if (!resolvedMode) {
      if (!chrome) {
        return (
          <div className="px-2 py-3">
            <EmptyVisualization reason="Need at least one numeric column to plot a chart." expanded={isRail} />
          </div>
        );
      }
      return (
          <ChartShell
            title="Chart preview"
            controls={renderControlPanel()}
            action={action}
          >
            <EmptyVisualization reason="Need at least one numeric column to plot a chart." expanded={isRail} />
        </ChartShell>
    );
  }

  const { numericCols, labelCols, dateLikeCols } = analysis;
  const barXLabel = pickColumn(selectedXKey, allColumns, table.headers[labelCols[0] ?? dateLikeCols[0] ?? 0] || "Category");
  const barYLabel = pickColumn(selectedYKey, numericColumns, table.headers[numericCols[0]] || "Value");
  const lineXLabel = pickColumn(selectedXKey, allColumns, table.headers[dateLikeCols[0] ?? labelCols[0] ?? 0] || "X");
  const lineYLabel = pickColumn(selectedYKey, numericColumns, table.headers[numericCols[0]] || "Value");
  const scatterXLabel = pickColumn(selectedXKey, numericColumns, table.headers[numericCols[0]] || "X");
  const scatterYLabel = pickColumn(selectedYKey, numericColumns, table.headers[numericCols[1] ?? numericCols[0]] || "Y");
  const histogramXLabel = pickColumn(selectedValueKey, numericColumns, table.headers[numericCols[0]] || "Value");
  const histogramYLabel = "Count";
  const chartZoom = chrome ? 1 : zoom;
  const chartTitle =
    resolvedMode === "bar"
      ? `${barYLabel} by ${barXLabel}`
      : resolvedMode === "line"
        ? `${lineYLabel} over ${lineXLabel}`
        : resolvedMode === "scatter"
          ? `${scatterYLabel} vs ${scatterXLabel}`
          : `Distribution of ${histogramXLabel}`;
  const chart = (
    <>
      {resolvedMode === "bar" && <BarChartView data={getBarSeries(table, barXLabel, barYLabel)} xLabel={barXLabel} yLabel={barYLabel} expanded={isRail} zoom={chartZoom} />}
      {resolvedMode === "line" && <LineChartView data={getLineSeries(table, lineXLabel, lineYLabel)} xLabel={lineXLabel} yLabel={lineYLabel} expanded={isRail} zoom={chartZoom} />}
      {resolvedMode === "scatter" && <ScatterChartView data={getScatterSeries(table, scatterXLabel, scatterYLabel)} xLabel={scatterXLabel} yLabel={scatterYLabel} expanded={isRail} zoom={chartZoom} />}
      {resolvedMode === "histogram" && <HistogramView bins={getHistogramBins(table, histogramXLabel)} xLabel={histogramXLabel} yLabel={histogramYLabel} expanded={isRail} zoom={chartZoom} />}
    </>
  );
  const axisControls = getAxisControls();
  const zoomControls = (
    <div className="flex items-center gap-1 rounded-full border border-line bg-card px-1 py-1">
      <button
        aria-label="Zoom out"
        onClick={() => setZoom((current) => Math.max(0.75, Number((current - 0.25).toFixed(2))))}
        disabled={zoom <= 0.75}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-35"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </button>
      <span className="w-10 text-center text-[11px] font-medium text-muted">{Math.round(zoom * 100)}%</span>
      <button
        aria-label="Zoom in"
        onClick={() => setZoom((current) => Math.min(1.75, Number((current + 0.25).toFixed(2))))}
        disabled={zoom >= 1.75}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-35"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  if (!chrome) {
    return (
      <div className="px-2 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[14px] font-medium text-ink">{chartTitle}</div>
            <div className="mt-2">{renderControlPanel()}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {zoomControls}
          </div>
        </div>
        <div className="mt-5">{chart}</div>
        {axisControls && <div className="mt-5">{axisControls}</div>}
      </div>
    );
  }

  return (
    <ChartShell
      title={chartTitle}
      controls={renderControlPanel()}
      footer={axisControls}
      action={action}
    >
      {chart}
    </ChartShell>
  );
}
