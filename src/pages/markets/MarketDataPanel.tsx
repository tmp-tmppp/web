import { useEffect, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { getDataMarket, getHistory, HISTORY_INTERVALS } from "../../api/market-data";
import type { DataMarket, History, HistoryInterval } from "../../api/market-data";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";
import { formatMicroCredits, formatPrice, noPrice } from "../../lib/units";
import { PriceChart } from "./PriceChart";

/** DM-17: the chart waits up to about 2 seconds for the caller's own trade, then shows "updating". */
export const UPDATE_WAIT_MS = 500;
export const UPDATE_ATTEMPTS = 5;

const INTERVAL_LABELS: Record<HistoryInterval, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "1h": "1 hour",
  "4h": "4 hours",
  "1d": "1 day",
};

interface ViewState {
  phase: "loading" | "ready" | "waiting" | "updating" | "error";
  market: DataMarket | null;
  history: History | null;
  error: unknown;
}

const START: ViewState = { phase: "loading", market: null, history: null, error: null };

const isUpdating = (error: unknown): boolean => error instanceof ApiError && error.status === 409 && error.code === "updating";

/**
 * Reads the market's price and its history from market-data. With `afterSequence` (the trade sequence of the caller's
 * own order, DM-17) market-data answers 409 `updating` until it has that trade: the view asks again every half second
 * for about two seconds, then says the chart is still updating and offers "Check again".
 */
function MarketDataView({ marketId, interval, afterSequence, onCheckAgain }: { marketId: string; interval: HistoryInterval; afterSequence: number | undefined; onCheckAgain: () => void }) {
  const api = useApi();
  const [state, setState] = useState<ViewState>(START);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function read(attempt: number): Promise<void> {
      try {
        const [market, history] = await Promise.all([getDataMarket(api, marketId, afterSequence, controller.signal), getHistory(api, marketId, interval, afterSequence, controller.signal)]);
        if (!cancelled) setState({ phase: "ready", market, history, error: null });
      } catch (error) {
        if (cancelled) return;
        if (isUpdating(error)) {
          if (attempt >= UPDATE_ATTEMPTS) {
            setState((previous) => ({ ...previous, phase: "updating" }));
            return;
          }
          setState((previous) => ({ ...previous, phase: "waiting" }));
          timer = setTimeout(() => void read(attempt + 1), UPDATE_WAIT_MS);
          return;
        }
        setState({ ...START, phase: "error", error });
      }
    }

    void read(1);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, marketId, interval, afterSequence]);

  if (state.phase === "loading") return <StatusMessage>Loading the price...</StatusMessage>;
  if (state.phase === "waiting") return <StatusMessage>Waiting for your trade to reach the price chart...</StatusMessage>;
  if (state.phase === "updating") {
    return (
      <div className="notice-box" role="status">
        <p>
          <strong>Updating.</strong> The price chart does not show your trade yet; it catches up within a moment. Your trade is made and your balance is right.
        </p>
        <button type="button" className="button button-quiet" onClick={onCheckAgain}>
          Check again
        </button>
      </div>
    );
  }
  if (state.phase === "error" || !state.market || !state.history) {
    const notReady = state.error instanceof ApiError && state.error.status === 404;
    return (
      <div>
        <ProblemDisplay error={state.error} heading={notReady ? "The price data of this market is not ready yet" : "The price chart is not available right now"} />
        <p>Trading does not need the chart. You can still buy and sell.</p>
        <button type="button" className="button button-quiet" onClick={onCheckAgain}>
          Try again
        </button>
      </div>
    );
  }
  const market = state.market;
  const invalid = market.status === "resolved" && market.outcome === "INVALID";
  return (
    <>
      <dl className="details">
        <dt>{invalid ? "Last YES price" : "YES price"}</dt>
        <dd>{formatPrice(market.currentPriceYesMicro)}</dd>
        <dt>{invalid ? "Last NO price" : "NO price"}</dt>
        <dd>{formatPrice(noPrice(market.currentPriceYesMicro))}</dd>
        <dt>Traded</dt>
        <dd>
          {formatMicroCredits(market.volumeMicro)} in {market.tradeCount} {market.tradeCount === 1 ? "trade" : "trades"}
        </dd>
        <dt>Last trade</dt>
        <dd>{market.lastTradeAt ? <Time value={market.lastTradeAt} /> : "No trade yet"}</dd>
      </dl>
      <PriceChart history={state.history} />
    </>
  );
}

/** The price of a market and its history chart; the interval is the reader's choice, `afterSequence` the sequence of their latest trade. */
export function MarketDataPanel({ marketId, afterSequence }: { marketId: string; afterSequence: number | undefined }) {
  const [span, setSpan] = useState<HistoryInterval>("1h");
  const [round, setRound] = useState(0);
  return (
    <section aria-labelledby="price-heading" className="data-panel">
      <h2 id="price-heading">Price</h2>
      <div className="field">
        <label htmlFor="chart-interval">Chart interval</label>
        <select id="chart-interval" value={span} onChange={(event) => setSpan(event.target.value as HistoryInterval)}>
          {HISTORY_INTERVALS.map((entry) => (
            <option key={entry} value={entry}>
              {INTERVAL_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      <MarketDataView key={`${span}|${afterSequence ?? 0}|${round}`} marketId={marketId} interval={span} afterSequence={afterSequence} onCheckAgain={() => setRound((value) => value + 1)} />
    </section>
  );
}
