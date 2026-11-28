import type { DataEngine } from "../api/bff";

export type PostgresSslMode =
  | "disable"
  | "allow"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full";

export const VALID_SSL_MODES: readonly PostgresSslMode[] = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
];

export type ParsedConnectionUri = {
  engine: DataEngine;
  name: string;
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
  sslmode?: PostgresSslMode;
  path?: string;
};

export type ParseConnectionUriResult =
  | { ok: true; value: ParsedConnectionUri }
  | { ok: false; error: string };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSslMode(value: string): value is PostgresSslMode {
  return (VALID_SSL_MODES as readonly string[]).includes(value);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function deriveNameFromPath(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  return fileName.replace(/\.(duckdb|sqlite3?|db)$/i, "") || fileName;
}

function parseLocalSchemeUri(
  raw: string,
  engine: Extract<DataEngine, "sqlite" | "duckdb">,
): ParseConnectionUriResult {
  const prefix = `${engine}://`;
  const rest = raw.slice(prefix.length);
  if (!rest.startsWith("/")) {
    return {
      ok: false,
      error: `${engine.toUpperCase()} URI must use an absolute path (${engine}:///path/to/file).`,
    };
  }
  const queryIdx = rest.indexOf("?");
  const hashIdx = rest.indexOf("#");
  if (queryIdx !== -1 || hashIdx !== -1) {
    return {
      ok: false,
      error: `${engine.toUpperCase()} file URIs do not support query parameters.`,
    };
  }
  const filePath = safeDecode(rest);
  if (!filePath || filePath === "/") {
    return { ok: false, error: `${engine.toUpperCase()} URI is missing a file path.` };
  }
  return {
    ok: true,
    value: {
      engine,
      path: filePath,
      name: deriveNameFromPath(filePath),
    },
  };
}

/**
 * Parses a database connection URI or local database path into AurigaSQL connection fields.
 */
export function parseConnectionUri(
  rawInput: string,
  preferredLocalEngine?: Extract<DataEngine, "sqlite" | "duckdb">,
): ParseConnectionUriResult {
  const raw = rawInput.trim();
  if (!raw) {
    return { ok: false, error: "Paste a connection URL or local file path first." };
  }

  if (/^duckdb:\/\//i.test(raw)) {
    return parseLocalSchemeUri(raw, "duckdb");
  }

  if (/^sqlite:\/\//i.test(raw)) {
    return parseLocalSchemeUri(raw, "sqlite");
  }

  if (/^(\/|~\/|[a-zA-Z]:[\\/])/.test(raw) && !raw.includes("://")) {
    const lower = raw.toLowerCase();
    const engine: DataEngine = lower.endsWith(".duckdb")
      ? "duckdb"
      : lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")
        ? "sqlite"
        : (preferredLocalEngine ?? "sqlite");
    return {
      ok: true,
      value: {
        engine,
        path: raw,
        name: deriveNameFromPath(raw),
      },
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      error: "Invalid URL format. Example: postgresql://user:pass@127.0.0.1:5433/db?sslmode=disable",
    };
  }

  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (protocol === "postgres" || protocol === "postgresql") {
    const host = stripIpv6Brackets(parsed.hostname.trim());
    if (!host) {
      return { ok: false, error: "PostgreSQL URL must include a host." };
    }
    const unsupportedParams: string[] = [];
    let sslmode: PostgresSslMode | undefined;
    for (const [key, val] of parsed.searchParams.entries()) {
      if (key === "sslmode") {
        const normalized = val.trim().toLowerCase();
        if (!isSslMode(normalized)) {
          return {
            ok: false,
            error: `Unsupported sslmode "${val}". Supported: ${VALID_SSL_MODES.join(", ")}.`,
          };
        }
        sslmode = normalized;
      } else {
        unsupportedParams.push(key);
      }
    }
    if (unsupportedParams.length > 0) {
      return {
        ok: false,
        error: `Unsupported PostgreSQL query parameter(s): ${unsupportedParams.join(", ")}.`,
      };
    }

    const port = parsed.port || "5432";
    const database = safeDecode(parsed.pathname.replace(/^\/+/, ""));
    const username = safeDecode(parsed.username);
    const password = safeDecode(parsed.password);
    return {
      ok: true,
      value: {
        engine: "postgres",
        name: database || host,
        host,
        port,
        database,
        username,
        password,
        sslmode,
      },
    };
  }

  if (protocol === "mysql") {
    const host = stripIpv6Brackets(parsed.hostname.trim());
    if (!host) {
      return { ok: false, error: "MySQL URL must include a host." };
    }
    const queryKeys = [...parsed.searchParams.keys()];
    if (queryKeys.length > 0) {
      return {
        ok: false,
        error: `Unsupported MySQL query parameter(s): ${queryKeys.join(", ")}.`,
      };
    }
    const port = parsed.port || "3306";
    const database = safeDecode(parsed.pathname.replace(/^\/+/, ""));
    const username = safeDecode(parsed.username);
    const password = safeDecode(parsed.password);
    return {
      ok: true,
      value: {
        engine: "mysql",
        name: database || host,
        host,
        port,
        database,
        username,
        password,
      },
    };
  }

  return {
    ok: false,
    error: `Unsupported scheme "${protocol}". Supported: postgresql://, mysql://, sqlite:///, duckdb:///.`,
  };
}
