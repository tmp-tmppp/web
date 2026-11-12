import { useCallback } from "react";
import { useApi } from "../../api/ApiContext";
import { getWithdrawal, isFinalWithdrawal } from "../../api/payments";
import type { Withdrawal } from "../../api/payments";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { usePolling } from "../../lib/use-polling";
import { withdrawalStatusText } from "./wording";

export const WITHDRAWAL_POLL_MS = 2000;
export const WITHDRAWAL_POLL_MAX = 60;

/** Follows the status link of a withdrawal (GET /v1/withdrawals/{id}) until it is paid out, rejected or refunded. */
export function WithdrawalProgress({ initial }: { initial: Withdrawal }) {
  const api = useApi();
  const load = useCallback((signal: AbortSignal) => getWithdrawal(api, initial.id, signal), [api, initial.id]);
  const poll = usePolling({
    load,
    isDone: isFinalWithdrawal,
    intervalMs: WITHDRAWAL_POLL_MS,
    maxAttempts: WITHDRAWAL_POLL_MAX,
    enabled: !isFinalWithdrawal(initial),
  });
  const withdrawal = poll.data ?? initial;
  return (
    <div className="withdrawal-progress">
      <p role="status" data-status={withdrawal.status}>
        {withdrawalStatusText(withdrawal)}
      </p>
      {poll.error ? <ProblemDisplay error={poll.error} heading="The status could not be read" /> : null}
      {poll.timedOut ? (
        <>
          <p>This takes longer than usual. The withdrawal goes on in the background; the credits are never lost.</p>
          <button type="button" className="button button-quiet" onClick={poll.checkNow}>
            Check again
          </button>
        </>
      ) : null}
    </div>
  );
}
