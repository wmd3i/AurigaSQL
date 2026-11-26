import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Anthropic, Gemini, Kimi, Minimax, Ollama, OpenAI, XAI, ZAI } from "@lobehub/icons";
import { ArrowLeft, Check, ChevronDown, KeyRound, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { bff, type LlmConfigsResponse, type LlmProfile, type LocalModelStatus } from "../../api/bff";
import { cn } from "../../lib/cn";

const NEW_ID = "__new__";
const SCROLLBAR =
  "overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgba(95,109,101,0.42)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.32)] hover:[&::-webkit-scrollbar-thumb]:bg-[rgba(95,109,101,0.5)]";

const CUSTOM_MODEL_VALUE = "__custom_model__";
const LOCAL_DEMO_MODEL = {
  label: "Local Model · Qwen3 1.7B",
  provider: "other" as const,
  model: "openai/Qwen3-1.7B-Q4_K_M",
  apiBase: "http://127.0.0.1:6021/v1",
  sizeLabel: "about 1.14 GB",
};

const DEMO_PROVIDER_LABEL = "Demo · Qwen3 1.7B (local)";

type ProviderId = "openai" | "gemini" | "zai" | "anthropic" | "minimax" | "xai" | "kimi" | "ollama" | "other";

type ModelOption = {
  value: string;
  label: string;
  endpoint: string;
  showEndpoint: boolean;
  displayName: string;
  custom?: boolean;
};

type ProviderLogo = ComponentType<{ size: number; className?: string }>;

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
  { id: "other", label: "OpenAI-compatible API" },
  { id: "kimi", label: "Kimi" },
  { id: "minimax", label: "MiniMax" },
  { id: "ollama", label: "Ollama" },
  { id: "xai", label: "xAI" },
  { id: "zai", label: "Z.ai" },
];

const PROVIDER_LOGO: Record<ProviderId, ProviderLogo> = {
  openai: OpenAI.Avatar,
  gemini: Gemini.Avatar,
  zai: ZAI.Avatar,
  anthropic: Anthropic.Avatar,
  minimax: Minimax.Avatar,
  xai: XAI.Avatar,
  kimi: Kimi.Avatar,
  ollama: Ollama.Avatar,
  other: KeyRound,
};

const CUSTOM_MODEL_PLACEHOLDER: Record<ProviderId, string> = {
  other: "openai/your-model-name",
  openai: "openai/gpt-6.2-sol",
  gemini: "gemini/gemini-3.8-flash",
  zai: "openai/glm-5.3",
  anthropic: "claude-opus-5-5",
  minimax: "minimax/MiniMax-M3.1-Flash",
  xai: "xai/grok-4.7",
  kimi: "openai/kimi-k3.1-pro",
  ollama: "ollama_chat/glm-5.2:cloud",
};

const MODEL_OPTIONS: Record<ProviderId, ModelOption[]> = {
  openai: [
    {
      value: "openai/gpt-6.2-astra",
      label: "GPT-6.2 Astra",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-6.2 Astra",
    },
    {
      value: "openai/gpt-6.2-sol",
      label: "GPT-6.2 Sol",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-6.2 Sol",
    },
    {
      value: "openai/gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-6.1 Terra",
    },
    {
      value: "openai/gpt-6-luna",
      label: "GPT-6 Luna",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-6 Luna",
    },
    {
      value: "openai/gpt-5.5",
      label: "GPT-5.5",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.5",
    },
    {
      value: "openai/gpt-5.5-pro",
      label: "GPT-5.5 Pro",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.5 Pro",
    },
    {
      value: "openai/gpt-5.4",
      label: "GPT-5.4",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.4",
    },
    {
      value: "openai/gpt-5.4-pro",
      label: "GPT-5.4 Pro",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.4 Pro",
    },
    {
      value: "openai/gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.4 Mini",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "",
      showEndpoint: false,
      displayName: "Custom OpenAI",
      custom: true,
    },
  ],
  gemini: [
    {
      value: "gemini/gemini-4-carbon",
      label: "Gemini 4 Carbon",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 4 Carbon",
    },
    {
      value: "gemini/gemini-4-neon",
      label: "Gemini 4 Neon",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 4 Neon",
    },
    {
      value: "gemini/gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 4 Hydrogen",
    },
    {
      value: "gemini/gemini-4-argon",
      label: "Gemini 4 Argon",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 4 Argon",
    },
    {
      value: "gemini/gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3.8 Flash",
    },
    {
      value: "gemini/gemini-3.6-flash",
      label: "Gemini 3.6 Flash",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3.6 Flash",
    },
    {
      value: "gemini/gemini-3.5-flash-lite",
      label: "Gemini 3.5 Flash-Lite",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3.5 Flash-Lite",
    },
    {
      value: "gemini/gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3.1 Pro",
    },
    {
      value: "gemini/gemini-3-flash-preview",
      label: "Gemini 3 Flash",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3 Flash",
    },
    {
      value: "gemini/gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash-Lite",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3.1 Flash-Lite",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "",
      showEndpoint: false,
      displayName: "Custom Gemini",
      custom: true,
    },
  ],
  zai: [
    {
      value: "openai/glm-5.4",
      label: "GLM-5.4",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-5.4",
    },
    {
      value: "openai/glm-5.3",
      label: "GLM-5.3",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-5.3",
    },
    {
      value: "openai/glm-5.3-flash",
      label: "GLM-5.3 Flash",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-5.3 Flash",
    },
    {
      value: "openai/glm-5.2",
      label: "GLM-5.2",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-5.2",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "Custom GLM",
      custom: true,
    },
  ],
  anthropic: [
    {
      value: "claude-fable-5-2",
      label: "Claude Fable 5.2",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Fable 5.2",
    },
    {
      value: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Opus 5.5",
    },
    {
      value: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Sonnet 5.5",
    },
    {
      value: "claude-haiku-5-5",
      label: "Claude Haiku 5.5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Haiku 5.5",
    },
    {
      value: "claude-fable-5-1",
      label: "Claude Fable 5.1",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Fable 5.1",
    },
    {
      value: "claude-opus-5",
      label: "Claude Opus 5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Opus 5",
    },
    {
      value: "claude-fable-5",
      label: "Claude Fable 5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Fable 5",
    },
    {
      value: "claude-opus-4-8",
      label: "Claude Opus 4.8",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Opus 4.8",
    },
    {
      value: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Sonnet 5",
    },
    {
      value: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Haiku 4.5",
    },
    {
      value: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Opus 4.7",
    },
    {
      value: "claude-opus-4-6",
      label: "Claude Opus 4.6",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Opus 4.6",
    },
    {
      value: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Sonnet 4.6",
    },
    {
      value: "claude-opus-4-5",
      label: "Claude Opus 4.5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Opus 4.5",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "",
      showEndpoint: false,
      displayName: "Custom Claude",
      custom: true,
    },
  ],
  minimax: [
    {
      value: "minimax/MiniMax-M3.1-Flash",
      label: "MiniMax M3.1 Flash",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: false,
      displayName: "MiniMax M3.1 Flash",
    },
    {
      value: "minimax/MiniMax-M3",
      label: "MiniMax M3",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: false,
      displayName: "MiniMax M3",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: false,
      displayName: "Custom MiniMax",
      custom: true,
    },
  ],
  xai: [
    {
      value: "xai/grok-4.7",
      label: "Grok 4.7",
      endpoint: "https://api.x.ai",
      showEndpoint: false,
      displayName: "Grok 4.7",
    },
    {
      value: "xai/grok-4.6",
      label: "Grok 4.6",
      endpoint: "https://api.x.ai",
      showEndpoint: false,
      displayName: "Grok 4.6",
    },
    {
      value: "xai/grok-4.5",
      label: "Grok 4.5",
      endpoint: "https://api.x.ai",
      showEndpoint: false,
      displayName: "Grok 4.5",
    },
    {
      value: "xai/grok-4.3",
      label: "Grok 4.3",
      endpoint: "https://api.x.ai",
      showEndpoint: false,
      displayName: "Grok 4.3",
    },
    {
      value: "xai/grok-4.20-0309-reasoning",
      label: "Grok 4.20 Reasoning",
      endpoint: "https://api.x.ai",
      showEndpoint: false,
      displayName: "Grok 4.20 Reasoning",
    },
    {
      value: "xai/grok-4.20-0309-non-reasoning",
      label: "Grok 4.20 Non-Reasoning",
      endpoint: "https://api.x.ai",
      showEndpoint: false,
      displayName: "Grok 4.20 Non-Reasoning",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "https://api.x.ai",
      showEndpoint: false,
      displayName: "Custom Grok",
      custom: true,
    },
  ],
  kimi: [
    {
      value: "openai/kimi-k3.1-pro",
      label: "Kimi K3.1 Pro",
      endpoint: "https://api.moonshot.ai/v1",
      showEndpoint: false,
      displayName: "Kimi K3.1 Pro",
    },
    {
      value: "openai/kimi-k3.1-pro-highspeed",
      label: "Kimi K3.1 Pro Highspeed",
      endpoint: "https://api.moonshot.ai/v1",
      showEndpoint: false,
      displayName: "Kimi K3.1 Pro Highspeed",
    },
    {
      value: "openai/kimi-k3",
      label: "Kimi K3",
      endpoint: "https://api.moonshot.ai/v1",
      showEndpoint: false,
      displayName: "Kimi K3",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "https://api.moonshot.ai/v1",
      showEndpoint: false,
      displayName: "Custom Kimi",
      custom: true,
    },
  ],
  ollama: [
    {
      value: "ollama_chat/qwen3:1.7b",
      label: "Local Model · Qwen3 1.7B",
      endpoint: "http://127.0.0.1:11434",
      showEndpoint: true,
      displayName: "Local Model · Qwen3 1.7B",
    },
    {
      value: "ollama_chat/codellama:latest",
      label: "Code Llama",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Code Llama",
    },
    {
      value: "ollama_chat/deepseek-r1:latest",
      label: "DeepSeek R1",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "DeepSeek R1",
    },
    {
      value: "ollama_chat/gemma3:latest",
      label: "Gemma 3",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Gemma 3",
    },
    {
      value: "ollama_chat/glm-5.2:cloud",
      label: "GLM-5.2 Cloud",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "GLM-5.2 Cloud",
    },
    {
      value: "ollama_chat/gpt-oss:20b",
      label: "GPT-OSS 20B",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "GPT-OSS 20B",
    },
    {
      value: "ollama_chat/llama3.1:latest",
      label: "Llama 3.1",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Llama 3.1",
    },
    {
      value: "ollama_chat/llama3.2:latest",
      label: "Llama 3.2",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Llama 3.2",
    },
    {
      value: "ollama_chat/mistral:latest",
      label: "Mistral",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Mistral",
    },
    {
      value: "ollama_chat/phi4:latest",
      label: "Phi-4",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Phi-4",
    },
    {
      value: "ollama_chat/qwen2.5-coder:latest",
      label: "Qwen2.5 Coder",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Qwen2.5 Coder",
    },
    {
      value: "ollama_chat/qwen3:latest",
      label: "Qwen3",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Qwen3",
    },
    {
      value: "ollama_chat/qwen3-coder:latest",
      label: "Qwen3 Coder",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Qwen3 Coder",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "http://localhost:11434",
      showEndpoint: true,
      displayName: "Custom Ollama",
      custom: true,
    },
  ],
  other: [
    {
      value: LOCAL_DEMO_MODEL.model,
      label: LOCAL_DEMO_MODEL.label,
      endpoint: LOCAL_DEMO_MODEL.apiBase,
      showEndpoint: true,
      displayName: LOCAL_DEMO_MODEL.label,
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "",
      showEndpoint: true,
      displayName: "OpenAI-compatible API",
      custom: true,
    },
  ],
};

type FormState = {
  provider: ProviderId;
  profileLabel: string;
  model: string;
  customModel: string;
  apiKey: string;
  apiBase: string;
};

function providerLabel(provider: string): string {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}

/** Model preselected when a provider is picked. Falls back to the first listed model. */
const DEFAULT_MODEL: Partial<Record<ProviderId, string>> = {
  openai: "openai/gpt-6.2-sol",
  anthropic: "claude-opus-5-5",
  gemini: "gemini/gemini-3.1-pro-preview",
};

function formForProvider(provider: ProviderId): FormState {
  const options = MODEL_OPTIONS[provider];
  const option = options.find((item) => item.value === DEFAULT_MODEL[provider]) ?? options[0];
  return {
    provider,
    profileLabel: "",
    model: option.value,
    customModel: "",
    apiKey: "",
    apiBase: option.endpoint,
  };
}

function optionFor(provider: ProviderId, model: string): ModelOption {
  return (
    MODEL_OPTIONS[provider].find((option) => option.value === model) ??
    MODEL_OPTIONS[provider].find((option) => option.custom) ??
    MODEL_OPTIONS[provider][0]
  );
}

function optionLabelByValue(model: string): string {
  for (const provider of Object.values(MODEL_OPTIONS)) {
    const match = provider.find((option) => option.value === model);
    if (match) return match.label;
  }
  return model;
}

function displayLabelForProfile(profile: LlmProfile): string {
  const mapped = optionLabelByValue(profile.model);
  return mapped || profile.label;
}

function resolvedModelForForm(form: FormState): string {
  return optionFor(form.provider, form.model).custom ? form.customModel.trim() : form.model;
}

function formatConnectionError(provider: ProviderId, model: string, message: string): string {
  if (model === LOCAL_DEMO_MODEL.model) {
    return `Local demo model is not ready yet. Use Demo to download ${LOCAL_DEMO_MODEL.label} and start the bundled llama-server.`;
  }
  if (provider !== "ollama") return message;
  const lower = message.toLowerCase();
  const modelName = model.replace(/^ollama_chat\//, "");
  if (lower.includes("model") && lower.includes("not found")) {
    return `Ollama is running, but ${modelName} is not downloaded yet. Run "ollama pull ${modelName}" in Terminal, then try again.`;
  }
  if (
    lower.includes("connection refused") ||
    lower.includes("failed to connect") ||
    lower.includes("connection error") ||
    lower.includes("could not connect")
  ) {
    return `Ollama is not reachable at http://127.0.0.1:11434. Start Ollama, run "ollama pull ${modelName}", then try again.`;
  }
  return message;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes <= 0) return `${remainder}s left`;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s left`;
}

function localModelProgress(status: LocalModelStatus): string {
  if (status.error) return status.error;
  if (status.downloaded) return status.running ? `${status.label} is ready` : `${status.label} downloaded. Starting local server...`;
  const total = status.total_bytes || 0;
  const downloaded = status.bytes_downloaded || 0;
  const percent = total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : 0;
  const speed = status.speed_bps > 0 ? ` · ${formatBytes(status.speed_bps)}/s` : "";
  const eta = status.eta_seconds > 0 ? ` · ${formatDuration(status.eta_seconds)}` : "";
  return `Downloading ${status.label}: ${formatBytes(downloaded)} / ${formatBytes(total)} (${percent}%)${speed}${eta}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export type EmbeddedHeader = { title: string; onBack?: () => void; backDisabled?: boolean };

export function LlmConfigModal(props: {
  open: boolean;
  /** Render inside another panel (Settings → Models): no overlay, card chrome or close button. */
  embedded?: boolean;
  /** Open on the "Add a model" form even when saved models exist. */
  startInAdd?: boolean;
  /** Embedded only: reports the form view's title and back action so the host header can show them. */
  onHeaderChange?: (header: EmbeddedHeader | null) => void;
  onClose: () => void;
  onModelsChanged: (preferredModelId?: string) => Promise<void> | void;
}) {
  const [data, setData] = useState<LlmConfigsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string>(NEW_ID);
  const [form, setForm] = useState<FormState>(() => formForProvider("openai"));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [demoConnecting, setDemoConnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [view, setView] = useState<"list" | "form">("form");
  const [demoSelected, setDemoSelected] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);

  const selectedProfile = useMemo(
    () => data?.profiles.find((profile) => profile.id === selectedId) ?? null,
    [data, selectedId],
  );
  const readOnly = Boolean(selectedProfile?.read_only);
  const isEdit = Boolean(selectedProfile && !readOnly);
  const activeOption = optionFor(form.provider, form.model);
  const isCustomProvider = form.provider === "other";
  const usesCustomModelInput = activeOption.custom;
  const resolvedModel = resolvedModelForForm(form);
  const resolvedDisplayName =
    form.profileLabel.trim() || (activeOption.custom ? resolvedModel || activeOption.displayName : activeOption.displayName);
  const ActiveProviderLogo = PROVIDER_LOGO[form.provider];
  const confirmDisabled = readOnly || saving || (deletePending && !selectedProfile);

  async function loadConfigs() {
    setLoading(true);
    setError("");
    try {
      const response = await bff.llmConfigs();
      setData(response);
      setSelectedId(NEW_ID);
      setDemoSelected(false);
      setView(response.profiles.length > 0 && !props.startInAdd ? "list" : "form");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function showList(response: LlmConfigsResponse) {
    setSelectedId(NEW_ID);
    setDemoSelected(false);
    setDeletePending(false);
    setMessage("");
    setError("");
    setView(response.profiles.length > 0 ? "list" : "form");
  }

  function startAdd() {
    setSelectedId(NEW_ID);
    setDemoSelected(false);
    setForm(formForProvider("openai"));
    setMessage("");
    setError("");
    setView("form");
  }

  function startEdit(profileId: string) {
    setSelectedId(profileId);
    setDemoSelected(false);
    setView("form");
  }

  useEffect(() => {
    if (!props.open) return;
    loadConfigs();
    setDeletePending(false);
  }, [props.open]);

  useEffect(() => {
    if (!providerMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!providerMenuRef.current?.contains(event.target as Node)) setProviderMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProviderMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [providerMenuOpen]);

  useEffect(() => {
    if (!selectedProfile) {
      setForm(formForProvider("openai"));
      setMessage("");
      setError("");
      setDeletePending(false);
      return;
    }
    const provider = (["openai", "gemini", "zai", "anthropic", "minimax", "xai", "kimi", "ollama", "other"].includes(selectedProfile.provider)
      ? selectedProfile.provider
      : "other") as ProviderId;
    const fallback = optionFor(provider, selectedProfile.model);
    setForm({
      provider,
      profileLabel: selectedProfile.label,
      model: fallback.custom ? fallback.value : selectedProfile.model,
      customModel: fallback.custom ? selectedProfile.model : "",
      apiKey: "",
      apiBase: selectedProfile.api_base || fallback.endpoint,
    });
    setMessage("");
    setError("");
    setDeletePending(false);
  }, [selectedProfile]);

  // Embedded: the host panel owns the header, so tell it what this view should be titled.
  const { onHeaderChange } = props;
  const hasSavedProfiles = (data?.profiles.length ?? 0) > 0;
  useEffect(() => {
    if (!props.embedded || !onHeaderChange) return;
    if (view !== "form") {
      onHeaderChange(null);
      return;
    }
    onHeaderChange({
      title: selectedProfile ? "Edit model" : "Add a model",
      onBack: hasSavedProfiles && data ? () => showList(data) : undefined,
      backDisabled: saving,
    });
  }, [props.embedded, onHeaderChange, view, selectedProfile, hasSavedProfiles, data, saving]);

  useEffect(() => () => onHeaderChange?.(null), [onHeaderChange]);

  if (!props.open) return null;

  async function handleSave() {
    if (deletePending) {
      await handleConfirmDelete();
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      if (!resolvedModel) {
        setError("Custom model name is required");
        return;
      }
      const draftTest = await bff.testLlmDraft({
        profile_id: selectedProfile?.read_only ? undefined : selectedProfile?.id,
        provider: form.provider,
        model: resolvedModel,
        api_key: form.apiKey || undefined,
        api_base: form.apiBase || undefined,
      });
      if (!draftTest.ok) {
        setError(formatConnectionError(form.provider, resolvedModel, draftTest.message || "Connection failed"));
        return;
      }

      const payload = {
        model: resolvedModel,
        api_key: form.apiKey,
        api_base: form.apiBase,
      };
      let response: LlmConfigsResponse;
      if (isEdit && selectedProfile) {
        response = await bff.updateLlmConfig(selectedProfile.id, {
          label: resolvedDisplayName,
          ...payload,
          api_key: form.apiKey || undefined,
        });
      } else {
        response = await bff.createLlmConfig({
          label: resolvedDisplayName,
          provider: form.provider,
          model: resolvedModel,
          api_key: form.apiKey,
          api_base: form.apiBase,
          enabled: true,
          set_default: false,
        });
      }
      setData(response);
      const refreshedId =
        response.profiles.find((profile) => profile.model === resolvedModel && profile.provider === form.provider)?.id ??
        response.default_model_id;
      setForm((current) => ({ ...current, apiKey: "" }));
      toast.success(isEdit ? `${resolvedDisplayName} updated` : `${resolvedDisplayName} added`);
      showList(response);
      await props.onModelsChanged(refreshedId);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(profile: LlmProfile) {
    if (profile.read_only) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await bff.setDefaultLlmConfig(profile.id);
      setData(response);
      toast.success(`${displayLabelForProfile(profile)} is now the default`);
      await props.onModelsChanged(response.default_model_id);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    if (!selectedProfile || readOnly) return;
    setDeletePending(true);
    setError("");
    setMessage(`Delete ${displayLabelForProfile(selectedProfile)} from local settings? Cancel keeps the saved profile.`);
  }

  async function handleConfirmDelete() {
    if (!selectedProfile || readOnly) return;
    const profileName = displayLabelForProfile(selectedProfile);
    setDeleting(true);
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await bff.deleteLlmConfig(selectedProfile.id);
      setData(response);
      toast.success(`${profileName} deleted`);
      showList(response);
      await props.onModelsChanged(response.default_model_id || response.profiles[0]?.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
      setSaving(false);
    }
  }

  function handleCancel() {
    if (deletePending) {
      setDeletePending(false);
      setDeleting(false);
      setMessage("");
      setError("");
      return;
    }
    if (data && data.profiles.length > 0) {
      showList(data);
      return;
    }
    props.onClose();
  }

  async function handleConnectDemoModel() {
    setDemoConnecting(true);
    setSaving(true);
    setError("");
    setMessage("");
    try {
      setForm({
        provider: LOCAL_DEMO_MODEL.provider,
        profileLabel: LOCAL_DEMO_MODEL.label,
        model: LOCAL_DEMO_MODEL.model,
        customModel: "",
        apiKey: "",
        apiBase: LOCAL_DEMO_MODEL.apiBase,
      });
      setSelectedId(NEW_ID);

      const currentStatus = await bff.localModelStatus();
      if (!currentStatus.downloaded && !currentStatus.downloading) {
        const confirmed = window.confirm(
          `Download ${LOCAL_DEMO_MODEL.label} (${LOCAL_DEMO_MODEL.sizeLabel}) for local demo mode?`,
        );
        if (!confirmed) {
          setMessage("Demo model download cancelled");
          return;
        }
      }

      let setup = await bff.setupLocalModel();
      let status = setup.status;
      setMessage(localModelProgress(status));
      while (!setup.ok) {
        if (status.error) {
          throw new Error(status.error);
        }
        await sleep(1500);
        status = await bff.localModelStatus();
        setMessage(localModelProgress(status));
        if (status.downloaded && !status.downloading) {
          setup = await bff.setupLocalModel();
          status = setup.status;
          setMessage(localModelProgress(status));
        }
      }

      const response = setup.configs;
      if (!response) {
        throw new Error("Local model setup finished without refreshed LLM config");
      }
      const connectedProfile =
        response.profiles.find(
          (profile) =>
            profile.provider === LOCAL_DEMO_MODEL.provider &&
            profile.model === LOCAL_DEMO_MODEL.model &&
            profile.api_base === LOCAL_DEMO_MODEL.apiBase,
        ) ?? response.profiles.find((profile) => profile.id === response.default_model_id);
      setData(response);
      setForm((current) => ({ ...current, apiKey: "" }));
      toast.success(`${LOCAL_DEMO_MODEL.label} connected and set as default`);
      showList(response);
      await props.onModelsChanged(connectedProfile?.id ?? response.default_model_id);
    } catch (err) {
      setError(String(err));
    } finally {
      setDemoConnecting(false);
      setSaving(false);
    }
  }

  const profiles = data?.profiles ?? [];
  const canGoBack = view === "form" && profiles.length > 0;
  const keyOptional = ["ollama", "other"].includes(form.provider);
  const inputClass =
    "h-11 w-full rounded-xl border border-line bg-card px-3.5 text-[14px] text-ink outline-none transition focus:border-accent disabled:bg-surface disabled:text-muted";
  const labelClass = "text-[12.5px] font-medium text-muted";
  const title = view === "list" ? "Models" : selectedProfile ? "Edit model" : "Add a model";

  return (
    <div
      className={cn(
        props.embedded
          ? "flex min-h-0 flex-1 flex-col"
          : "fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,16,12,0.32)] p-4 backdrop-blur-sm",
      )}
      onMouseDown={(event) => {
        if (!props.embedded && event.target === event.currentTarget && !saving) props.onClose();
      }}
    >
      <div
        className={cn(
          "relative flex flex-col overflow-hidden",
          props.embedded
            ? "min-h-0 flex-1"
            : "max-h-[90vh] w-full max-w-[480px] rounded-[24px] border border-line bg-card shadow-[0_32px_100px_rgba(11,18,14,0.18)]",
        )}
      >
        {!props.embedded && (
        <header className={cn("flex items-center gap-2 px-6 pb-2", props.embedded ? "pt-4" : "pt-5")}>
          {canGoBack && (
            <button
              type="button"
              onClick={() => data && showList(data)}
              disabled={saving}
              title="Back to models"
              aria-label="Back to models"
              className="-ml-2 flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-hover hover:text-ink disabled:opacity-45"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 className={cn("flex-1 font-semibold tracking-[-0.01em] text-ink", props.embedded ? "text-[15px]" : "text-[18px]")}>{title}</h2>
          {!props.embedded && (
          <button
            type="button"
            onClick={props.onClose}
            title="Close"
            aria-label="Close"
            className="-mr-2 flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
          )}
        </header>
        )}

        {view === "list" ? (
          <div className={cn("flex flex-col gap-2 px-6 pb-6", props.embedded ? "pt-4" : "pt-2", SCROLLBAR)}>
            {loading && (
              <span className="inline-flex items-center gap-2 py-2 text-[13px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading models…
              </span>
            )}
            {profiles.map((profile) => {
              const isDefault = data?.default_model_id === profile.id;
              const isDemo = profile.model === LOCAL_DEMO_MODEL.model && profile.api_base === LOCAL_DEMO_MODEL.apiBase;
              const Logo = isDemo ? Sparkles : PROVIDER_LOGO[(profile.provider as ProviderId)] ?? KeyRound;
              return (
                <div
                  key={profile.id}
                  className="group flex items-center gap-3 rounded-2xl border border-line px-3.5 py-3 transition hover:bg-hover"
                >
                  <button
                    type="button"
                    onClick={() => startEdit(profile.id)}
                    title={profile.read_only ? "View model" : "Edit model"}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-[6px]">
                      <Logo size={20} className={cn("h-5 w-5", isDemo && "text-accent")} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">{displayLabelForProfile(profile)}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {isDemo ? "Demo · runs on this computer" : `${providerLabel(profile.provider)} · ${optionLabelByValue(profile.model)}`}
                      </span>
                    </span>
                  </button>
                  {isDefault ? (
                    <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">Default</span>
                  ) : (
                    !profile.read_only && (
                      <button
                        type="button"
                        onClick={() => void handleSetDefault(profile)}
                        disabled={saving}
                        title="Use this model by default"
                        className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted opacity-0 transition hover:bg-card hover:text-ink group-hover:opacity-100 disabled:opacity-45"
                      >
                        Set default
                      </button>
                    )
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={startAdd}
              className="mt-1 flex items-center justify-center gap-2 rounded-2xl border border-dashed border-line px-4 py-3 text-[14px] font-medium text-muted transition hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
            >
              <Plus className="h-4 w-4" />
              Add a model
            </button>
          </div>
        ) : (
          <>
            <div className={cn("flex flex-col gap-4 px-6 pb-2", props.embedded ? "min-h-0 flex-1 pt-4" : "pt-2", SCROLLBAR)}>
              {readOnly && (
                <p className="text-[12.5px] leading-5 text-muted">
                  This model comes from server settings and can only be selected, not edited.
                </p>
              )}

              <div className="space-y-1.5">
                <span className={labelClass}>Provider</span>
                <div ref={providerMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => !readOnly && !isEdit && setProviderMenuOpen((value) => !value)}
                    disabled={readOnly || isEdit || saving}
                    className={cn(inputClass, "relative flex items-center gap-2.5 pr-10 text-left hover:bg-hover")}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px]">
                      {demoSelected ? <Sparkles className="h-4 w-4 text-accent" /> : <ActiveProviderLogo size={18} className="h-[18px] w-[18px]" />}
                    </span>
                    <span className="truncate">{demoSelected ? DEMO_PROVIDER_LABEL : providerLabel(form.provider)}</span>
                    <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  </button>
                  {providerMenuOpen && !readOnly && !isEdit && (
                    <div className="mt-1.5 overflow-hidden rounded-2xl border border-line bg-card p-1.5 shadow-[0_8px_24px_rgba(24,32,28,0.10)]">
                      <div className={cn("flex max-h-60 flex-col gap-0.5", SCROLLBAR)}>
                        <button
                          type="button"
                          onClick={() => {
                            setDemoSelected(true);
                            setError("");
                            setMessage("");
                            setProviderMenuOpen(false);
                          }}
                          className={cn(
                            "flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] transition",
                            demoSelected ? "bg-accent-soft text-accent" : "text-ink hover:bg-hover",
                          )}
                        >
                          <Sparkles className="h-[18px] w-[18px] shrink-0 text-accent" />
                          <span className="flex-1 truncate">{DEMO_PROVIDER_LABEL}</span>
                          {demoSelected && <Check className="h-4 w-4 shrink-0" />}
                        </button>
                        <div className="mx-2 my-0.5 h-px bg-line/70" />
                        {PROVIDERS.map((provider) => {
                          const Logo = PROVIDER_LOGO[provider.id];
                          const active = !demoSelected && provider.id === form.provider;
                          return (
                            <button
                              key={provider.id}
                              type="button"
                              onClick={() => {
                                setDemoSelected(false);
                                setForm(formForProvider(provider.id));
                                setError("");
                                setMessage("");
                                setProviderMenuOpen(false);
                              }}
                              className={cn(
                                "flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] transition",
                                active ? "bg-accent-soft text-accent" : "text-ink hover:bg-hover",
                              )}
                            >
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px]">
                                <Logo size={18} className="h-[18px] w-[18px]" />
                              </span>
                              <span className="flex-1 truncate">{provider.label}</span>
                              {active && <Check className="h-4 w-4 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {demoSelected ? (
                <p className="rounded-xl bg-surface px-3.5 py-3 text-[13px] leading-5 text-muted">
                  Runs on this computer — no API key needed. The first time, it downloads {LOCAL_DEMO_MODEL.sizeLabel}.
                  Good for trying AurigaSQL; answers are less accurate than hosted models.
                </p>
              ) : (
                <>
                  {activeOption.showEndpoint && (
                    <label className="block space-y-1.5">
                      <span className={labelClass}>API endpoint</span>
                      <input
                        value={form.apiBase}
                        onChange={(e) => setForm((current) => ({ ...current, apiBase: e.target.value }))}
                        disabled={readOnly}
                        className={inputClass}
                        placeholder={activeOption.endpoint || "https://…/v1"}
                      />
                      <p className="text-[12px] text-faint">
                        {isCustomProvider
                          ? "Base URL of an OpenAI-compatible API."
                          : "Change only if your provider runs somewhere else."}
                      </p>
                    </label>
                  )}

                  <label className="block space-y-1.5">
                    <span className={labelClass}>
                      API key{keyOptional && <span className="text-faint"> (optional)</span>}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={form.apiKey}
                      onChange={(e) => setForm((current) => ({ ...current, apiKey: e.target.value }))}
                      disabled={readOnly}
                      className={inputClass}
                      placeholder={selectedProfile?.api_key_masked ? "Saved — leave blank to keep it" : "Paste API key"}
                    />
                  </label>

                  {isCustomProvider && (
                    <label className="block space-y-1.5">
                      <span className={labelClass}>Display name</span>
                      <input
                        value={form.profileLabel}
                        onChange={(e) => setForm((current) => ({ ...current, profileLabel: e.target.value }))}
                        disabled={readOnly}
                        className={inputClass}
                        placeholder="Name shown in the model list"
                      />
                    </label>
                  )}

                  <label className="block space-y-1.5">
                    <span className={labelClass}>Model</span>
                    <div className="relative">
                      <select
                        value={form.model}
                        onChange={(e) => {
                          const next = optionFor(form.provider, e.target.value);
                          setForm((current) => ({
                            ...current,
                            model: next.value,
                            customModel: next.custom ? current.customModel : "",
                            apiBase: next.endpoint || current.apiBase,
                          }));
                        }}
                        disabled={readOnly}
                        className={cn(inputClass, "appearance-none pr-10")}
                      >
                        {MODEL_OPTIONS[form.provider].map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                    </div>
                  </label>

                  {usesCustomModelInput && (
                    <label className="block space-y-1.5">
                      <span className={labelClass}>Model ID</span>
                      <input
                        value={form.customModel}
                        onChange={(e) => setForm((current) => ({ ...current, customModel: e.target.value }))}
                        disabled={readOnly}
                        className={inputClass}
                        placeholder={CUSTOM_MODEL_PLACEHOLDER[form.provider]}
                      />
                    </label>
                  )}
                </>
              )}

              <div className="min-h-[20px] text-[12.5px] leading-5">
                {loading && (
                  <span className="inline-flex items-center gap-2 text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading models…
                  </span>
                )}
                {!loading && error && <span className="text-danger">{error}</span>}
                {!loading && !error && message && <span className={deletePending ? "text-danger" : "text-accent"}>{message}</span>}
              </div>
            </div>

            <footer className="flex items-center gap-2 border-t border-line/70 px-6 py-4">
              {selectedProfile && !readOnly && !deletePending && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={saving}
                  title="Delete this model"
                  aria-label="Delete this model"
                  className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full text-faint transition hover:bg-danger-soft hover:text-danger disabled:opacity-45"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving && !deletePending}
                className="rounded-full px-4 py-2 text-[13.5px] font-medium text-muted transition hover:bg-hover hover:text-ink disabled:opacity-45"
              >
                Cancel
              </button>
              {!readOnly && (
                <button
                  type="button"
                  onClick={demoSelected ? () => void handleConnectDemoModel() : () => void handleSave()}
                  disabled={confirmDisabled || loading}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13.5px] font-medium text-white transition hover:opacity-90 disabled:opacity-45",
                    deletePending ? "bg-danger" : "bg-invert",
                  )}
                >
                  {(saving || demoConnecting || deleting) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {deletePending ? "Delete" : demoSelected ? "Connect demo" : selectedProfile ? "Save" : "Connect"}
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
