import { useId, useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { getQuote, ORDER_AMOUNT_MAX, ORDER_AMOUNT_MIN, placeOrder } from "../../api/trading";
import type { Order, Quote, Side } from "../../api/trading";
import { Field } from "../../components/Field";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { formatAmount } from "../../lib/format";
import { wholeNumberInRange } from "../../lib/numbers";
import { formatMicroCredits, formatPrice, formatPriceLimit, formatShares, maxAveragePriceFor } from "../../lib/units";
import { useFocusOnShow } from "../../lib/use-focus-on-show";
import { useIdempotencyKey } from "../../lib/use-idempotency-key";
import { isMarketNotOpen, isOutcomeUnknown, orderSignature, PendingTrade, readStoredOrder, SideChoice, TradeAdvice } from "./trade-parts";
import type { StoredOrder } from "./trade-parts";

const AMOUNT_RULE = `Enter a whole number of credits from ${ORDER_AMOUNT_MIN} to ${ORDER_AMOUNT_MAX.toLocaleString("en-US")}.`;

interface BuyFormProps {
  marketId: string;
  /** Called with the answer of a buy that went through, so the page shows the new balance and position and waits for the chart. */
  onTraded: (order: Order) => void;
  /** The service says the market is not open (it closed meanwhile): the page reads the market again. */
  onNotOpen: () => void;
}

/**
 * Buy YES or NO shares for a whole number of credits (UC-05): first a quote (what the cheapest offers give for that
 * amount), then the order. The order carries an Idempotency-Key made once per attempt, kept while the same order is
 * repeated after a 503 or a lost answer, and the highest average price the person accepts: the quoted one plus 1 %
 * (DM-18), so a price that moves away in between refuses the order instead of filling it. A refusal for the price shows
 * the new quote and asks again.
 *
 * The key and the whole order (the price limit included, which the service checks with the key) are kept per market in
 * sessionStorage (see useIdempotencyKey). A reload loses the quote, and a new quote usually has another price limit, which
 * is another request: so an order without a settling answer is offered again exactly as it was sent ("An order you sent
 * earlier may have gone through"), to send again under its own key or to forget on the person's decision.
 */
export function BuyForm({ marketId, onTraded, onNotOpen }: BuyFormProps) {
  const api = useApi();
  const keys = useIdempotencyKey(`buy:${marketId}`);
  const name = useId();
  const [side, setSide] = useState<Side>("YES");
  const [amountText, setAmountText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [quoted, setQuoted] = useState<{ side: Side; amount: number; quote: Quote } | null>(null);
  const [busy, setBusy] = useState<"quote" | "order" | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  // The failure of the order itself (not of the quote) left it unknown whether the order was made.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [bought, setBought] = useState<Order | null>(null);
  const resultRef = useFocusOnShow<HTMLParagraphElement>(bought !== null);

  const amount = wholeNumberInRange(amountText, ORDER_AMOUNT_MIN, ORDER_AMOUNT_MAX);
  // A quote is only good for the side and the amount it was made for.
  const quote = quoted && quoted.side === side && quoted.amount === amount ? quoted.quote : null;
  // An order that was sent earlier and has no settling answer (a reload lost it and the quote it was made from), unless the
  // quote on the screen is that very order: its own button sends it again under the same key.
  const earlier = keys.pending ? readStoredOrder(keys.pending.payload, marketId) : null;
  const quoteIsEarlier = earlier !== null && quote !== null && amount !== null && orderSignature({ marketId, side, amount, maxAveragePriceMicro: maxAveragePriceFor(quote.averagePriceMicro) }) === orderSignature(earlier);
  const earlierShown = earlier !== null && !quoteIsEarlier;

  function forgetEarlier() {
    keys.discard();
    setFailure(null);
    setOutcomeUnknown(false);
    setNotice("The earlier order was forgotten. If it was made, it is in your portfolio; a new order is a new request.");
  }

  async function requestQuote(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setOutcomeUnknown(false);
    setNotice(null);
    setBought(null);
    if (amount === null) {
      setFieldError(AMOUNT_RULE);
      return;
    }
    setFieldError(null);
    setBusy("quote");
    try {
      setQuoted({ side, amount, quote: await getQuote(api, marketId, side, amount) });
    } catch (error) {
      setQuoted(null);
      setFailure(error);
      if (isMarketNotOpen(error)) onNotOpen();
    } finally {
      setBusy(null);
    }
  }

  function buy() {
    if (!quote || amount === null) return Promise.resolve();
    return send({ marketId, side, amount, maxAveragePriceMicro: maxAveragePriceFor(quote.averagePriceMicro) });
  }

  /**
   * Sends one order under the key of its request (every field, the price limit included), whether it comes from the quote
   * on the screen or is the earlier request that a reload left pending: the same request keeps its key.
   */
  async function send(order: StoredOrder) {
    setFailure(null);
    setOutcomeUnknown(false);
    setNotice(null);
    setBusy("order");
    try {
      const response = await placeOrder(api, order, keys.keyFor(orderSignature(order), order));
      keys.done();
      setBought(response.data);
      setQuoted(null);
      setAmountText("");
      onTraded(response.data);
    } catch (error) {
      keys.done(error);
      if (error instanceof ApiError && error.status === 409 && error.code === "price_limit_exceeded") {
        // The price moved away after the quote: show the new quote and let the person decide again.
        try {
          // For an earlier order that a reload left pending, the form shows the side and the amount it was made for.
          setSide(order.side);
          setAmountText(String(order.amount));
          setQuoted({ side: order.side, amount: order.amount, quote: await getQuote(api, marketId, order.side, order.amount) });
          setNotice("The price moved while you were deciding, so nothing was bought. This is the new quote: buy again if you still want to.");
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

  return (
    <form className="card" onSubmit={(event) => void requestQuote(event)} noValidate aria-labelledby={`${name}-title`} aria-busy={busy !== null}>
      <h3 id={`${name}-title`}>Buy shares</h3>
      <p>A share pays 1.00 credit if its side turns out right and nothing if not.</p>
      {earlierShown && earlier ? (
        <PendingTrade
          kind="order"
          summary={`You asked to buy ${earlier.side} shares for ${earlier.amount.toLocaleString("en-US")} credits, at an average price of at most ${formatPriceLimit(earlier.maxAveragePriceMicro)} per share.`}
          disabled={busy !== null}
          onSend={() => void send(earlier)}
          onForget={forgetEarlier}
        />
      ) : null}
      <SideChoice
        name={`${name}-side`}
        legend="Side to buy"
        value={side}
        disabled={busy !== null}
        describe={(entry) => `${entry}: pays 1.00 credit per share if the answer is ${entry}`}
        onChange={(entry) => {
          setSide(entry);
          setNotice(null);
        }}
      />
      <Field
        id={`${name}-amount`}
        label="Amount to spend, in credits"
        hint={amount === null ? `${AMOUNT_RULE} 1 credit = 1 EUR cent.` : `That is ${formatAmount(amount)}.`}
        error={fieldError}
      >
        {(control) => <input {...control} type="text" inputMode="numeric" autoComplete="off" value={amountText} disabled={busy !== null} onChange={(event) => setAmountText(event.target.value)} />}
      </Field>
      <button type="submit" className="button button-quiet" disabled={busy !== null}>
        Get a quote
      </button>
      {busy === "quote" ? <StatusMessage>Getting the quote...</StatusMessage> : null}
      {notice ? (
        <p className="notice-box" role="status">
          {notice}
        </p>
      ) : null}
      {quote ? (
        <div className="quote" aria-live="polite">
          <p>
            For <strong>{formatAmount(quote.amount)}</strong> you get about <strong>{formatShares(quote.sharesMicro)}</strong> {quote.side} shares at an average price of{" "}
            <strong>{formatPrice(quote.averagePriceMicro)}</strong> per share (the last share costs {formatPrice(quote.worstPriceMicro)}).
          </p>
          <p>
            If the answer is {quote.side} they pay {formatMicroCredits(quote.sharesMicro)}; if not, nothing. The order is refused if the average price would go above{" "}
            {formatPriceLimit(maxAveragePriceFor(quote.averagePriceMicro))}.
          </p>
          <button type="button" className="button" disabled={busy !== null} onClick={() => void buy()}>
            {`Buy ${quote.side} shares for ${quote.amount.toLocaleString("en-US")} credits`}
          </button>
        </div>
      ) : null}
      {busy === "order" ? <StatusMessage>Placing your order...</StatusMessage> : null}
      {failure ? (
        <>
          <ProblemDisplay error={failure} heading={outcomeUnknown ? "We do not know yet whether the order went through" : "Nothing was bought"} />
          <TradeAdvice error={failure} outcomeUnknown={outcomeUnknown} pendingShown={earlierShown} />
        </>
      ) : null}
      {bought ? (
        <p className="success" role="status" tabIndex={-1} ref={resultRef}>
          Bought <strong>{formatShares(bought.sharesMicro)}</strong> {bought.side} shares for {formatMicroCredits(bought.costMicro)} at an average price of {formatPrice(bought.averagePriceMicro)}. Your
          balance is now <strong>{formatMicroCredits(bought.balanceMicro)}</strong>.
        </p>
      ) : null}
    </form>
  );
}
