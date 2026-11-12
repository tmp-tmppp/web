import type { ApiClient, Page } from "./types";
import type { Outcome } from "./markets";

/**
 * Requests and answers of the market-data service, the read side of the markets: the list with current prices, one
 * market's header and price, and the price history for the chart. The OpenAPI file of the service is the truth
 * (contracts/market-data.openapi.yaml). Every `...Micro` field is an exact integer in micro-units (ADR-055); a price is
 * microcredits per share (550000 is 0.55 per YES share).
 */

/** market-data knows a market once it is open; drafts and markets being opened exist only in the markets service. */
export type DataStatus = "open" | "closed" | "resolved";
export const DATA_STATUSES: readonly DataStatus[] = ["open", "closed", "resolved"];

export interface DataMarket {
  marketId: string;
  question: string;
  status: DataStatus;
  closeTime: string;
  openedAt: string;
  closedAt: string | null;
  resolvedAt: string | null;
  outcome: Outcome | null;
  startingPriceYesMicro: number;
  /** The YES price of the newest trade; null before the first trade. */
  lastPriceYesMicro: number | null;
  /** What the list shows: 1000000 (YES) or 0 (NO) once resolved, else the last trade's price, else the starting price. */
  currentPriceYesMicro: number;
  volumeMicro: number;
  tradeCount: number;
  /** The highest trade sequence in the read model (0 without trades). */
  lastTradeSequence: number;
  lastTradeAt: string | null;
  version: number;
  updatedAt: string;
}

export const HISTORY_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type HistoryInterval = (typeof HISTORY_INTERVALS)[number];

export interface Bucket {
  /** The bucket's start, aligned to the Unix epoch in UTC. */
  start: string;
  openYesMicro: number;
  highYesMicro: number;
  lowYesMicro: number;
  closeYesMicro: number;
  volumeMicro: number;
  trades: number;
}

export interface History {
  marketId: string;
  interval: HistoryInterval;
  from: string;
  to: string;
  /** The YES price of the latest point before the first bucket; null when there is none. */
  previousCloseYesMicro: number | null;
  buckets: Bucket[];
  nextCursor: string | null;
}

/** The most markets one batch call takes (`ids`). */
export const BATCH_MAX = 100;
/** The most buckets one history page holds. */
export const HISTORY_PAGE_MAX = 500;

export interface ListDataMarketsQuery {
  status?: DataStatus;
  cursor?: string | null;
  limit?: number;
}

export const listDataMarkets = (api: ApiClient, query: ListDataMarketsQuery = {}, signal?: AbortSignal): Promise<Page<DataMarket>> =>
  api.get<Page<DataMarket>>("/v1/market-data/markets", { status: query.status, cursor: query.cursor, limit: query.limit }, signal);

/**
 * The markets with these ids in one call per 100 ids (DM-12: the portfolio never asks once per position). Ids that are
 * unknown, of another tenant or not opened yet are left out of the answer.
 */
export async function getDataMarkets(api: ApiClient, ids: readonly string[], signal?: AbortSignal): Promise<DataMarket[]> {
  const unique = [...new Set(ids)];
  const found: DataMarket[] = [];
  for (let start = 0; start < unique.length; start += BATCH_MAX) {
    const page = await api.get<Page<DataMarket>>("/v1/market-data/markets", { ids: unique.slice(start, start + BATCH_MAX).join(",") }, signal);
    found.push(...page.items);
  }
  return found;
}

/** `afterSequence` (DM-17): the trade sequence of the caller's own order; the answer is 409 `updating` until market-data has that trade. */
export const getDataMarket = (api: ApiClient, marketId: string, afterSequence?: number, signal?: AbortSignal): Promise<DataMarket> =>
  api.get<DataMarket>(`/v1/market-data/markets/${encodeURIComponent(marketId)}`, { afterSequence }, signal);

export interface HistoryQuery {
  interval?: HistoryInterval;
  cursor?: string | null;
  limit?: number;
  afterSequence?: number;
}

export const getHistoryPage = (api: ApiClient, marketId: string, query: HistoryQuery = {}, signal?: AbortSignal): Promise<History> =>
  api.get<History>(
    `/v1/market-data/markets/${encodeURIComponent(marketId)}/history`,
    { interval: query.interval, cursor: query.cursor, limit: query.limit, afterSequence: query.afterSequence },
    signal,
  );

/** The most pages of history one chart reads (500 buckets each). */
export const HISTORY_PAGES_MAX = 4;

/** The history of a market as one list of buckets: the pages of the same range, oldest first, up to HISTORY_PAGES_MAX of them. */
export async function getHistory(api: ApiClient, marketId: string, interval: HistoryInterval, afterSequence?: number, signal?: AbortSignal): Promise<History> {
  let first: History | null = null;
  const buckets: Bucket[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < HISTORY_PAGES_MAX; page += 1) {
    const part: History = await getHistoryPage(api, marketId, { interval, limit: HISTORY_PAGE_MAX, cursor, afterSequence }, signal);
    first ??= part;
    buckets.push(...part.buckets);
    cursor = part.nextCursor;
    if (!cursor) return { ...first, to: part.to, buckets, nextCursor: null };
  }
  return { ...(first as History), buckets, nextCursor: cursor };
}
