import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../../api/ApiContext";
import { getMarket } from "../../api/markets";
import type { Market } from "../../api/markets";
import { useAuth } from "../../auth/AuthContext";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { ShareDialog } from "../../components/ShareDialog";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";
import { formatAmount } from "../../lib/format";
import { usePolling } from "../../lib/use-polling";
import { AdminActions } from "./AdminActions";
import { MarketDataPanel } from "./MarketDataPanel";
import { TradePanel } from "./TradePanel";
import { useTenantRole } from "./use-tenant-role";
import type { TenantRole } from "./use-tenant-role";
import { hasMarketData, OUTCOME_TEXT, STATUS_HINTS, STATUS_LABELS } from "./wording";

/** A market that is being opened is read again every 2 seconds, for up to 2 minutes, then the page offers a button (the service goes on in the background). */
export const OPENING_POLL_MS = 2000;
export const OPENING_POLL_MAX = 60;

const isSettled = (market: Market): boolean => market.status !== "opening";

/** The market while its funding is unconfirmed (the 202 of "open"): follows it until it is open, or back to a draft. */
function OpeningWatcher({ marketId, onUpdate }: { marketId: string; onUpdate: (market: Market) => void }) {
  const api = useApi();
  const load = useCallback((signal: AbortSignal) => getMarket(api, marketId, signal), [api, marketId]);
  const poll = usePolling({ load, isDone: isSettled, intervalMs: OPENING_POLL_MS, maxAttempts: OPENING_POLL_MAX });
  useEffect(() => {
    if (poll.data) onUpdate(poll.data);
  }, [poll.data, onUpdate]);
  return (
    <div className="notice-box" role="status">
      <p>
        <strong>Opening.</strong> The funding of this market is being confirmed.{" "}
        {poll.stopped ? "This page has stopped following it." : "This page follows it and updates by itself."}
      </p>
      {poll.error ? <ProblemDisplay error={poll.error} heading="The status could not be read" /> : null}
      {poll.timedOut || poll.stopped ? (
        <>
          <p>
            {poll.timedOut
              ? "This takes longer than usual. The market goes on opening in the background; nothing is lost."
              : "The market goes on opening in the background; nothing is lost. Check again to see where it stands."}
          </p>
          <button type="button" className="button button-quiet" onClick={poll.checkNow}>
            Check again
          </button>
        </>
      ) : null}
    </div>
  );
}

function MarketHeader({ market, role }: { market: Market; role: TenantRole }) {
  return (
    <header>
      <h1>{market.question}</h1>
      <dl className="details">
        <dt>Status</dt>
        <dd>
          <strong>{STATUS_LABELS[market.status]}</strong> <span className="badge">{STATUS_HINTS[market.status]}</span>
        </dd>
        <dt>Closes</dt>
        <dd>
          <Time value={market.closeTime} />
        </dd>
        {market.status === "resolved" && market.outcome ? (
          <>
            <dt>Outcome</dt>
            <dd>
              <strong>{market.outcome}</strong> <span className="badge">{OUTCOME_TEXT[market.outcome]}</span>
            </dd>
          </>
        ) : null}
        {market.description !== "" ? (
          <>
            <dt>Description</dt>
            <dd className="multiline">{market.description}</dd>
          </>
        ) : null}
        {role === "tenant-admin" ? (
          <>
            <dt>Funding</dt>
            <dd>{formatAmount(market.fundingAmount)}</dd>
          </>
        ) : null}
      </dl>
    </header>
  );
}

interface MarketState {
  market: Market | null;
  error: unknown;
}

function MarketView({ marketId, role, userId }: { marketId: string; role: TenantRole; userId: string }) {
  const api = useApi();
  const [state, setState] = useState<MarketState>({ market: null, error: null });
  const [round, setRound] = useState(0);
  // The trade sequence of the latest trade of this person: market-data answers with the chart that holds it (DM-17).
  const [sequence, setSequence] = useState<number | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    getMarket(api, marketId, controller.signal).then(
      (market) => setState({ market, error: null }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ market: null, error });
      },
    );
    return () => controller.abort();
  }, [api, marketId, round]);

  const changed = useCallback((market: Market) => setState({ market, error: null }), []);
  const reload = useCallback(() => setRound((value) => value + 1), []);

  const { market, error } = state;
  if (error) {
    return (
      <section>
        <h1>Market</h1>
        <ProblemDisplay error={error} heading="The market could not be loaded" />
        <p>
          <Link to="/markets">Back to the markets</Link>
        </p>
        <button type="button" className="button button-quiet" onClick={reload}>
          Try again
        </button>
      </section>
    );
  }
  if (!market) return <StatusMessage>Loading the market...</StatusMessage>;

  const admin = role === "tenant-admin";
  const priced = hasMarketData(market.status);
  return (
    <article>
      <p>
        <Link to="/markets">All markets</Link>
      </p>
      <MarketHeader market={market} role={role} />
      {market.status === "opening" ? <OpeningWatcher marketId={market.id} onUpdate={changed} /> : null}
      {admin ? <AdminActions market={market} userId={userId} onChanged={changed} onReload={reload} /> : null}
      {admin && market.status === "open" ? <p className="notice">Tenant admins manage the markets and do not trade in them.</p> : null}
      {priced ? <MarketDataPanel marketId={market.id} afterSequence={sequence} /> : null}
      {!admin && priced ? <TradePanel marketId={market.id} open={market.status === "open"} resolved={market.status === "resolved"} onTrade={setSequence} onNotOpen={reload} /> : null}
      <ShareDialog key={market.id} marketId={market.id} sharing={market.sharing} role={role} marketStatus={market.status} />
    </article>
  );
}

/**
 * One market (UC-04 to UC-08, UC-10 to UC-12, UC-16): the header from the markets service, the price and its history
 * from market-data, buy and sell for traders, the lifecycle actions for tenant admins, and the share dialog. A page for
 * the market of the address; a trader asking for a draft gets the service's 404, shown as "not found".
 */
export function MarketPage() {
  const { marketId } = useParams();
  const { user } = useAuth();
  const role = useTenantRole();
  if (!marketId || !user || !role) return null;
  return <MarketView key={marketId} marketId={marketId} role={role} userId={user.id} />;
}
