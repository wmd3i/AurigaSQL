const DEFAULT_BFF_BASE = "http://127.0.0.1:6003";

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BFF_BASE;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export const BFF_BASE = normalizeBaseUrl(
  window.aurigaDesktop?.backendBase || import.meta.env.VITE_BFF_BASE_URL,
);

type Validator<T> = (value: unknown) => T;
type JsonFetchInit = RequestInit & { json?: unknown; timeoutMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatPayloadPreview(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Backend returned invalid JSON: ${String(error)} :: ${text.slice(0, 200)}`);
  }
}

export async function jsonFetch<T>(
  path: string,
  init?: JsonFetchInit,
  validate?: Validator<T>,
): Promise<T> {
  const { json, timeoutMs, ...requestInit } = init ?? {};
  const externalSignal = requestInit.signal;
  const controller = new AbortController();
  let didTimeout = false;
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
  }
  const timeoutId =
    timeoutMs && timeoutMs > 0
      ? window.setTimeout(() => {
          didTimeout = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  const opts: RequestInit = {
    ...requestInit,
    headers: { "Content-Type": "application/json", ...(requestInit.headers ?? {}) },
    signal: controller.signal,
  };
  if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.method = opts.method ?? "POST";
  }
  try {
    const r = await fetch(`${BFF_BASE}${path}`, opts);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
    }
    const text = await r.text();
    const payload = parseJson(text);
    if (!validate) return payload as T;
    try {
      return validate(payload);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : `Unexpected response: ${formatPayloadPreview(payload)}`;
      throw new Error(`Backend response shape mismatch for ${path}: ${detail}`);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError" && didTimeout && timeoutMs) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${path}`);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternalSignal);
  }
}

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

export function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

export function expectLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

export function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => expectString(item, `${label}[${index}]`));
}

export function expectArray<T>(
  value: unknown,
  label: string,
  mapItem: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => mapItem(item, index));
}
