import { useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { createWithdrawal } from "../../api/payments";
import type { Withdrawal } from "../../api/payments";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { useIdempotencyKey } from "../../lib/use-idempotency-key";
import { AMOUNT_RULE, AmountField, parseAmount } from "./AmountField";
import { WithdrawalProgress } from "./WithdrawalProgress";

function adviceFor(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409 && error.code === "insufficient_credits") return "You do not have enough credits for this withdrawal. Nothing was taken from your balance.";
  if (error.status === 503 && error.code === "trading_unavailable") return "Trading is not available right now. Nothing was taken from your balance; try again after the wait below.";
  return null;
}

/**
 * An answer that names a withdrawal the service stored as rejected. The service answers every repeat of the same
 * Idempotency-Key and body with that same rejection, so the next try needs a new key; a 503 that stores nothing
 * (tenant_not_ready, withdrawal_busy) or a lost answer keeps the key, so the same attempt is finished.
 */
function isStoredRejection(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "trading_unavailable" || error.code === "insufficient_credits");
}

/**
 * Pay credits out. POST /v1/withdrawals with an Idempotency-Key made once per attempt (kept in sessionStorage while it has
 * no settling answer, so a reload after a lost answer repeats the same request) answers 202 (under way: the page follows
 * the status), 200 (the same attempt already ended), 409 (too few credits) or 503 (trading is not available).
 */
export function WithdrawForm() {
  const api = useApi();
  const keys = useIdempotencyKey("withdraw");
  const [amountText, setAmountText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawal, setWithdrawal] = useState<Withdrawal | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const amount = parseAmount(amountText);
    if (amount === null) {
      setFieldError(AMOUNT_RULE);
      return;
    }
    setFieldError(null);
    setWithdrawal(null);
    setBusy(true);
    try {
      const response = await createWithdrawal(api, amount, keys.keyFor(`withdrawal:${amount}`));
      keys.done();
      setWithdrawal(response.data);
    } catch (error) {
      keys.done(isStoredRejection(error) ? undefined : error);
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="withdraw-title" aria-busy={busy}>
      <h2 id="withdraw-title">Withdraw</h2>
      <p>Credits are taken from your balance first, then paid out. If the payout fails, they are returned.</p>
      <AmountField id="withdraw-amount" label="Amount to withdraw, in credits" value={amountText} error={fieldError} disabled={busy} onChange={setAmountText} />
      <button type="submit" className="button" disabled={busy}>
        Withdraw
      </button>
      {busy ? <StatusMessage>Sending your request...</StatusMessage> : null}
      {failure ? (
        <>
          {/* No answer, or a 5xx other than 503 that names no refusal of payments (a 500, the gateway's 502 or 504): payments may have taken the withdrawal on, so the page must not say it was not made. */}
          <ProblemDisplay error={failure} heading={failure instanceof ApiError && failure.outcomeUnknown ? "We do not know yet whether the withdrawal was made" : "The withdrawal was not made"} />
          {failure instanceof ApiError && failure.outcomeUnknown ? (
            <p>Press Withdraw again without changing the amount: the same request is sent again and cannot withdraw twice. If you left this page, look at your withdrawals first.</p>
          ) : adviceFor(failure) ? (
            <p>{adviceFor(failure)}</p>
          ) : null}
        </>
      ) : null}
      {withdrawal ? <WithdrawalProgress key={withdrawal.id} initial={withdrawal} /> : null}
    </form>
  );
}
