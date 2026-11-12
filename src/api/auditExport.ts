import { randomId } from "../lib/ids";
import { auditQuery } from "./audit";
import type { AuditFilters } from "./audit";
import { ApiError, apiErrorFromResponse, fallbackProblem } from "./errors";

/**
 * The call to the audit-export function (a separate serverless app, address in the runtime configuration). It follows
 * the contract of audit-export/README.md: GET with the filters of GET /v1/audit plus format=csv|jsonl, the caller's own
 * bearer token, and a file as the answer; every failure is a problem (RFC 9457). The answer is not JSON, so this is not
 * done through the API client, which only reads JSON.
 */

export type ExportFormat = "csv" | "jsonl";

export interface ExportedFile {
  blob: Blob;
  /** The file name the function chose (it says "-truncated" when the file was cut), or a plain fallback. */
  fileName: string;
  /** Rows in the file (X-Export-Rows), or null when the browser was not allowed to read that header. */
  rows: number | null;
  /**
   * True when the function stopped at its row cap (the file holds the newest rows only), false when it says the file is
   * complete, null when the browser could not read X-Export-Truncated: then nobody knows, and the page must not say "complete".
   */
  truncated: boolean | null;
  correlationId: string;
}

export interface ExportOptions {
  /** Address of the function, without a query (config.auditExportUrl). */
  url: string;
  format: ExportFormat;
  filters: AuditFilters;
  getAccessToken: () => Promise<string | null>;
  /** Called once after a 401; when it returns true the export is repeated with the new token. */
  refreshSession?: () => Promise<boolean>;
  /** Called when the token is refused for good. */
  onUnauthorized?: () => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  newCorrelationId?: () => string;
}

/** The file name of a Content-Disposition value, reduced to letters, digits, dot, underscore and hyphen. */
export function fileNameFrom(disposition: string | null, format: ExportFormat): string {
  const fallback = `audit-export.${format}`;
  const match = disposition ? /filename="([^"]{1,200})"/.exec(disposition) : null;
  const name = (match?.[1] ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return name !== "" && name.endsWith(`.${format}`) ? name : fallback;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Asks the function for the file. Rejects with an ApiError for a problem answer or an unreachable function. */
export async function requestAuditExport(options: ExportOptions): Promise<ExportedFile> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const nextCorrelationId = options.newCorrelationId ?? randomId;
  const query = new URLSearchParams({ format: options.format });
  for (const [name, value] of Object.entries(auditQuery(options.filters))) if (value !== "") query.set(name, value);
  const address = `${options.url}?${query.toString()}`;

  async function attempt(correlationId: string): Promise<Response> {
    const token = await options.getAccessToken();
    const headers: Record<string, string> = {
      Accept: options.format === "csv" ? "text/csv, application/problem+json" : "application/x-ndjson, application/problem+json",
      "X-Correlation-Id": correlationId,
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      // The token is the credential; no cookie belongs on the call, and no copy of the file is kept by the browser.
      return await fetchImpl(address, { method: "GET", headers, credentials: "omit", cache: "no-store", ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      if (isAbort(error)) throw error;
      const problem = fallbackProblem(0);
      throw new ApiError({ status: 0, type: "about:blank", title: problem.title, detail: problem.detail, correlationId });
    }
  }

  let sentId = nextCorrelationId();
  let response = await attempt(sentId);
  if (response.status === 401 && options.refreshSession && (await options.refreshSession())) {
    sentId = nextCorrelationId();
    response = await attempt(sentId);
  }
  const correlationId = response.headers.get("X-Correlation-Id") ?? sentId;
  if (!response.ok) {
    if (response.status === 401) options.onUnauthorized?.();
    throw await apiErrorFromResponse(response, correlationId);
  }
  const rows = Number(response.headers.get("X-Export-Rows"));
  // A cross-origin answer shows only the headers the server exposes, and the platform's CORS layer may drop the function's
  // own Access-Control-Expose-Headers (audit-export/README.md, CORS). A header that cannot be read is unknown, not "false".
  const cut = response.headers.get("X-Export-Truncated")?.trim().toLowerCase();
  const truncated = cut === "true" ? true : cut === "false" ? false : null;
  let fileName = fileNameFrom(response.headers.get("Content-Disposition"), options.format);
  // The "-truncated" mark in the function's file name is lost with the same header, so the plain name says it is unchecked.
  if (truncated === null && fileName === `audit-export.${options.format}`) fileName = `audit-export-unverified.${options.format}`;
  return {
    blob: await response.blob(),
    fileName,
    rows: response.headers.get("X-Export-Rows") !== null && Number.isInteger(rows) && rows >= 0 ? rows : null,
    truncated,
    correlationId,
  };
}
