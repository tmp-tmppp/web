import { useCallback, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { listDataMarkets } from "../../api/market-data";
import type { DataMarket, DataStatus } from "../../api/market-data";
import { listMarkets } from "../../api/markets";
import type { Market, MarketStatus, Outcome } from "../../api/markets";
import type { Page } from "../../api/types";
import { usePagedList } from "../../lib/use-paged-list";
import type { PagedList } from "../../lib/use-paged-list";

/** One line of the market list, from market-data (with its price) or from the markets service (without one). */
export interface MarketRow {
  id: string;
  question: string;
  status: MarketStatus;
  closeTime: string;
  outcome: Outcome | null;
  /** The current YES price in microcredits; null when market-data is not there to say (or the market is not open yet). */
  priceYesMicro: number | null;
  /** Microcredits traded; null like the price. */
  volumeMicro: number | null;
}

const DATA = "md:";
const MARKETS = "mk:";

const fromData = (market: DataMarket): MarketRow => ({
  id: market.marketId,
  question: market.question,
  status: market.status,
  closeTime: market.closeTime,
  outcome: market.outcome,
  priceYesMicro: market.currentPriceYesMicro,
  volumeMicro: market.volumeMicro,
});

const fromMarkets = (market: Market): MarketRow => ({
  id: market.id,
  question: market.question,
  status: market.status,
  closeTime: market.closeTime,
  outcome: market.outcome,
  priceYesMicro: null,
  volumeMicro: null,
});

/** market-data cannot be reached or is broken (no answer, 502, 503, 504, ...): the list goes on without prices. A 4xx is not that. */
export function canDoWithoutMarketData(error: unknown): boolean {
  return error instanceof ApiError && (error.isNetworkError || error.status >= 500);
}

const withCursor = (prefix: string, cursor: string | null): string | null => (cursor ? `${prefix}${cursor}` : null);

/** A page of the markets service as rows; the cursor says where the next page comes from. */
function marketsPage(page: Page<Market>, keep: (market: Market) => boolean = () => true, prefix: string = MARKETS): Page<MarketRow> {
  return { items: page.items.filter(keep).map(fromMarkets), nextCursor: withCursor(prefix, page.nextCursor) };
}

/**
 * The markets that are open, closed or resolved, with their current prices, from market-data (UC-03). When market-data
 * is down the list comes from the markets service instead, without prices (the plan's fallback; trading does not need
 * market-data, so the traders can still reach every market). `hideUnopened` leaves drafts and markets being opened out
 * of that fallback when another list shows them. The cursor of a page remembers which service it belongs to.
 */
export function useDataRows(status: DataStatus | undefined, hideUnopened: boolean): PagedList<MarketRow> & { withoutPrices: boolean } {
  const api = useApi();
  const [withoutPrices, setWithoutPrices] = useState(false);
  const fetchPage = useCallback(
    async (cursor: string | null, signal: AbortSignal): Promise<Page<MarketRow>> => {
      const keep = (market: Market) => !hideUnopened || (market.status !== "draft" && market.status !== "opening");
      if (cursor?.startsWith(MARKETS)) return marketsPage(await listMarkets(api, { ...(status ? { status } : {}), cursor: cursor.slice(MARKETS.length) }, signal), keep);
      if (cursor?.startsWith(DATA)) {
        const page = await listDataMarkets(api, { ...(status ? { status } : {}), cursor: cursor.slice(DATA.length) }, signal);
        return { items: page.items.map(fromData), nextCursor: withCursor(DATA, page.nextCursor) };
      }
      try {
        const page = await listDataMarkets(api, status ? { status } : {}, signal);
        setWithoutPrices(false);
        return { items: page.items.map(fromData), nextCursor: withCursor(DATA, page.nextCursor) };
      } catch (error) {
        if (!canDoWithoutMarketData(error)) throw error;
        const page = marketsPage(await listMarkets(api, status ? { status } : {}, signal), keep);
        setWithoutPrices(true);
        return page;
      }
    },
    [api, status, hideUnopened],
  );
  return { ...usePagedList(fetchPage), withoutPrices };
}

/** The markets of one status straight from the markets service: drafts and markets being opened, which only tenant admins see. */
export function useMarketsRows(status: MarketStatus): PagedList<MarketRow> {
  const api = useApi();
  const fetchPage = useCallback(
    async (cursor: string | null, signal: AbortSignal): Promise<Page<MarketRow>> => marketsPage(await listMarkets(api, { status, cursor }, signal), undefined, ""),
    [api, status],
  );
  return usePagedList(fetchPage);
}
