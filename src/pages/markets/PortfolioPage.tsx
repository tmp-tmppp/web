import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api/ApiContext";
import { getDataMarkets } from "../../api/market-data";
import type { DataMarket } from "../../api/market-data";
import { getPortfolio, PORTFOLIO_ENTRIES } from "../../api/trading";
import type { PayoutEntry, Portfolio, PortfolioPosition, TradeEntry, TradingStatus } from "../../api/trading";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";
import { formatAmount } from "../../lib/format";
import { formatMicroCredits, formatPrice, formatShares, positionValueMicro } from "../../lib/units";
import { useTenantRole } from "./use-tenant-role";
import type { TenantRole } from "./use-tenant-role";
import { STATUS_LABELS, statusWithOutcome } from "./wording";

type State =
  | { phase: "loading" }
  | { phase: "error"; error: unknown }
  /** `markets` is null when market-data could not be asked: the portfolio is shown without current prices. */
  | { phase: "ready"; portfolio: Portfolio; markets: Map<string, DataMarket> | null; pricesError: unknown };

/** Every market the portfolio mentions: one batch of ids for market-data (DM-12), never one call per position. */
function marketIds(portfolio: Portfolio): string[] {
  return [
    ...portfolio.positions.map((position) => position.marketId),
    ...portfolio.recentTrades.map((trade) => trade.marketId),
    ...portfolio.payouts.map((payout) => payout.marketId),
  ];
}

const TRADING_STATUS_LABELS: Record<TradingStatus, string> = { funded: "Opening", open: STATUS_LABELS.open, closed: STATUS_LABELS.closed, resolved: STATUS_LABELS.resolved };

function MarketCell({ marketId, names }: { marketId: string; names: Map<string, string> }) {
  return <Link to={`/markets/${marketId}`}>{names.get(marketId) ?? `Market ${marketId.slice(0, 8)}`}</Link>;
}

/** What the position is worth at the market's current YES price; its words when the market has no price to use. */
function valueText(position: PortfolioPosition, market: DataMarket | undefined): string {
  if (!market) return "-";
  if (market.outcome === "INVALID") return "Voided (refunded)";
  return formatMicroCredits(positionValueMicro(position.yesMicro, position.noMicro, market.currentPriceYesMicro));
}

function PositionsTable({ positions, markets, names }: { positions: PortfolioPosition[]; markets: Map<string, DataMarket> | null; names: Map<string, string> }) {
  const priced = positions.map((position) => markets?.get(position.marketId));
  const total = positions.reduce((sum, position, index) => {
    const market = priced[index];
    return market && market.outcome !== "INVALID" ? sum + positionValueMicro(position.yesMicro, position.noMicro, market.currentPriceYesMicro) : sum;
  }, 0);
  return (
    <>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Your positions</caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Status</th>
              <th scope="col">YES shares</th>
              <th scope="col">NO shares</th>
              <th scope="col">YES price</th>
              <th scope="col">Worth now</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position, index) => {
              const market = priced[index];
              return (
                <tr key={position.marketId}>
                  <th scope="row">
                    <MarketCell marketId={position.marketId} names={names} />
                  </th>
                  <td>{market ? statusWithOutcome(market.status, market.outcome) : position.status ? TRADING_STATUS_LABELS[position.status] : "-"}</td>
                  <td>{formatShares(position.yesMicro)}</td>
                  <td>{formatShares(position.noMicro)}</td>
                  <td>{market ? formatPrice(market.currentPriceYesMicro) : "-"}</td>
                  <td>{valueText(position, market)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {markets ? <p>Your positions are worth about {formatMicroCredits(total)} at the current prices.</p> : null}
    </>
  );
}

function TradesTable({ trades, names }: { trades: TradeEntry[]; names: Map<string, string> }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Your recent trades, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Market</th>
            <th scope="col">Trade</th>
            <th scope="col">Shares</th>
            <th scope="col">Credits</th>
            <th scope="col">Average price</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr key={trade.tradeId}>
              <td>
                <Time value={trade.executedAt} />
              </td>
              <th scope="row">
                <MarketCell marketId={trade.marketId} names={names} />
              </th>
              <td>{trade.kind === "buy" ? `Bought ${trade.side}` : `Sold ${trade.side}`}</td>
              <td>{formatShares(trade.sharesMicro)}</td>
              <td>{trade.kind === "buy" ? `Paid ${formatMicroCredits(trade.costMicro)}` : `Received ${formatMicroCredits(trade.proceedsMicro ?? 0)}`}</td>
              <td>{formatPrice(trade.averagePriceMicro)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PAYOUT_KIND: Record<PayoutEntry["kind"], string> = {
  winnings: "Winnings",
  refund: "Refund of a market resolved INVALID",
  returned: "Funding that came back to you",
};

function PayoutsTable({ payouts, names }: { payouts: PayoutEntry[]; names: Map<string, string> }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Your payouts, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Market</th>
            <th scope="col">Kind</th>
            <th scope="col">Credits</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((payout, index) => (
            <tr key={`${payout.marketId}-${payout.kind}-${index}`}>
              <td>
                <Time value={payout.paidAt} />
              </td>
              <th scope="row">
                <MarketCell marketId={payout.marketId} names={names} />
              </th>
              <td>{PAYOUT_KIND[payout.kind]}</td>
              <td>{formatMicroCredits(payout.amountMicro)}</td>
              <td>{payout.outcome ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FundedMarkets({ markets }: { markets: NonNullable<Portfolio["fundedMarkets"]> }) {
  return (
    <section aria-labelledby="funded-heading">
      <h2 id="funded-heading">Markets you funded</h2>
      {markets.length === 0 ? (
        <p>You have not funded a market yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Markets funded by you and what came back</caption>
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col">Status</th>
                <th scope="col">Funding</th>
                <th scope="col">Came back</th>
                <th scope="col">Settled</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((funded) => (
                <tr key={funded.marketId}>
                  <th scope="row">
                    <Link to={`/markets/${funded.marketId}`}>{funded.question ?? `Market ${funded.marketId.slice(0, 8)}`}</Link>
                  </th>
                  <td>{funded.status ? TRADING_STATUS_LABELS[funded.status] : "-"}</td>
                  <td>{funded.fundingMicro === null ? "-" : formatMicroCredits(funded.fundingMicro)}</td>
                  <td>{funded.returnedMicro === null ? "Not yet" : formatMicroCredits(funded.returnedMicro)}</td>
                  <td>{funded.settledAt ? <Time value={funded.settledAt} /> : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PortfolioView({ role }: { role: TenantRole }) {
  const api = useApi();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      try {
        const portfolio = await getPortfolio(api, PORTFOLIO_ENTRIES, controller.signal);
        let markets: Map<string, DataMarket> | null = null;
        let pricesError: unknown = null;
        const ids = marketIds(portfolio);
        if (ids.length === 0) markets = new Map();
        else {
          try {
            markets = new Map((await getDataMarkets(api, ids, controller.signal)).map((market) => [market.marketId, market]));
          } catch (error) {
            if (controller.signal.aborted) return;
            pricesError = error;
          }
        }
        if (!controller.signal.aborted) setState({ phase: "ready", portfolio, markets, pricesError });
      } catch (error) {
        if (!controller.signal.aborted) setState({ phase: "error", error });
      }
    }
    void read();
    return () => controller.abort();
  }, [api, round]);

  const refresh = () => {
    setState({ phase: "loading" });
    setRound((value) => value + 1);
  };

  if (state.phase === "loading") return <StatusMessage>Loading your portfolio...</StatusMessage>;
  if (state.phase === "error") {
    return (
      <section>
        <h1>Portfolio</h1>
        <ProblemDisplay error={state.error} heading="Your portfolio could not be loaded" />
        <button type="button" className="button button-quiet" onClick={refresh}>
          Try again
        </button>
      </section>
    );
  }

  const { portfolio, markets, pricesError } = state;
  // Names for the links: the question from market-data, or from trading's own copy for a position.
  const names = new Map<string, string>();
  for (const position of portfolio.positions) if (position.question) names.set(position.marketId, position.question);
  for (const funded of portfolio.fundedMarkets ?? []) if (funded.question) names.set(funded.marketId, funded.question);
  for (const market of markets?.values() ?? []) names.set(market.marketId, market.question);

  return (
    <section>
      <h1>Portfolio</h1>
      <dl className="details">
        <dt>Balance</dt>
        <dd>{formatMicroCredits(portfolio.balanceMicro)}</dd>
        <dt>You can withdraw</dt>
        <dd>
          {formatAmount(portfolio.withdrawableCredits)} <Link to="/wallet">Go to the wallet</Link>
        </dd>
      </dl>
      <div className="actions">
        <button type="button" className="button button-quiet" onClick={refresh}>
          Refresh
        </button>
      </div>
      {pricesError ? (
        <div className="notice-box" role="status">
          <p>Current prices are not available right now, so the positions are shown without them. Everything else is up to date.</p>
        </div>
      ) : null}

      <h2>Positions</h2>
      {portfolio.positions.length === 0 ? <p>You hold no shares in any market yet. Open a market and buy some.</p> : <PositionsTable positions={portfolio.positions} markets={markets} names={names} />}

      <h2>Trades</h2>
      {portfolio.recentTrades.length === 0 ? <p>You have not traded yet.</p> : <TradesTable trades={portfolio.recentTrades} names={names} />}

      <h2>Payouts</h2>
      {portfolio.payouts.length === 0 ? <p>No payout yet: winnings, refunds and returned funding appear here when a market is resolved.</p> : <PayoutsTable payouts={portfolio.payouts} names={names} />}
      {portfolio.recentTrades.length >= PORTFOLIO_ENTRIES || portfolio.payouts.length >= PORTFOLIO_ENTRIES ? <p className="notice">Only the newest {PORTFOLIO_ENTRIES} trades and payouts are shown.</p> : null}

      {role === "tenant-admin" && portfolio.fundedMarkets !== null ? <FundedMarkets markets={portfolio.fundedMarkets} /> : null}
    </section>
  );
}

/**
 * The caller's portfolio (UC-06): balance, positions with their current prices, trades, payouts and refunds; tenant
 * admins also see the markets they funded and what came back. The numbers come from trading in micro-units; the prices
 * of all positions from market-data in one batch call (DM-12), and without them the rest still shows.
 */
export function PortfolioPage() {
  const role = useTenantRole();
  if (!role) return null;
  return <PortfolioView role={role} />;
}
