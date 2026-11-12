/** One invalid field of a 400 answer. */
export interface FieldError {
  field: string;
  message: string;
}

/** RFC 9457 problem details, as every service answers with Content-Type application/problem+json. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  instance?: string;
  errors?: FieldError[];
  /** Only on the 403 of the share-link lookup: the display name of the organization the link leads to. */
  organization?: { name: string | null };
  /** Only on the 403 of the share-link lookup: what the caller may do about it. */
  next?: string[];
}

/** One page of a list with cursor pagination; nextCursor is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Added to the address; null, undefined and empty values are left out. */
  query?: Record<string, QueryValue>;
  /** Sent as JSON. */
  body?: unknown;
  /** Value of the Idempotency-Key header (deposits and withdrawals). Make it once per attempt, see newIdempotencyKey. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  status: number;
  /** The parsed JSON body; undefined when the answer has none (204, or 202 without a body). */
  data: T;
  headers: Headers;
  /** The X-Correlation-Id of the request, as the server echoed it or as it was sent. */
  correlationId: string;
}

export interface ApiClient {
  /** Full control: status and headers (for example the Location of a 202). */
  request: <T>(path: string, options?: RequestOptions) => Promise<ApiResponse<T>>;
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) => Promise<T>;
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) => Promise<T>;
}

export interface ApiClientOptions {
  /** Prefix of every path: "" for the same origin (the gateway), or an absolute address. */
  baseUrl: string;
  /** The current access token, or null without a session. */
  getAccessToken: () => Promise<string | null>;
  /** Called once after a 401; when it returns true the request is repeated with the new token. */
  refreshSession?: () => Promise<boolean>;
  /** Called when a 401 stays after the refresh: the session is over. */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  newCorrelationId?: () => string;
}
