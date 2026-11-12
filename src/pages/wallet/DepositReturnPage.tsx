import { useCallback, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api/ApiContext";
import { getDeposit, isFinalDeposit, recallDeposit } from "../../api/payments";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { formatAmount } from "../../lib/format";
import { usePolling } from "../../lib/use-polling";
import { depositFailureText } from "./wording";

export const DEPOSIT_POLL_MS = 2000;
export const DEPOSIT_POLL_MAX = 60;

/**
 * Where the payment provider sends the buyer back (the fixed success and cancel paths). The webhook completes the
 * deposit a moment after the payment (DM-13), so the page shows "processing" and polls GET /v1/deposits/{id} until the
 * deposit succeeded or failed. The id was kept in sessionStorage before the redirect.
 */
export function DepositReturnPage({ variant }: { variant: "success" | "cancelled" }) {
  const api = useApi();
  const [depositId] = useState(recallDeposit);
  const load = useCallback((signal: AbortSignal) => getDeposit(api, depositId ?? "", signal), [api, depositId]);
  const poll = usePolling({ load, isDone: isFinalDeposit, intervalMs: DEPOSIT_POLL_MS, maxAttempts: DEPOSIT_POLL_MAX, enabled: depositId !== null });
  const deposit = poll.data;
  const heading = variant === "success" ? "Deposit" : "Deposit cancelled";
  // Still waiting only while polling goes on with nothing to show but "processing" (not after an error or a give-up).
  const waiting = !poll.done && !poll.timedOut && !poll.error;

  if (depositId === null) {
    return (
      <section>
        <h1>{heading}</h1>
        <p role="status">This page cannot tell which deposit you came from, for example because it was opened in another browser tab or window.</p>
        <p>
          <Link to="/wallet">Go to your wallet</Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-busy={waiting}>
      <h1>{heading}</h1>
      {deposit?.status === "succeeded" ? (
        <p className="success" role="status">
          Your deposit of {formatAmount(deposit.amount)} is complete. The credits are in your balance.
        </p>
      ) : null}
      {deposit?.status === "failed" ? (
        <div role="status">
          <p className="problem-title">The deposit did not go through.</p>
          <p>{depositFailureText(deposit.failureReason)}</p>
        </div>
      ) : null}
      {waiting ? (
        <StatusMessage>
          {variant === "success"
            ? "Your payment is being processed. This usually takes a few seconds; you do not need to do anything."
            : "You left the payment page. We are checking whether a payment went through."}
        </StatusMessage>
      ) : null}
      {poll.error ? <ProblemDisplay error={poll.error} heading="The deposit status could not be read" /> : null}
      {poll.timedOut ? (
        <>
          <p role="status">The provider has not confirmed the payment yet. If you paid, the credits arrive as soon as it does.</p>
          <button type="button" className="button button-quiet" onClick={poll.checkNow}>
            Check again
          </button>
        </>
      ) : null}
      <p>
        <Link to="/wallet">Back to your wallet</Link>
      </p>
    </section>
  );
}
