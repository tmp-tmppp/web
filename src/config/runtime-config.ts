import type { AppConfig } from "./types";

/** The configuration file is missing, unreadable or invalid. The message says which setting is wrong. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULTS = {
  clientId: "web",
  apiBase: "",
  depositSuccessPath: "/deposits/success",
  depositCancelPath: "/deposits/cancelled",
} as const;

function field(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ConfigError(`config.json: "${name}" must be a string`);
  return value.trim();
}

function httpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`config.json: "${name}" must be an absolute http or https address`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`config.json: "${name}" must be an absolute http or https address`);
  }
  return value.replace(/\/+$/, "");
}

/** The address of the export function: an absolute http(s) address, no query or fragment (the page adds its own query) and no credentials. */
function exportUrl(name: string, value: string): string {
  const message = `config.json: "${name}" must be an absolute http or https address without a query, a fragment or credentials`;
  const address = httpUrl(name, value);
  const parsed = new URL(address);
  if (value.includes("?") || value.includes("#") || parsed.username !== "" || parsed.password !== "") throw new ConfigError(message);
  return address;
}

function localPath(name: string, value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new ConfigError(`config.json: "${name}" must be a path that starts with a single "/"`);
  }
  return value;
}

/** Validates the parsed file. Optional settings fall back to the values the other services expect. */
export function parseConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config.json must hold one JSON object");
  }
  const source = raw as Record<string, unknown>;

  const issuer = field(source, "issuer");
  if (!issuer) throw new ConfigError('config.json: "issuer" is required');

  const clientId = field(source, "clientId") || DEFAULTS.clientId;

  const apiBase = field(source, "apiBase") ?? DEFAULTS.apiBase;
  const api = apiBase === "" ? "" : apiBase.startsWith("/") ? localPath("apiBase", apiBase).replace(/\/+$/, "") : httpUrl("apiBase", apiBase);

  const auditExport = field(source, "auditExportUrl");

  return {
    issuer: httpUrl("issuer", issuer),
    clientId,
    apiBase: api,
    depositSuccessPath: localPath("depositSuccessPath", field(source, "depositSuccessPath") || DEFAULTS.depositSuccessPath),
    depositCancelPath: localPath("depositCancelPath", field(source, "depositCancelPath") || DEFAULTS.depositCancelPath),
    ...(auditExport ? { auditExportUrl: exportUrl("auditExportUrl", auditExport) } : {}),
  };
}

/** Loads /config.json. It is never cached, so a changed file reaches the next page load. */
export async function loadConfig(fetchImpl: typeof fetch = (input, init) => fetch(input, init), url = "/config.json"): Promise<AppConfig> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    throw new ConfigError("config.json could not be loaded: the server did not answer");
  }
  if (!response.ok) throw new ConfigError(`config.json could not be loaded: HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConfigError("config.json is not valid JSON");
  }
  return parseConfig(body);
}
