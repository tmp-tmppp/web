import { ApiError } from "./errors";
import type { Outcome } from "./markets";
import type { ApiClient, FieldError } from "./types";
import type { DataStatus } from "./market-data";
import { DATA_STATUSES } from "./market-data";

/**
 * The GraphQL side of market-data (plan 11, requirement 17: GraphQL as a small backend-for-frontend). One endpoint, POST
 * /v1/market-data/graphql, answers queries only; its contract is contracts/market-data.graphql, a copy of the file the
 * service keeps (tests/contract-validator.test.ts keeps them equal, tests/market-data-graphql.test.ts validates every
 * document below against it). The request is a plain fetch body `{ query, variables }`, no GraphQL client library.
 *
 * What the schema offers decides the shape of the calls: a market has no `history` field and there is no batch history, so
 * the markets of a page and their price histories cannot come in one query. The page asks twice, both times through this
 * endpoint: one query for a page of markets with their current prices (`getMarketOverviewPage`), then one query for the
 * histories of exactly those markets, one aliased `history` field each (`getHistories`).
 */

export const GRAPHQL_PATH = "/v1/market-data/graphql";

/** Markets per page. With the histories of a page in one document the cost stays near half of the service's limit (GRAPHQL_MAX_COMPLEXITY 5000). */
export const OVERVIEW_PAGE_SIZE = 10;

/** The span the overview shows the change and the trend over: the interval of its buckets is what the history is read in. */
export interface OverviewWindow {
  id: "24h" | "7d";
  label: string;
  /** For a sentence: "over the last 24 hours". */
  phrase: string;
  durationMs: number;
  /** The GraphQL enum `HistoryInterval`. */
  interval: "ONE_HOUR" | "FOUR_HOURS";
  intervalMs: number;
}

/** The window the page opens with. */
export const DEFAULT_WINDOW: OverviewWindow = { id: "24h", label: "24 hours", phrase: "the last 24 hours", durationMs: 86_400_000, interval: "ONE_HOUR", intervalMs: 3_600_000 };

export const OVERVIEW_WINDOWS: readonly OverviewWindow[] = [
  DEFAULT_WINDOW,
  { id: "7d", label: "7 days", phrase: "the last 7 days", durationMs: 604_800_000, interval: "FOUR_HOURS", intervalMs: 14_400_000 },
];

/** The most buckets a window holds: one per interval, and one more for the bucket the current time is in. */
export const bucketsIn = (window: OverviewWindow): number => Math.ceil(window.durationMs / window.intervalMs) + 1;

/**
 * The page size of a history: every bucket of the window, and one more for a browser clock up to one interval behind the
 * server's. The service starts at the bucket `from` falls in, so a start the browser places early spans one bucket more;
 * without the spare bucket the service would page the answer and leave out the newest bucket.
 */
export const historyPageSize = (window: OverviewWindow): number => bucketsIn(window) + 1;

/**
 * Where the history of a window starts: now minus the window, rounded up to a bucket start (buckets are aligned to the
 * Unix epoch in UTC, as the service computes them). The service rounds `from` down to a bucket start, so an unaligned
 * start would stretch the change and the line up to one interval beyond the span the label names; an aligned one keeps
 * them inside it (at most one interval shorter).
 */
export const windowStart = (window: OverviewWindow, now: number): number => Math.ceil((now - window.durationMs) / window.intervalMs) * window.intervalMs;

// --- the documents ------------------------------------------------------------------------------------------------------

/** A page of the tenant's markets with their current prices (the tenant comes from the token, never from the query). */
export const MARKETS_QUERY = `query MarketOverview($first: Int!, $after: String) {
  markets(first: $first, after: $after) {
    items { marketId question status outcome currentPriceYesMicro lastTradeAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * The histories of `count` markets, one aliased field each (h0, h1, ...): the same interval, start and page size for all.
 * A failed field is null with an error whose path is its alias, and the others still answer.
 */
export function historiesQuery(count: number): string {
  const ids = Array.from({ length: count }, (_, index) => index);
  const variables = ["$interval: HistoryInterval!", "$from: DateTime!", "$first: Int!", ...ids.map((index) => `$id${index}: ID!`)].join(", ");
  const fields = ids
    .map(
      (index) =>
        `  h${index}: history(marketId: $id${index}, interval: $interval, from: $from, first: $first) { from to previousCloseYesMicro buckets { start openYesMicro highYesMicro lowYesMicro closeYesMicro } }`,
    )
    .join("\n");
  return `query MarketSparklines(${variables}) {\n${fields}\n}`;
}

// --- the answer ---------------------------------------------------------------------------------------------------------

/** One entry of `errors` of an answer: the codes of the REST problems plus the codes of the endpoint itself. */
export interface GraphqlErrorEntry {
  message?: unknown;
  path?: unknown;
  extensions?: { code?: unknown; status?: unknown; fields?: unknown; retryAfterSeconds?: unknown };
}

interface GraphqlAnswer {
  data?: Record<string, unknown> | null;
  errors?: GraphqlErrorEntry[];
}

/** What market-data documents under `extensions.code` (contracts/market-data.graphql, README "GraphQL"), in the words of this app. */
const PROBLEM_WORDS: Readonly<Record<string, { title: string; detail: string }>> = {
  not_found: { title: "Not found", detail: "The market does not exist, belongs to another organization or is not listed yet." },
  updating: { title: "The price data is catching up", detail: "Market data does not have the latest trade yet. Try again in a moment." },
  validation_failed: { title: "The request was not accepted", detail: "Market data did not accept what the page asked for." },
  history_paused: { title: "The price history is paused", detail: "Prices are current, but the history is switched off for a moment." },
  tenant_not_ready: { title: "The market data of your organization is not ready yet", detail: "It is being set up. Try again in a moment." },
  forbidden: { title: "Not allowed", detail: "Your role does not allow reading market data." },
  unauthorized: { title: "You are not signed in", detail: "Your session is not valid. Sign in again." },
  identity_provider_unavailable: { title: "Sign-in is not available right now", detail: "Market data could not check your session. Try again in a moment." },
  bad_request: { title: "The request was not accepted", detail: "Check what you asked for and try again." },
  internal_error: { title: "Something went wrong on the server", detail: "Try again in a moment." },
};

const MISMATCH = { title: "This page and market data do not agree", detail: "The page asked a question that market data does not accept. Try again later; if it stays, tell the people who run the app." };
/** The codes of the endpoint itself: a query that cannot run. They mean the page is wrong, not the data. */
const MISMATCH_CODES = ["graphql_syntax_error", "graphql_validation_failed", "depth_limit_exceeded", "complexity_limit_exceeded", "introspection_disabled", "method_not_allowed"];

/** The codes this app words (the ones above, and the mismatch codes). */
export const KNOWN_GRAPHQL_CODES: readonly string[] = [...Object.keys(PROBLEM_WORDS), ...MISMATCH_CODES];

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

function fieldErrorsOf(value: unknown): FieldError[] {
  if (!Array.isArray(value)) return [];
  const found: FieldError[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const field = textOf((item as { field?: unknown }).field);
    const message = textOf((item as { message?: unknown }).message);
    if (field && message) found.push({ field, message });
  }
  return found;
}

/**
 * An error of an answer as the ApiError every other page shows (title, detail, the invalid fields, how long to wait): the
 * code decides the wording, never the message, which may name parts of a query. A code this app does not know keeps the
 * status the service gave and gets the general wording of that status.
 */
export function problemOfGraphqlError(entry: GraphqlErrorEntry, correlationId: string | null = null): ApiError {
  const code = textOf(entry.extensions?.code);
  const status = typeof entry.extensions?.status === "number" ? entry.extensions.status : 500;
  const words = code && PROBLEM_WORDS[code] ? PROBLEM_WORDS[code] : code && MISMATCH_CODES.includes(code) ? MISMATCH : status >= 500 ? PROBLEM_WORDS["internal_error"] : PROBLEM_WORDS["bad_request"];
  const retry = entry.extensions?.retryAfterSeconds;
  return new ApiError({
    status,
    type: `urn:chance:problem:${(code ?? "unknown").replace(/_/g, "-")}`,
    title: words?.title ?? "The request failed",
    detail: words?.detail ?? null,
    code,
    fieldErrors: code === "validation_failed" ? fieldErrorsOf(entry.extensions?.fields) : [],
    retryAfterSeconds: typeof retry === "number" && Number.isFinite(retry) ? retry : null,
    correlationId,
  });
}

const unreadable = (): ApiError =>
  new ApiError({ status: 200, type: "about:blank", title: "The server sent an answer the app cannot read", detail: "Try again in a moment." });

/**
 * POSTs one document. A 200 may still carry `errors` (an error of a field). A refusal of the whole request comes with an
 * HTTP error status (400 for a query that cannot run, 401, 403, 503, ...) and the GraphQL error shape instead of a
 * problem: its code is worded here like the code of a field error, with the status of the answer and the wait of its
 * Retry-After header. A failed answer without that shape (a gateway's problem, no answer) stays the client's ApiError.
 */
async function postQuery(api: ApiClient, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<GraphqlAnswer> {
  let answer: unknown;
  try {
    answer = await api.post<unknown>(GRAPHQL_PATH, { query, variables }, { signal });
  } catch (error) {
    if (!(error instanceof ApiError) || error.graphqlError === null) throw error;
    const { extensions } = error.graphqlError;
    const retryAfterSeconds = error.retryAfterSeconds ?? extensions.retryAfterSeconds;
    throw problemOfGraphqlError({ ...error.graphqlError, extensions: { ...extensions, status: error.status, retryAfterSeconds } }, error.correlationId);
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw unreadable();
  const { data, errors } = answer as GraphqlAnswer;
  if (errors !== undefined && !Array.isArray(errors)) throw unreadable();
  if ((data === undefined || data === null) && (errors === undefined || errors.length === 0)) throw unreadable();
  return { data: data ?? null, errors: errors ?? [] };
}

/** The alias or field an error belongs to (the first step of its path), or null for an error of the whole query. */
function fieldOfError(entry: GraphqlErrorEntry): string | null {
  return Array.isArray(entry.path) && typeof entry.path[0] === "string" ? entry.path[0] : null;
}

// --- the markets of a page ----------------------------------------------------------------------------------------------

/** A market of the overview: what the table needs, from the `Market` type of the schema. */
export interface OverviewMarket {
  marketId: string;
  question: string;
  status: DataStatus;
  outcome: Outcome | null;
  /** The current YES price in microcredits (1000000 or 0 once resolved). */
  currentPriceYesMicro: number;
  lastTradeAt: string | null;
}

export interface OverviewPage {
  items: OverviewMarket[];
  hasNextPage: boolean;
  /** Opaque: passed back as `after`. */
  endCursor: string | null;
}

const isMicro = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readMarket(raw: unknown): OverviewMarket | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const status = typeof item["status"] === "string" ? (item["status"].toLowerCase() as DataStatus) : null;
  const outcome = item["outcome"] ?? null;
  const lastTradeAt = item["lastTradeAt"] ?? null;
  if (typeof item["marketId"] !== "string" || typeof item["question"] !== "string" || status === null || !DATA_STATUSES.includes(status)) return null;
  if (outcome !== null && outcome !== "YES" && outcome !== "NO" && outcome !== "INVALID") return null;
  if (!isMicro(item["currentPriceYesMicro"]) || (lastTradeAt !== null && typeof lastTradeAt !== "string")) return null;
  return { marketId: item["marketId"], question: item["question"], status, outcome, currentPriceYesMicro: item["currentPriceYesMicro"], lastTradeAt };
}

/** The next page of the tenant's markets. A failure of the `markets` field is thrown as the problem it is. */
export async function getMarketOverviewPage(api: ApiClient, after: string | null, signal: AbortSignal): Promise<OverviewPage> {
  const answer = await postQuery(api, MARKETS_QUERY, { first: OVERVIEW_PAGE_SIZE, after }, signal);
  const failed = (answer.errors ?? [])[0];
  const page = answer.data?.["markets"];
  if (failed !== undefined || typeof page !== "object" || page === null) throw failed ? problemOfGraphqlError(failed) : unreadable();
  const { items, pageInfo } = page as { items?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
  const markets = Array.isArray(items) ? (items as unknown[]).map(readMarket) : null;
  if (markets === null || markets.includes(null) || typeof pageInfo !== "object" || pageInfo === null) throw unreadable();
  const endCursor = pageInfo.endCursor ?? null;
  if (typeof pageInfo.hasNextPage !== "boolean" || (endCursor !== null && typeof endCursor !== "string")) throw unreadable();
  return { items: markets as OverviewMarket[], hasNextPage: pageInfo.hasNextPage, endCursor };
}

// --- the histories of a page --------------------------------------------------------------------------------------------

export interface HistoryBucket {
  start: string;
  openYesMicro: number;
  highYesMicro: number;
  lowYesMicro: number;
  closeYesMicro: number;
}

/** The history of one market over the window: sparse buckets, oldest first. */
export interface WindowHistory {
  /** The start of the first bucket (the page asks from a bucket start, see windowStart). */
  from: string;
  to: string;
  /** The YES price of the latest point before the first bucket; null when there is none. */
  previousCloseYesMicro: number | null;
  buckets: HistoryBucket[];
}

/** One market's history, or why it is missing. */
export type HistoryResult = { ok: true; history: WindowHistory } | { ok: false; problem: ApiError };

function readHistory(raw: unknown): WindowHistory | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const previous = item["previousCloseYesMicro"] ?? null;
  if (typeof item["from"] !== "string" || typeof item["to"] !== "string" || (previous !== null && !isMicro(previous)) || !Array.isArray(item["buckets"])) return null;
  const buckets: HistoryBucket[] = [];
  for (const entry of item["buckets"] as unknown[]) {
    const bucket = entry as Record<string, unknown> | null;
    if (typeof bucket !== "object" || bucket === null || typeof bucket["start"] !== "string") return null;
    const { openYesMicro, highYesMicro, lowYesMicro, closeYesMicro } = bucket;
    if (!isMicro(openYesMicro) || !isMicro(highYesMicro) || !isMicro(lowYesMicro) || !isMicro(closeYesMicro)) return null;
    buckets.push({ start: bucket["start"], openYesMicro, highYesMicro, lowYesMicro, closeYesMicro });
  }
  return { from: item["from"], to: item["to"], previousCloseYesMicro: previous, buckets };
}

/**
 * The histories of these markets over the window, in the order of the ids, in one query. The answer says per market whether
 * it has its history; one that failed (`history_paused`, `not_found`, ...) does not fail the others. A query that cannot run at
 * all (an HTTP failure) is thrown, and the caller shows the prices without trends.
 */
export async function getHistories(api: ApiClient, ids: readonly string[], window: OverviewWindow, signal: AbortSignal, now: number = Date.now()): Promise<HistoryResult[]> {
  if (ids.length === 0) return [];
  const variables: Record<string, unknown> = { interval: window.interval, from: new Date(windowStart(window, now)).toISOString(), first: historyPageSize(window) };
  ids.forEach((id, index) => {
    variables[`id${index}`] = id;
  });
  const answer = await postQuery(api, historiesQuery(ids.length), variables, signal);
  const errors = answer.errors ?? [];
  return ids.map((_, index) => {
    const alias = `h${index}`;
    const failed = errors.find((entry) => fieldOfError(entry) === alias) ?? (answer.data === null ? errors[0] : undefined);
    if (failed !== undefined) return { ok: false, problem: problemOfGraphqlError(failed) };
    const history = readHistory(answer.data?.[alias]);
    return history ? { ok: true, history } : { ok: false, problem: unreadable() };
  });
}
