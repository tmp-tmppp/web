import { useCallback } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import type { DataStatus } from "../../api/market-data";
import { getHistories, getMarketOverviewPage } from "../../api/market-data-graphql";
import type { HistoryResult, OverviewMarket, OverviewWindow } from "../../api/market-data-graphql";
import type { Outcome } from "../../api/markets";
import type { ApiClient, Page } from "../../api/types";
import { usePagedList } from "../../lib/use-paged-list";
import type { PagedList } from "../../lib/use-paged-list";
import { trendOf } from "./overview-trend";
import type { Trend } from "./overview-trend";

/** One line of the overview. */
export interface OverviewRow {
  id: string;
  question: string;
  status: DataStatus;
  outcome: Outcome | null;
  priceYesMicro: number;
  lastTradeAt: string | null;
  /** The change and the sparkline; null when there is none (see `problem`). */
  trend: Trend | null;
  /** Why the history is missing, in a sentence; null when it came (a market with nothing in the window has no trend and no problem). */
  problem: string | null;
}

const sentenceOf = (error: ApiError): string => (error.detail ? `${error.title}: ${error.detail}` : error.title);

function rowOf(market: OverviewMarket, result: HistoryResult): OverviewRow {
  const base = { id: market.marketId, question: market.question, status: market.status, outcome: market.outcome, priceYesMicro: market.currentPriceYesMicro, lastTradeAt: market.lastTradeAt };
  if (!result.ok) return { ...base, trend: null, problem: sentenceOf(result.problem) };
  return { ...base, trend: trendOf(result.history, market.currentPriceYesMicro), problem: null };
}

/**
 * The histories of a page of markets. A query that cannot run (an HTTP failure of the history query) leaves the prices
 * standing and every market without a trend; leaving the page (an abort) and a bug are not that.
 */
async function historiesOf(api: ApiClient, markets: readonly OverviewMarket[], span: OverviewWindow, signal: AbortSignal): Promise<HistoryResult[]> {
  try {
    return await getHistories(api, markets.map((market) => market.marketId), span, signal);
  } catch (error) {
    if (signal.aborted || !(error instanceof ApiError)) throw error;
    return markets.map(() => ({ ok: false, problem: error }));
  }
}

/**
 * The market overview (requirement 17): a page of the tenant's markets with their current prices from one GraphQL query,
 * then the recent history of exactly those markets from a second one (the schema has no history inside a market). The
 * cursor is the `endCursor` of the page. Give the component that uses this a new key to start over with another window.
 */
export function useMarketOverview(span: OverviewWindow): PagedList<OverviewRow> {
  const api = useApi();
  const fetchPage = useCallback(
    async (cursor: string | null, signal: AbortSignal): Promise<Page<OverviewRow>> => {
      const page = await getMarketOverviewPage(api, cursor, signal);
      const histories = await historiesOf(api, page.items, span, signal);
      return { items: page.items.map((market, index) => rowOf(market, histories[index] as HistoryResult)), nextCursor: page.hasNextPage ? page.endCursor : null };
    },
    [api, span],
  );
  return usePagedList(fetchPage);
}
