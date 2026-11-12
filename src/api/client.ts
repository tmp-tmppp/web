import { randomId } from "../lib/ids";
import { ApiError, apiErrorFromResponse, fallbackProblem } from "./errors";
import type { ApiClient, ApiClientOptions, ApiResponse, QueryValue, RequestOptions } from "./types";

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json/i;

function addressOf(base: string, path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
  }
  const text = params.toString();
  return `${base}${path}${text ? `${path.includes("?") ? "&" : "?"}${text}` : ""}`;
}

/** A cancelled request (the page left, a newer request replaced it) is not a failure to show; callers ignore it. */
function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * The one way the app talks to the services: through the gateway on the same origin, with the access token as a Bearer
 * header and a fresh X-Correlation-Id on every request. An answer that is not a success becomes an ApiError built from
 * the RFC 9457 problem (or from the status when the body is no problem); a 401 renews the session once and repeats.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const nextCorrelationId = options.newCorrelationId ?? randomId;
  const base = options.baseUrl.replace(/\/+$/, "");

  async function attempt(path: string, request: RequestOptions, token: string | null, correlationId: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json, application/problem+json",
      "X-Correlation-Id": correlationId,
      ...request.headers,
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (request.idempotencyKey) headers["Idempotency-Key"] = request.idempotencyKey;
    const hasBody = request.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";
    try {
      return await fetchImpl(addressOf(base, path, request.query), {
        method: request.method ?? "GET",
        headers,
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
        // The token is the credential; no cookie belongs on an API call, and no answer is kept (INF-02).
        credentials: "omit",
        cache: "no-store",
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      const problem = fallbackProblem(0);
      throw new ApiError({ status: 0, type: "about:blank", title: problem.title, detail: problem.detail, correlationId });
    }
  }

  async function dataFrom<T>(response: Response, correlationId: string): Promise<T> {
    if (response.status === 204 || response.status === 205) return undefined as T;
    let text: string | null;
    try {
      text = await response.text();
    } catch {
      // The body broke off after a success status: the request was taken on, so this is the same "cannot read" error as a
      // body that is not JSON (outcomeUnknown), not a raw TypeError that a form would take for "nothing was done".
      text = null;
    }
    if (text === "") return undefined as T;
    if (text !== null && JSON_TYPE.test(response.headers.get("Content-Type") ?? "")) {
      try {
        return JSON.parse(text) as T;
      } catch {
        // Falls through to the error below.
      }
    }
    throw new ApiError({
      status: response.status,
      type: "about:blank",
      title: "The server sent an answer the app cannot read",
      detail: "Try again in a moment.",
      correlationId,
    });
  }

  async function request<T>(path: string, request: RequestOptions = {}): Promise<ApiResponse<T>> {
    let sentId = nextCorrelationId();
    let response = await attempt(path, request, await options.getAccessToken(), sentId);
    if (response.status === 401 && options.refreshSession && (await options.refreshSession())) {
      sentId = nextCorrelationId();
      response = await attempt(path, request, await options.getAccessToken(), sentId);
    }
    const correlationId = response.headers.get("X-Correlation-Id") ?? sentId;
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      throw await apiErrorFromResponse(response, correlationId);
    }
    return { status: response.status, data: await dataFrom<T>(response, correlationId), headers: response.headers, correlationId };
  }

  return {
    request,
    get: async <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
      (await request<T>(path, { method: "GET", ...(query ? { query } : {}), ...(signal ? { signal } : {}) })).data,
    post: async <T>(path: string, body?: unknown, extra: Omit<RequestOptions, "method" | "body"> = {}) =>
      (await request<T>(path, { ...extra, method: "POST", ...(body !== undefined ? { body } : {}) })).data,
    put: async <T>(path: string, body?: unknown, extra: Omit<RequestOptions, "method" | "body"> = {}) =>
      (await request<T>(path, { ...extra, method: "PUT", ...(body !== undefined ? { body } : {}) })).data,
  };
}
