import {
  Brain,
  Code2,
  CornerDownRight,
  Loader2,
  MessageCircleQuestion,
  MessageSquare,
  Sparkles,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { CardContent } from "./ThreadNodeCard";
import type { ThreadNode } from "../../lib/buildNodes";
import { humanizeToolName } from "../../lib/toolLabels";

type Tone = "ink" | "accent" | "muted" | "danger";

/** Single source of truth for how each card kind is labelled/iconed across the
 *  rail (step navigator) and the inspector — keeps the two views consistent. */
export const cardKindMeta: Record<CardContent["kind"], { label: string; Icon: LucideIcon; tone: Tone }> = {
  question: { label: "Question", Icon: MessageSquare, tone: "ink" },
  thinking: { label: "Thinking", Icon: Brain, tone: "muted" },
  tool: { label: "Tool call", Icon: Wrench, tone: "muted" },
  tool_group: { label: "Parallel tool calls", Icon: Wrench, tone: "muted" },
  agent_question: { label: "AurigaSQL asks", Icon: MessageCircleQuestion, tone: "accent" },
  user_answer: { label: "Your answer", Icon: CornerDownRight, tone: "ink" },
  answer: { label: "Final result", Icon: Code2, tone: "accent" },
  agent_text: { label: "Answer", Icon: Sparkles, tone: "accent" },
  working: { label: "Working", Icon: Loader2, tone: "muted" },
  error: { label: "Error", Icon: TriangleAlert, tone: "danger" },
};

export const toneText: Record<Tone, string> = {
  ink: "text-ink",
  accent: "text-accent",
  muted: "text-muted",
  danger: "text-danger",
};

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function compactExecuteSummary(summary?: string): string {
  const raw = (summary ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "query results";

  const cleaned = raw
    .replace(/^checking\s+/i, "")
    .replace(/^this query is checking\s+/i, "")
    .replace(/^the query is checking\s+/i, "")
    .replace(/^answering\s+/i, "")
    .replace(/^trying to\s+/i, "")
    .replace(/^how many\s+/i, "count of ")
    .replace(/^whether\s+/i, "")
    .replace(/[.?!,:;]+$/g, "")
    .trim();

  if (!cleaned) return "query results";

  const words = cleaned.split(" ");
  const compact = words.length > 6 ? `${words.slice(0, 6).join(" ")}...` : cleaned;
  return compact.toLowerCase();
}

function naturalExecuteTitle(summary?: string): string {
  const compact = compactExecuteSummary(summary);
  if (!compact || compact === "query results") return "Reviewing query results";

  if (compact.startsWith("count rows with missing")) {
    return "Checking for missing values";
  }
  if (compact.startsWith("count of missing")) {
    return "Checking for missing values";
  }
  if (compact.startsWith("count matching")) {
    return "Counting matching rows";
  }
  if (compact.startsWith("count ")) {
    return `Counting ${compact.slice("count ".length)}`;
  }
  if (compact.startsWith("compare grouped counts")) {
    return "Comparing grouped counts";
  }
  if (compact.startsWith("compare grouped metrics")) {
    return "Comparing grouped metrics";
  }
  if (compact.startsWith("compare ")) {
    return `Comparing ${compact.slice("compare ".length)}`;
  }
  if (compact.startsWith("check summary metrics")) {
    return "Reviewing summary metrics";
  }
  if (compact.startsWith("check ")) {
    return `Checking ${compact.slice("check ".length)}`;
  }
  if (compact.startsWith("inspect filtered records")) {
    return "Looking at filtered records";
  }
  if (compact.startsWith("inspect matching filtered records")) {
    return "Looking at matching filtered records";
  }
  if (compact.startsWith("inspect query results")) {
    return "Reviewing query results";
  }
  if (compact.startsWith("inspect ")) {
    return `Looking at ${compact.slice("inspect ".length)}`;
  }
  if (compact.startsWith("review ")) {
    return sentenceCase(compact.replace(/^review /, "reviewing "));
  }

  return sentenceCase(compact);
}

function parseToolArgs(body?: string): Record<string, unknown> | null {
  const text = body?.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringArg(args: Record<string, unknown> | null, keys: string[]): string | null {
  if (!args) return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function toolDisplayName(toolName?: string | null): string {
  if (!toolName) return cardKindMeta.tool.label;
  return humanizeToolName(toolName);
}

export function toolGroupButtonLabel(toolName?: string | null): string {
  switch (toolName) {
    case "execute_sql":
      return "Run SQL";
    case "get_schema":
      return "Get schema";
    case "get_knowledge_definition":
      return "Get definition";
    case "get_all_knowledge_definitions":
      return "Review knowledge";
    case "get_column_meaning":
      return "Column meaning";
    case "get_all_column_meanings":
      return "Column meanings";
    case "get_all_external_knowledge_names":
      return "Browse topics";
    default:
      return toolName ? humanizeToolName(toolName) : "Tool calls";
  }
}

export function toolCardTitle(toolName?: string | null, summary?: string): string {
  if (toolName === "execute_sql") return naturalExecuteTitle(summary);
  return toolDisplayName(toolName);
}

export function toolActionLabel(tool: ThreadNode): string {
  const args = parseToolArgs(tool.body);

  if (tool.title === "execute_sql") return cardLabel(tool);

  if (tool.title === "get_knowledge_definition") {
    const term = stringArg(args, ["knowledge_name", "knowledge", "name", "topic"]);
    return term ?? "Getting a knowledge definition";
  }

  if (tool.title === "get_column_meaning") {
    const table = stringArg(args, ["table_name", "table"]);
    const column = stringArg(args, ["column_name", "column"]);
    if (table && column) return `${table}.${column}`;
    if (column) return column;
    return "Getting a column meaning";
  }

  if (tool.title === "get_all_column_meanings") {
    const table = stringArg(args, ["table_name", "table"]);
    return table ? `Getting all column meanings for ${table}` : "Getting all column meanings";
  }

  if (tool.title === "get_schema") return "Inspecting database schema";
  if (tool.title === "get_all_external_knowledge_names") return "Listing available domain topics";
  if (tool.title === "get_all_knowledge_definitions") return "Getting all knowledge definitions";

  return toolCardTitle(tool.title, tool.summary);
}

/** Human label for a card, preferring a natural-language tool name when present. */
export function cardLabel(tn: CardContent): string {
  if (tn.kind === "tool_group") {
    if (tn.title === "execute_sql") {
      return `${tn.tools.length} SQL ${tn.tools.length === 1 ? "query" : "queries"}`;
    }
    return `${tn.tools.length} ${toolDisplayName(tn.title).toLowerCase()} calls`;
  }
  if (tn.kind === "tool" && "title" in tn && tn.title) return toolCardTitle(tn.title, "summary" in tn ? tn.summary : undefined);
  return cardKindMeta[tn.kind].label;
}
