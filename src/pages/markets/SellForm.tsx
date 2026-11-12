import { useId, useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { getSaleQuote, sellShares } from "../../api/trading";
import type { Position, Sale, SaleQuote, Side } from "../../api/trading";
import { Field } from "../../components/Field";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { formatMicroCredits, formatPrice, formatShares, microToDecimalText, minProceedsFor, parseSharesText } from "../../lib/units";
import { useFocusOnShow } from "../../lib/use-focus-on-show";
import { useIdempotencyKey } from "../../lib/use-idempotency-key";
import { isMarketNotOpen, isOutcomeUnknown, PendingTrade, readStoredSale, saleSignature, SideChoice, TradeAdvice } from "./trade-parts";
import type { StoredSale } from "./trade-parts";

interface SellFormProps {
  marketId: string;
  /** What the person holds in this market now. */
  position: Pick<Position, "yesMicro" | "noMicro">;
  onTraded: (sale: Sale) => void;
  onNotOpen: () => void;
}

const heldOf = (position: SellFormProps["position"], side: Side): number => (side === "YES" ? position.yesMicro : position.noMicro);

const SHARES_RULE = "Enter a number of shares, for example 12 or 12.5 (at most six decimals).";

/**
 * Sell shares before the market closes (UC-08): the same two steps as a buy, a sale quote and then the sale. A sale of
 * S shares of one side buys S shares of the other side from the market maker and redeems the pairs for credits; the
 * quote says what comes back. The sale carries an Idempotency-Key and `minProceedsMicro`, the quoted proceeds minus 1 %,
 * so a price that moves away refuses the sale instead of filling it.
 *
 * The key and the whole sale (the least proceeds included, which the service checks with the key) are kept per market in
 * sessionStorage (see useIdempotencyKey). A reload loses the quote, and a new quote usually has other proceeds, which is
 * another request: so a sale without a settling answer is offered again exactly as it was sent ("A sale you sent earlier
 * may have gone through"), to send again under its own key or to forget on the person's decision.
 */
export function SellForm({ marketId, position, onTraded, onNotOpen }: SellFormProps) {
  const api = useApi();
  const keys = useIdempotencyKey(`sell:${marketId}`);
  const name = useId();
  const [side, setSide] = useState<Side>("YES");
  const [sharesText, setSharesText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [quoted, setQuoted] = useState<{ side: Side; sharesMicro: number; quote: SaleQuote } | null>(null);
  const [busy, setBusy] = useState<"quote" | "sale" | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  // The failure of the sale itself (not of the quote) left it unknown whether the sale was made.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sold, setSold] = useState<Sale | null>(null);
  const resultRef = useFocusOnShow<HTMLParagraphElement>(sold !== null);

  const held = heldOf(position, side);
  const sharesMicro = parseSharesText(sharesText);
  const quote = quoted && quoted.side === side && quoted.sharesMicro === sharesMicro ? quoted.quote : null;
  // A sale that was sent earlier and has no settling answer (a reload lost it and the quote it was made from), unless the
  // quote on the screen is that very sale: its own button sends it again under the same key.
  const earlier = keys.pending ? readStoredSale(keys.pending.payload, marketId) : null;
  const quoteIsEarlier = earlier !== null && quote !== null && sharesMicro !== null && saleSignature({ marketId, side, sharesMicro, minProceedsMicro: minProceedsFor(quote.proceedsMicro) }) === saleSignature(earlier);
  const earlierShown = earlier !== null && !quoteIsEarlier;

  function forgetEarlier() {
    keys.discard();
    setFailure(null);
    setOutcomeUnknown(false);
    setNotice("The earlier sale was forgotten. If it was made, it is in your portfolio; a new sale is a new request.");
  }

  function problemWithShares(): string | null {
    if (sharesMicro === null) return SHARES_RULE;
    if (sharesMicro > held) return `You hold ${formatShares(held)} ${side} shares in this market.`;
    return null;
  }

  async function requestQuote(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setOutcomeUnknown(false);
    setNotice(null);
    setSold(null);
    const problem = problemWithShares();
    setFieldError(problem);
    if (problem || sharesMicro === null) return;
    setBusy("quote");
    try {
      setQuoted({ side, sharesMicro, quote: await getSaleQuote(api, marketId, side, sharesMicro) });
    } catch (error) {
      setQuoted(null);
      setFailure(error);
      if (isMarketNotOpen(error)) onNotOpen();
    } finally {
      setBusy(null);
    }
  }

  function sell() {
    if (!quote || sharesMicro === null) return Promise.resolve();
    return send({ marketId, side, sharesMicro, minProceedsMicro: minProceedsFor(quote.proceedsMicro) });
  }

  /**
   * Sends one sale under the key of its request (every field, the least proceeds included), whether it comes from the
   * quote on the screen or is the earlier request that a reload left pending: the same request keeps its key.
   */
  async function send(request: StoredSale) {
    setFailure(null);
    setOutcomeUnknown(false);
    setNotice(null);
    setBusy("sale");
    try {
      const response = await sellShares(api, request, keys.keyFor(saleSignature(request), request));
      keys.done();
      setSold(response.data);
      setQuoted(null);
      setSharesText("");
      onTraded(response.data);
    } catch (error) {
      keys.done(error);
      if (error instanceof ApiError && error.status === 409 && error.code === "proceeds_below_minimum") {
        // The price moved away after the quote: show the new quote and let the person decide again.
        try {
          // For an earlier sale that a reload left pending, the form shows the side and the shares it was made for.
          setSide(request.side);
          setSharesText(microToDecimalText(request.sharesMicro));
          setQuoted({ side: request.side, sharesMicro: request.sharesMicro, quote: await getSaleQuote(api, marketId, request.side, request.sharesMicro) });
          setNotice("The price moved while you were deciding, so nothing was sold. This is the new quote: sell again if you still want to.");
        } catch (quoteError) {
          setQuoted(null);
          setFailure(quoteError);
        }
      } else {
        setFailure(error);
        setOutcomeUnknown(isOutcomeUnknown(error));
        if (isMarketNotOpen(error)) onNotOpen();
      }
    } finally {
      setBusy(null);
    }
  }

  const earlierBox =
    earlierShown && earlier ? (
      <PendingTrade
        kind="sale"
        summary={`You asked to sell ${formatShares(earlier.sharesMicro)} ${earlier.side} shares and to receive at least ${formatMicroCredits(earlier.minProceedsMicro)}.`}
        disabled={busy !== null}
        onSend={() => void send(earlier)}
        onForget={forgetEarlier}
      />
    ) : null;

  const failureBox = failure ? (
    <>
      <ProblemDisplay error={failure} heading={outcomeUnknown ? "We do not know yet whether the sale went through" : "Nothing was sold"} />
      <TradeAdvice error={failure} outcomeUnknown={outcomeUnknown} pendingShown={earlierShown} />
    </>
  ) : null;

  if (position.yesMicro === 0 && position.noMicro === 0 && !sold) {
    return (
      <div className="card">
        <h3>Sell shares</h3>
        <p>You hold no shares in this market yet, so there is nothing to sell.</p>
        {earlierBox}
        {failureBox}
      </div>
    );
  }

  return (
    <form className="card" onSubmit={(event) => void requestQuote(event)} noValidate aria-labelledby={`${name}-title`} aria-busy={busy !== null}>
      <h3 id={`${name}-title`}>Sell shares</h3>
      <p>Selling gives the shares back at the current prices and returns the credits they are worth.</p>
      {earlierBox}
      <SideChoice
        name={`${name}-side`}
        legend="Side to sell"
        value={side}
        disabled={busy !== null}
        describe={(entry) => `${entry} (you hold ${formatShares(heldOf(position, entry))})`}
        onChange={(entry) => {
          setSide(entry);
          setNotice(null);
        }}
      />
      <Field id={`${name}-shares`} label="Shares to sell" hint={`You hold ${formatShares(held)} ${side} shares.`} error={fieldError}>
        {(control) => <input {...control} type="text" inputMode="decimal" autoComplete="off" value={sharesText} disabled={busy !== null} onChange={(event) => setSharesText(event.target.value)} />}
      </Field>
      <div className="actions">
        <button type="button" className="button button-quiet" disabled={busy !== null || held === 0} onClick={() => setSharesText(microToDecimalText(held))}>
          Sell all {side} shares
        </button>
        <button type="submit" className="button button-quiet" disabled={busy !== null}>
          Get a sale quote
        </button>
      </div>
      {busy === "quote" ? <StatusMessage>Getting the quote...</StatusMessage> : null}
      {notice ? (
        <p className="notice-box" role="status">
          {notice}
        </p>
      ) : null}
      {quote ? (
        <div className="quote" aria-live="polite">
          <p>
            Selling <strong>{formatShares(quote.sharesMicro)}</strong> {quote.side} shares returns about <strong>{formatMicroCredits(quote.proceedsMicro)}</strong>, on average{" "}
            {formatPrice(quote.averagePriceMicro)} per share.
          </p>
          {quote.proceedsMicro === 0 ? (
            <p>These shares would return nothing at the current prices, so they cannot be sold now.</p>
          ) : (
            <>
              <p>The sale is refused if it would return less than {formatMicroCredits(minProceedsFor(quote.proceedsMicro))}.</p>
              <button type="button" className="button" disabled={busy !== null} onClick={() => void sell()}>
                {`Sell ${formatShares(quote.sharesMicro)} ${quote.side} shares`}
              </button>
            </>
          )}
        </div>
      ) : null}
      {busy === "sale" ? <StatusMessage>Selling...</StatusMessage> : null}
      {failureBox}
      {sold ? (
        <p className="success" role="status" tabIndex={-1} ref={resultRef}>
          Sold <strong>{formatShares(sold.sharesMicro)}</strong> {sold.side} shares and received {formatMicroCredits(sold.proceedsMicro)}. Your balance is now{" "}
          <strong>{formatMicroCredits(sold.balanceMicro)}</strong>.
        </p>
      ) : null}
    </form>
  );
}
