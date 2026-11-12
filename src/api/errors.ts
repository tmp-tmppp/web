import type { FieldError, ProblemDetails } from "./types";

export interface ApiErrorInit {
  status: number;
  type: string;
  title: string;
  detail?: string | null;
  code?: string | null;
  instance?: string | null;
  fieldErrors?: FieldError[];
  retryAfterSeconds?: number | null;
  correlationId?: string | null;
  /** Display name of the organization a share-link problem names (403 of the lookup); null when unknown. */
  organizationName?: string | null;
  /** What the caller may do about a share-link problem (403 of the lookup). */
  next?: string[];
  /** The first error of a GraphQL answer that refused the whole request (no problem body); null otherwise. */
  graphqlError?: GraphqlRefusal | null;
}

/** One entry of `errors` of a GraphQL answer, as the endpoint sends it: the stable code is under `extensions.code`. */
export interface GraphqlRefusal {
  message?: unknown;
  path?: unknown;
  extensions: { code: string; status?: unknown; fields?: unknown; retryAfterSeconds?: unknown; [member: string]: unknown };
}

/** An API answer that is not a success, as a typed error. The page shows title and detail, never the raw body. */
export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | null;
  /** Machine-readable problem code such as slug_taken or verify_busy. */
  readonly code: string | null;
  readonly instance: string | null;
  readonly fieldErrors: FieldError[];
  /** Seconds from the Retry-After header, or null. */
  readonly retryAfterSeconds: number | null;
  readonly correlationId: string | null;
  readonly organizationName: string | null;
  readonly next: string[];
  /** The GraphQL error of a refused request (market-data's GraphQL endpoint), for the caller that words its codes. */
  readonly graphqlError: GraphqlRefusal | null;

  constructor(init: ApiErrorInit) {
    super(init.detail ? `${init.title}: ${init.detail}` : init.title);
    this.name = "ApiError";
    this.status = init.status;
    this.type = init.type;
    this.title = init.title;
    this.detail = init.detail ?? null;
    this.code = init.code ?? null;
    this.instance = init.instance ?? null;
    this.fieldErrors = init.fieldErrors ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.correlationId = init.correlationId ?? null;
    this.organizationName = init.organizationName ?? null;
    this.next = init.next ?? [];
    this.graphqlError = init.graphqlError ?? null;
  }

  /** The request never got an answer (network down, server unreachable). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  /** The service asks the client to come back later (503, 429). */
  get isRetryable(): boolean {
    return this.status === 503 || this.status === 429;
  }

  /**
   * The request may have reached the service and been decided although the caller got no usable answer, so a page must
   * not say that nothing was done. That is the case for:
   * - no answer at all (status 0);
   * - a success status (2xx) that this error carries: the service took the request on and answered, but the answer could
   *   not be read (a proxy's page instead of JSON, a body that broke off), so the request was most likely made;
   * - a 5xx other than 503 that names no refusal of our services: a gateway's 502 or 504 page or any body that is not our
   *   problem+json (code null), or the service's own `internal_error` (it failed and may have committed).
   * Not in this group: a 503 ("not now": the request was not taken on), and a 5xx that carries one of our services' own
   * refusal codes, which is a definite answer, for example markets' `502 funding_rejected` ("nothing was funded").
   */
  get outcomeUnknown(): boolean {
    if (this.status === 0) return true;
    if (this.status >= 200 && this.status < 300) return true;
    if (this.status < 500 || this.status === 503) return false;
    return this.code === null || this.code === "internal_error";
  }

  /** A failure that is usually over after a short wait: no answer, 429, and the gateway's 502, 503 and 504. */
  get isTemporary(): boolean {
    return this.status === 0 || this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

/** Seconds from a Retry-After value: a number of seconds or an HTTP date. Null when it is missing or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The problem details in a parsed body, or null when the body is not a problem (an HTML error page, a bare string). */
export function problemFromBody(body: unknown): ProblemDetails | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const title = textOf(source["title"]);
  if (!title) return null;
  const errors: FieldError[] = [];
  if (Array.isArray(source["errors"])) {
    for (const item of source["errors"] as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const field = textOf(entry["field"]);
      const message = textOf(entry["message"]);
      if (field && message) errors.push({ field, message });
    }
  }
  return {
    type: textOf(source["type"]) ?? "about:blank",
    title,
    status: typeof source["status"] === "number" ? source["status"] : 0,
    ...(textOf(source["detail"]) ? { detail: textOf(source["detail"]) as string } : {}),
    ...(textOf(source["code"]) ? { code: textOf(source["code"]) as string } : {}),
    ...(textOf(source["instance"]) ? { instance: textOf(source["instance"]) as string } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...organizationExtension(source["organization"]),
    ...(Array.isArray(source["next"]) ? { next: (source["next"] as unknown[]).filter((item): item is string => typeof item === "string") } : {}),
  };
}

/** The organization a share-link problem names (only its display name; the alias is never part of the problem). */
function organizationExtension(value: unknown): { organization?: { name: string | null } } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const name = (value as Record<string, unknown>)["name"];
  return { organization: { name: typeof name === "string" && name.trim() !== "" ? name : null } };
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json/i;

/**
 * The first error of a GraphQL answer, or null for any other body. A GraphQL endpoint refuses a whole request (a query
 * that cannot run, no token, a role without access, an unavailable dependency) with an HTTP error status and
 * `{ errors: [{ message, extensions: { code, status, ... } }] }`, never with a problem body.
 */
export function graphqlRefusalFromBody(body: unknown): GraphqlRefusal | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const errors = (body as Record<string, unknown>)["errors"];
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  if (typeof first !== "object" || first === null) return null;
  const extensions = (first as Record<string, unknown>)["extensions"];
  if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) return null;
  const code = textOf((extensions as Record<string, unknown>)["code"]);
  if (!code) return null;
  const entry = first as Record<string, unknown>;
  return { message: entry["message"], path: entry["path"], extensions: { ...(extensions as Record<string, unknown>), code } };
}

/** The error of a failed answer: built from its RFC 9457 problem when it has one, else from the status. */
export async function apiErrorFromResponse(response: Response, correlationId: string): Promise<ApiError> {
  let body: unknown = null;
  try {
    const text = await response.text();
    if (text && JSON_TYPE.test(response.headers.get("Content-Type") ?? "")) body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  const problem = problemFromBody(body);
  const graphqlError = problem ? null : graphqlRefusalFromBody(body);
  const fallback = fallbackProblem(response.status);
  return new ApiError({
    status: response.status,
    type: problem?.type ?? "about:blank",
    title: problem?.title ?? fallback.title,
    detail: problem ? problem.detail : fallback.detail,
    code: problem?.code ?? graphqlError?.extensions.code ?? null,
    graphqlError,
    instance: problem?.instance ?? null,
    fieldErrors: problem?.errors ?? [],
    organizationName: problem?.organization?.name ?? null,
    next: problem?.next ?? [],
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
    correlationId,
  });
}

/** Wording for an error answer that carries no problem body (a gateway error page, a proxy reset). */
export function fallbackProblem(status: number): { title: string; detail: string } {
  switch (status) {
    case 0:
      return { title: "The server cannot be reached", detail: "Check your connection and try again." };
    case 400:
      return { title: "The request was not accepted", detail: "Check what you entered and try again." };
    case 401:
      return { title: "You are not signed in", detail: "Your session is not valid. Sign in again." };
    case 403:
      return { title: "Not allowed", detail: "Your role does not allow this." };
    case 404:
      return { title: "Not found", detail: "The thing you asked for does not exist, or it belongs to another tenant." };
    case 409:
      return { title: "Conflict", detail: "The request conflicts with the current state. Reload and try again." };
    case 429:
      return { title: "Too many requests", detail: "Slow down and try again in a moment." };
    case 502:
    case 503:
    case 504:
      return { title: "The service is not available", detail: "Try again in a moment." };
    default:
      return status >= 500
        ? { title: "Something went wrong on the server", detail: "Try again in a moment." }
        : { title: "The request failed", detail: `The server answered with status ${status}.` };
  }
}
