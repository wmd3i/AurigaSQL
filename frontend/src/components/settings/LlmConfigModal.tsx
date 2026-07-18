import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Anthropic, Gemini, Minimax, Ollama, OpenAI, XAI, ZAI } from "@lobehub/icons";
import { Check, ChevronDown, KeyRound, Loader2, Plus, Settings2, Sparkles, Trash2, X } from "lucide-react";
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

type ProviderId = "openai" | "gemini" | "zai" | "anthropic" | "minimax" | "xai" | "ollama" | "other";

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
  { id: "other", label: "Custom API" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
  { id: "minimax", label: "MiniMax" },
  { id: "ollama", label: "Ollama" },
  { id: "openai", label: "OpenAI" },
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
  ollama: Ollama.Avatar,
  other: KeyRound,
};

const MODEL_OPTIONS: Record<ProviderId, ModelOption[]> = {
  openai: [
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
      value: "openai/gpt-5.4-nano",
      label: "GPT-5.4 Nano",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.4 Nano",
    },
    {
      value: "openai/gpt-5.3-chat-latest",
      label: "GPT-5.3 Chat",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.3 Chat",
    },
    {
      value: "openai/gpt-5.2",
      label: "GPT-5.2",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.2",
    },
    {
      value: "openai/gpt-5.2-pro",
      label: "GPT-5.2 Pro",
      endpoint: "",
      showEndpoint: false,
      displayName: "GPT-5.2 Pro",
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
      value: "gemini/gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3.5 Flash",
    },
    {
      value: "gemini/gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3.1 Pro",
    },
    {
      value: "gemini/gemini-3-pro-preview",
      label: "Gemini 3 Pro",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 3 Pro",
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
      value: "gemini/gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 2.5 Pro",
    },
    {
      value: "gemini/gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 2.5 Flash",
    },
    {
      value: "gemini/gemini-2.5-flash-lite",
      label: "Gemini 2.5 Flash-Lite",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 2.5 Flash-Lite",
    },
    {
      value: "gemini/gemini-2.5-computer-use-preview-10-2025",
      label: "Gemini 2.5 Computer Use",
      endpoint: "",
      showEndpoint: false,
      displayName: "Gemini 2.5 Computer Use",
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
      value: "openai/glm-5.2",
      label: "GLM-5.2",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-5.2",
    },
    {
      value: "openai/glm-5.1",
      label: "GLM-5.1",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-5.1",
    },
    {
      value: "openai/glm-5",
      label: "GLM-5",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-5",
    },
    {
      value: "openai/glm-4.7",
      label: "GLM-4.7",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-4.7",
    },
    {
      value: "openai/glm-4.6",
      label: "GLM-4.6",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-4.6",
    },
    {
      value: "openai/glm-4.5-air",
      label: "GLM-4.5 Air",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-4.5 Air",
    },
    {
      value: "openai/glm-4.5",
      label: "GLM-4.5",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-4.5",
    },
    {
      value: "openai/glm-4.6v",
      label: "GLM-4.6V",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-4.6V",
    },
    {
      value: "openai/glm-4.5v",
      label: "GLM-4.5V",
      endpoint: "https://api.z.ai/api/coding/paas/v4",
      showEndpoint: true,
      displayName: "GLM-4.5V",
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
      value: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      endpoint: "",
      showEndpoint: false,
      displayName: "Claude Sonnet 4.5",
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
      value: "minimax/MiniMax-M3",
      label: "MiniMax M3",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: true,
      displayName: "MiniMax M3",
    },
    {
      value: "minimax/MiniMax-M2.5",
      label: "MiniMax M2.5",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: true,
      displayName: "MiniMax M2.5",
    },
    {
      value: "minimax/MiniMax-M2.5-lightning",
      label: "MiniMax M2.5 Lightning",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: true,
      displayName: "MiniMax M2.5 Lightning",
    },
    {
      value: "minimax/MiniMax-M2.1",
      label: "MiniMax M2.1",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: true,
      displayName: "MiniMax M2.1",
    },
    {
      value: "minimax/MiniMax-M2.1-lightning",
      label: "MiniMax M2.1 Lightning",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: true,
      displayName: "MiniMax M2.1 Lightning",
    },
    {
      value: "minimax/MiniMax-M2",
      label: "MiniMax M2",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: true,
      displayName: "MiniMax M2",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "https://api.minimax.io/v1",
      showEndpoint: true,
      displayName: "Custom MiniMax",
      custom: true,
    },
  ],
  xai: [
    {
      value: "xai/grok-4.5",
      label: "Grok 4.5",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 4.5",
    },
    {
      value: "xai/grok-4.3",
      label: "Grok 4.3",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 4.3",
    },
    {
      value: "xai/grok-4.20-0309-reasoning",
      label: "Grok 4.20 Reasoning",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 4.20 Reasoning",
    },
    {
      value: "xai/grok-4.20-beta-0309-non-reasoning",
      label: "Grok 4.20 Non-Reasoning",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 4.20 Non-Reasoning",
    },
    {
      value: "xai/grok-4-1-fast-reasoning",
      label: "Grok 4.1 Fast Reasoning",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 4.1 Fast Reasoning",
    },
    {
      value: "xai/grok-4-1-fast-non-reasoning",
      label: "Grok 4.1 Fast Non-Reasoning",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 4.1 Fast Non-Reasoning",
    },
    {
      value: "xai/grok-4",
      label: "Grok 4",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 4",
    },
    {
      value: "xai/grok-code-fast-1",
      label: "Grok Code Fast 1",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok Code Fast 1",
    },
    {
      value: "xai/grok-3-mini",
      label: "Grok 3 Mini",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Grok 3 Mini",
    },
    {
      value: CUSTOM_MODEL_VALUE,
      label: "Custom model",
      endpoint: "https://api.x.ai",
      showEndpoint: true,
      displayName: "Custom Grok",
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
      displayName: "Custom API",
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

function profileBadges(profile: LlmProfile, isDefault: boolean): string[] {
  const labels: string[] = [];
  if (isDefault) labels.push("Default");
  if (profile.read_only) labels.push("Read-only");
  if (!profile.enabled) labels.push("Disabled");
  if (profile.enabled && !profile.available) labels.push(["ollama", "other"].includes(profile.provider) ? "Needs endpoint" : "Needs key");
  return labels;
}

function providerLabel(provider: string): string {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}

function formForProvider(provider: ProviderId): FormState {
  const option = MODEL_OPTIONS[provider][0];
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

export function LlmConfigModal(props: {
  open: boolean;
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

  async function loadConfigs(preferredId?: string) {
    setLoading(true);
    setError("");
    try {
      const response = await bff.llmConfigs();
      setData(response);
      const nextId =
        preferredId && response.profiles.some((profile) => profile.id === preferredId)
          ? preferredId
          : response.profiles[0]?.id ?? NEW_ID;
      setSelectedId(nextId);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!props.open) return;
    loadConfigs(selectedId === NEW_ID ? undefined : selectedId);
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
    const provider = (["openai", "gemini", "zai", "anthropic", "minimax", "xai", "ollama", "other"].includes(selectedProfile.provider)
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
      setSelectedId(refreshedId || NEW_ID);
      setForm((current) => ({ ...current, apiKey: "" }));
      setMessage(isEdit ? "Connection verified and model updated" : "Connection verified and model added");
      await props.onModelsChanged(refreshedId);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault() {
    if (!selectedProfile || readOnly) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await bff.setDefaultLlmConfig(selectedProfile.id);
      setData(response);
      setMessage("Default model updated");
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
      const nextId =
        (response.default_model_id && response.profiles.some((profile) => profile.id === response.default_model_id)
          ? response.default_model_id
          : response.profiles[0]?.id) ?? NEW_ID;
      setSelectedId(nextId);
      setMessage(`${profileName} deleted`);
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
      setSelectedId(connectedProfile?.id ?? response.default_model_id ?? NEW_ID);
      setForm((current) => ({ ...current, apiKey: "" }));
      setMessage(`${LOCAL_DEMO_MODEL.label} connected and set as default`);
      await props.onModelsChanged(connectedProfile?.id ?? response.default_model_id);
    } catch (err) {
      setError(String(err));
    } finally {
      setDemoConnecting(false);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(12,16,12,0.32)] p-4 backdrop-blur-sm">
      <div className="relative flex h-[min(760px,94vh)] w-full max-w-6xl overflow-hidden rounded-[34px] border border-line bg-[#fbfbf8] shadow-[0_32px_100px_rgba(11,18,14,0.18)]">
        <button
          type="button"
          onClick={props.onClose}
          className="absolute right-10 top-7 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-card text-muted transition hover:bg-hover hover:text-ink"
        >
          <X className="h-6 w-6" />
        </button>
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-line/80 bg-[linear-gradient(180deg,#f5f8f1_0%,#fbfbf8_100%)] p-6">
          <div className="mb-5">
            <div className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
              <Settings2 className="h-3.5 w-3.5" />
              LLM Configure
            </div>
          </div>

          <p className="mb-6 text-[13px] leading-6 text-muted">
            Manage local model profiles for this app instance.
          </p>

          <button
            type="button"
            onClick={() => setSelectedId(NEW_ID)}
            className={cn(
              "mb-3 inline-flex items-center justify-center gap-2 rounded-[24px] border px-4 py-3 text-[14px] font-medium transition",
              selectedId === NEW_ID
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-card text-ink hover:bg-hover",
            )}
          >
            <Plus className="h-4 w-4" />
            Add Model
          </button>

          <button
            type="button"
            onClick={handleConnectDemoModel}
            disabled={saving || loading}
            title="Connect local Qwen demo model"
            className="mb-4 inline-flex items-center justify-center gap-2 rounded-[24px] border border-accent/60 bg-accent-soft px-4 py-3 text-[14px] font-medium text-accent transition hover:bg-accent-soft/80 disabled:opacity-45"
          >
            {demoConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Demo
          </button>

          <div className={cn("min-h-0 flex-1 space-y-2 pr-1", SCROLLBAR)}>
            {(data?.profiles ?? []).map((profile) => {
              const active = profile.id === selectedId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => setSelectedId(profile.id)}
                  className={cn(
                    "w-full rounded-[22px] border p-3 text-left transition",
                    active
                      ? "border-accent/60 bg-accent-soft/70 shadow-sm"
                      : "border-line bg-card hover:bg-hover",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-semibold text-ink">{displayLabelForProfile(profile)}</div>
                      <div className="mt-1 truncate text-[12px] text-muted">
                        {providerLabel(profile.provider)} · {optionLabelByValue(profile.model)}
                      </div>
                    </div>
                    {data?.default_model_id === profile.id && (
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {profileBadges(profile, data?.default_model_id === profile.id).map((badge) => (
                      <span
                        key={badge}
                        className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted"
                      >
                        {badge}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className={cn("flex min-w-0 flex-1 flex-col p-10", SCROLLBAR)}>
          <div className="mb-8 flex items-start justify-between gap-4 border-b border-line/80 pb-6">
            <div>
              <h2 className="text-[24px] font-semibold tracking-[-0.03em] text-ink">
                {selectedProfile ? "Edit Model" : "Add Model"}
              </h2>
              <p className="mt-2 text-[14px] leading-6 text-muted">
                {readOnly
                  ? "This model comes from server env fallback and is visible here for selection only."
                  : "Choose a provider, paste the API key, and pick the model you want to use."}
              </p>
            </div>
          </div>

          <div className="max-w-3xl space-y-7">
            <label className="block space-y-3">
              <span className="text-[13px] font-medium text-[#526074]">
                <span className="mr-1 text-[#ff5f56]">*</span>
                Model Provider
              </span>
              <div ref={providerMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => !readOnly && !isEdit && setProviderMenuOpen((value) => !value)}
                  disabled={readOnly || isEdit}
                  className="flex h-16 w-full items-center gap-4 rounded-[18px] border border-line bg-card px-6 pr-14 text-left text-[16px] text-ink outline-none transition hover:bg-hover disabled:bg-surface"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-[6px]">
                    <ActiveProviderLogo size={22} className="h-5 w-5" />
                  </span>
                  <span className="truncate">{providerLabel(form.provider)}</span>
                  <ChevronDown className="pointer-events-none absolute right-5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
                </button>
                {providerMenuOpen && !readOnly && !isEdit && (
                  <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-[20px] border border-line bg-card p-2 shadow-[0_18px_40px_rgba(24,32,28,0.14)]">
                    <div className={cn("flex max-h-72 flex-col gap-1", SCROLLBAR)}>
                      {PROVIDERS.map((provider) => {
                        const Logo = PROVIDER_LOGO[provider.id];
                        const active = provider.id === form.provider;
                        return (
                          <button
                            key={provider.id}
                            type="button"
                            onClick={() => {
                              setForm(formForProvider(provider.id));
                              setProviderMenuOpen(false);
                            }}
                            className={cn(
                              "flex items-center gap-3 rounded-2xl px-4 py-3 text-left text-[16px] transition",
                              active ? "bg-accent-soft text-accent" : "text-ink hover:bg-hover",
                            )}
                          >
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-[6px]">
                              <Logo size={22} className="h-5 w-5" />
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
            </label>

            {activeOption.showEndpoint && (
              <label className="block space-y-3">
                <span className="text-[13px] font-medium text-[#526074]">API Endpoint</span>
                <input
                  value={form.apiBase}
                  onChange={(e) => setForm((current) => ({ ...current, apiBase: e.target.value }))}
                  disabled={readOnly}
                  className="h-16 w-full rounded-[18px] border border-line bg-card px-6 text-[16px] text-ink outline-none transition focus:border-accent disabled:bg-surface"
                  placeholder={activeOption.endpoint}
                />
                <p className="text-[12px] text-muted">
                  {isCustomProvider
                    ? "Enter a base URL for OpenAI-compatible custom providers. Leave blank for default provider endpoints."
                    : "Default endpoint is prefilled. Change this only if your provider runs somewhere else."}
                </p>
              </label>
            )}

            <label className="block space-y-3">
              <span className="text-[13px] font-medium text-[#526074]">
                {!["ollama", "other"].includes(form.provider) && <span className="mr-1 text-[#ff5f56]">*</span>}
                API Key
              </span>
              <input
                value={form.apiKey}
                onChange={(e) => setForm((current) => ({ ...current, apiKey: e.target.value }))}
                disabled={readOnly}
                className="h-16 w-full rounded-[18px] border border-line bg-card px-6 text-[16px] text-ink outline-none transition focus:border-accent disabled:bg-surface"
                placeholder={
                  form.provider === "ollama"
                    ? "Optional for local Ollama"
                    : form.provider === "other"
                      ? "Leave blank only for local models or endpoints that do not require an API key."
                    : selectedProfile?.api_key_masked
                      ? "Key already saved"
                      : "Paste API key"
                }
              />
              {selectedProfile?.api_key_masked && !readOnly && (
                <p className="text-[12px] text-muted">Leave this blank if you want to keep the saved key.</p>
              )}
            </label>

            {isCustomProvider && (
              <label className="block space-y-3">
                <span className="text-[13px] font-medium text-[#526074]">Display Name</span>
                <input
                  value={form.profileLabel}
                  onChange={(e) => setForm((current) => ({ ...current, profileLabel: e.target.value }))}
                  disabled={readOnly}
                  className="h-16 w-full rounded-[18px] border border-line bg-card px-6 text-[16px] text-ink outline-none transition focus:border-accent disabled:bg-surface"
                  placeholder="Name shown in the model list"
                />
              </label>
            )}

            <label className="block space-y-3">
              <span className="text-[13px] font-medium text-[#526074]">
                <span className="mr-1 text-[#ff5f56]">*</span>
                Model Name
              </span>
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
                  className="h-16 w-full appearance-none rounded-[18px] border border-line bg-card px-6 pr-14 text-[16px] text-ink outline-none transition focus:border-accent disabled:bg-surface"
                >
                  {MODEL_OPTIONS[form.provider].map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
              </div>
            </label>

            {usesCustomModelInput && (
              <label className="block space-y-3">
                <span className="text-[13px] font-medium text-[#526074]">
                  <span className="mr-1 text-[#ff5f56]">*</span>
                  Model ID
                </span>
                <input
                  value={form.customModel}
                  onChange={(e) => setForm((current) => ({ ...current, customModel: e.target.value }))}
                  disabled={readOnly}
                  className="h-16 w-full rounded-[18px] border border-line bg-card px-6 text-[16px] text-ink outline-none transition focus:border-accent disabled:bg-surface"
                  placeholder={
                    form.provider === "other"
                      ? "Example: openai/gpt-4o or openai/your-model-name"
                      : form.provider === "openai"
                      ? "openai/gpt-5.5"
                      : form.provider === "gemini"
                        ? "gemini/gemini-3.5-flash"
                        : form.provider === "zai"
                          ? "openai/glm-5.2"
                          : form.provider === "anthropic"
                            ? "claude-opus-4-8"
                            : form.provider === "minimax"
                              ? "minimax/MiniMax-M3"
                              : form.provider === "xai"
                                ? "xai/grok-4.5"
                                : "ollama_chat/glm-5.2:cloud"
                  }
                />
              </label>
            )}

          </div>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-4 border-t border-line/80 pt-8">
            <div className="min-h-[24px] flex-1 text-[13px]">
              {loading && (
                <span className="inline-flex items-center gap-2 text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading models…
                </span>
              )}
              {!loading && error && <span className="text-danger">{error}</span>}
              {!loading && !error && message && <span className="text-accent">{message}</span>}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {selectedProfile && !readOnly && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={saving || deletePending}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-[18px] border px-6 py-3 text-[14px] text-danger transition disabled:opacity-45",
                    deletePending ? "border-danger bg-danger-soft" : "border-danger/30 bg-card hover:bg-danger/5",
                  )}
                >
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Delete
                </button>
              )}
              {selectedProfile && data?.default_model_id !== selectedProfile.id && !readOnly && !deletePending && (
                <button
                  type="button"
                  onClick={handleSetDefault}
                  disabled={saving}
                  className="inline-flex items-center rounded-[18px] border border-line bg-card px-6 py-3 text-[14px] text-ink transition hover:bg-hover disabled:opacity-45"
                >
                  Set as default
                </button>
              )}
              {deletePending && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={saving}
                  className="inline-flex items-center rounded-[18px] border border-line bg-card px-6 py-3 text-[14px] text-ink transition hover:bg-hover disabled:opacity-45"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={confirmDisabled}
                className={cn(
                  "inline-flex items-center rounded-[18px] px-6 py-3 text-[14px] font-medium text-white transition hover:opacity-92 disabled:opacity-45",
                  deletePending ? "bg-danger" : "bg-[#2f3b4f]",
                )}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                <span className={cn(saving && "ml-2")}>{deletePending ? "Confirm Delete" : "Confirm"}</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
