import { Link } from "react-router";
import { ApiError } from "../../api/errors";
import { ORDER_AMOUNT_MAX, ORDER_AMOUNT_MIN, SIDES } from "../../api/trading";
import type { Side } from "../../api/trading";

/** Which side to buy or sell: two radio buttons in a group with a legend, so a screen reader names the choice. */
export function SideChoice({ name, legend, value, disabled, describe, onChange }: { name: string; legend: string; value: Side; disabled: boolean; describe: (side: Side) => string; onChange: (side: Side) => void }) {
  return (
    <fieldset disabled={disabled}>
      <legend>{legend}</legend>
      {SIDES.map((side) => (
        <div className="choice" key={side}>
          <label>
            <input type="radio" name={name} value={side} checked={value === side} onChange={() => onChange(side)} /> {describe(side)}
          </label>
        </div>
      ))}
    </fieldset>
  );
}

/** What a refused trade means for the person, beside the service's own title and detail (the problem's code decides). */
export function tradeAdvice(error: unknown): { text: string; walletLink?: boolean } | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case "insufficient_credits":
      return { text: "You do not have enough credits for this. Nothing was bought.", walletLink: true };
    case "insufficient_liquidity":
      return { text: "The market cannot take that much right now. Try a smaller amount; nothing was changed." };
    case "insufficient_shares":
      return { text: "You hold fewer shares of that side than you tried to sell. Nothing was sold." };
    case "market_not_open":
      return { text: "Trading in this market is not open: it may have just closed. Nothing was changed." };
    case "forbidden":
      return error.status === 403 ? { text: "Tenant admins do not trade in their tenant's markets: they resolve them." } : null;
    case "orders_paused":
      return { text: "New orders and sales are paused for a moment. Nothing was changed; try again after the wait below." };
    default:
      return null;
  }
}

/** True when an order or a sale may have been made although no usable answer came (ApiError.outcomeUnknown: no answer, or a 5xx other than 503 that names no refusal of trading). */
export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && error.outcomeUnknown;
}

const OUTCOME_UNKNOWN_ADVICE = "It may have been made. Press the same button again: the service makes the same request only once, so nothing is doubled. Do not ask for a new quote first.";
// After a reload the quote is gone, so the button of the quote does not exist: the box of the earlier request has the button.
const OUTCOME_UNKNOWN_ADVICE_BOX = "It may have been made. Use the button in the box above to send the same request again: the service makes the same request only once, so nothing is doubled.";

/**
 * The advice for a failed trade: what a refusal means (with the link to the wallet where credits are deposited), or, when
 * the outcome is unknown, to repeat the same request (with the button of the quote, or, when `pendingShown`, the button of
 * the box that offers the earlier request).
 */
export function TradeAdvice({ error, outcomeUnknown = false, pendingShown = false }: { error: unknown; outcomeUnknown?: boolean; pendingShown?: boolean }) {
  const advice: ReturnType<typeof tradeAdvice> = outcomeUnknown ? { text: pendingShown ? OUTCOME_UNKNOWN_ADVICE_BOX : OUTCOME_UNKNOWN_ADVICE } : tradeAdvice(error);
  if (!advice) return null;
  return (
    <p>
      {advice.text}
      {advice.walletLink ? (
        <>
          {" "}
          <Link to="/wallet">Go to the wallet</Link>
        </>
      ) : null}
    </p>
  );
}

/** An order exactly as it was sent: the quote's price limit is part of it, and of the service's idempotency check. */
export interface StoredOrder {
  marketId: string;
  side: Side;
  amount: number;
  maxAveragePriceMicro: number;
}

/** A sale exactly as it was sent. */
export interface StoredSale {
  marketId: string;
  side: Side;
  sharesMicro: number;
  minProceedsMicro: number;
}

/** The signature of an order for useIdempotencyKey: every field of the request, the price limit included. */
export const orderSignature = (order: StoredOrder): string => `buy:${order.marketId}:${order.side}:${order.amount}:${order.maxAveragePriceMicro}`;

/** The signature of a sale for useIdempotencyKey: every field of the request, the least proceeds included. */
export const saleSignature = (sale: StoredSale): string => `sell:${sale.marketId}:${sale.side}:${sale.sharesMicro}:${sale.minProceedsMicro}`;

const isSide = (value: unknown): value is Side => value === "YES" || value === "NO";
const isWhole = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** The order kept in the storage for this market, or null when it is not one (the storage is the person's to edit). */
export function readStoredOrder(payload: unknown, marketId: string): StoredOrder | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { marketId: stored, side, amount, maxAveragePriceMicro } = payload as Record<string, unknown>;
  if (stored !== marketId || !isSide(side) || !isWhole(amount, ORDER_AMOUNT_MIN, ORDER_AMOUNT_MAX) || !isWhole(maxAveragePriceMicro, 1, 999_999)) return null;
  return { marketId, side, amount, maxAveragePriceMicro };
}

/** The sale kept in the storage for this market, or null when it is not one. */
export function readStoredSale(payload: unknown, marketId: string): StoredSale | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { marketId: stored, side, sharesMicro, minProceedsMicro } = payload as Record<string, unknown>;
  if (stored !== marketId || !isSide(side) || !isWhole(sharesMicro, 1, Number.MAX_SAFE_INTEGER) || !isWhole(minProceedsMicro, 1, Number.MAX_SAFE_INTEGER)) return null;
  return { marketId, side, sharesMicro, minProceedsMicro };
}

/**
 * An order or a sale that was sent earlier and has no settling answer, found when the form opens (a reload lost the answer
 * and the quote the request was made from, so the form cannot rebuild it: a new quote usually has another price limit, which
 * is another request for the service). It offers to send exactly that request again under its own key, which the service
 * answers with the first result when it was made and makes once when it was not, or to forget it.
 */
export function PendingTrade({ kind, summary, disabled, onSend, onForget }: { kind: "order" | "sale"; summary: string; disabled: boolean; onSend: () => void; onForget: () => void }) {
  return (
    <div className="notice-box" role="group" aria-label={`Earlier ${kind}`}>
      <p>
        <strong>{`${kind === "order" ? "An order" : "A sale"} you sent earlier may have gone through`}</strong>
      </p>
      <p>
        {summary} The answer did not reach this page. Check your <Link to="/portfolio">portfolio</Link>, or send the same {kind} again: the service makes the same request only once, so nothing is doubled. Forget it only
        when you know it was not made: a new {kind} is a new request.
      </p>
      <div className="actions">
        <button type="button" className="button" disabled={disabled} onClick={onSend}>
          {`Send the same ${kind} again`}
        </button>
        <button type="button" className="button button-quiet" disabled={disabled} onClick={onForget}>
          {`Forget this ${kind}`}
        </button>
      </div>
    </div>
  );
}

/** A 409 that says the market is not open any more: the page reads the market again so the forms disappear. */
export function isMarketNotOpen(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "market_not_open";
}
