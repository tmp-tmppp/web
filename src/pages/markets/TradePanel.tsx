import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { getPortfolio } from "../../api/trading";
import type { Order, Sale } from "../../api/trading";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { formatMicroCredits, formatShares } from "../../lib/units";
import { BuyForm } from "./BuyForm";
import { SellForm } from "./SellForm";

interface Account {
  balanceMicro: number;
  yesMicro: number;
  noMicro: number;
}

type AccountState = { phase: "loading"; account: null; error: null } | { phase: "ready"; account: Account; error: null } | { phase: "error"; account: null; error: unknown };

interface TradePanelProps {
  marketId: string;
  /** Trading is open only while the market is open; otherwise the panel shows the position and says why there is no form. */
  open: boolean;
  resolved: boolean;
  /** A trade went through: the trade sequence the price chart must wait for (DM-17). */
  onTrade: (tradeSequence: number) => void;
  /** The service says the market is not open any more. */
  onNotOpen: () => void;
}

/**
 * The trader's part of the market page: the balance and the position in this market (read from the portfolio, and after
 * every trade taken from the answer of that trade, which carries both: DM-17), and the buy and sell forms while the
 * market is open. Tenant admins never see this panel: they do not trade (the service answers 403).
 */
export function TradePanel({ marketId, open, resolved, onTrade, onNotOpen }: TradePanelProps) {
  const api = useApi();
  const [state, setState] = useState<AccountState>({ phase: "loading", account: null, error: null });
  const [round, setRound] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getPortfolio(api, 1, controller.signal).then(
      (portfolio) => {
        const held = portfolio.positions.find((position) => position.marketId === marketId);
        setState({ phase: "ready", account: { balanceMicro: portfolio.balanceMicro, yesMicro: held?.yesMicro ?? 0, noMicro: held?.noMicro ?? 0 }, error: null });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ phase: "error", account: null, error });
      },
    );
    return () => controller.abort();
  }, [api, marketId, round]);

  const traded = useCallback(
    (answer: Order | Sale) => {
      setState({ phase: "ready", account: { balanceMicro: answer.balanceMicro, yesMicro: answer.position.yesMicro, noMicro: answer.position.noMicro }, error: null });
      onTrade(answer.tradeSequence);
    },
    [onTrade],
  );

  return (
    <section aria-labelledby="trade-heading">
      <h2 id="trade-heading">Trade</h2>
      {state.phase === "loading" ? <StatusMessage>Loading your balance...</StatusMessage> : null}
      {state.phase === "error" ? (
        <div>
          <ProblemDisplay error={state.error} heading="Your balance could not be loaded" />
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              setState({ phase: "loading", account: null, error: null });
              setRound((value) => value + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {state.phase === "ready" ? (
        <dl className="details">
          <dt>Your balance</dt>
          <dd>{formatMicroCredits(state.account.balanceMicro)}</dd>
          <dt>YES shares you hold</dt>
          <dd>{formatShares(state.account.yesMicro)}</dd>
          <dt>NO shares you hold</dt>
          <dd>{formatShares(state.account.noMicro)}</dd>
        </dl>
      ) : null}
      {open ? (
        <div className="two-columns">
          <BuyForm marketId={marketId} onTraded={traded} onNotOpen={onNotOpen} />
          {state.phase === "ready" ? <SellForm marketId={marketId} position={state.account} onTraded={traded} onNotOpen={onNotOpen} /> : null}
        </div>
      ) : (
        <p>{resolved ? "This market is resolved: no more trades. Winnings or refunds are in your portfolio." : "Trading in this market has stopped."}</p>
      )}
    </section>
  );
}
