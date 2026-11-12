import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { createDeposit, rememberDeposit } from "../../api/payments";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { useConfig } from "../../config/ConfigContext";
import { useIdempotencyKey } from "../../lib/use-idempotency-key";
import { goToExternal, isSafeCheckoutUrl } from "../../lib/navigation";
import { AMOUNT_RULE, AmountField, parseAmount } from "./AmountField";

/**
 * Buy credits. The page asks the payments service for a checkout session (POST /v1/deposits with an Idempotency-Key it
 * makes once per attempt and keeps in sessionStorage until the attempt has a settling answer, so a reload after a lost
 * answer repeats the same request), keeps the deposit id in sessionStorage and sends the browser to the provider's payment page.
 * The provider sends the buyer back to the fixed return paths, where the page polls the deposit.
 */
export function DepositForm() {
  const api = useApi();
  const config = useConfig();
  const navigate = useNavigate();
  const keys = useIdempotencyKey("deposit");
  const [amountText, setAmountText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "busy" | "leaving">("idle");

  // Back from the provider's page can restore this page from the browser's back-forward cache, still "leaving":
  // the form is usable again then.
  useEffect(() => {
    function restored(event: PageTransitionEvent) {
      if (event.persisted) setPhase("idle");
    }
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setNotice(null);
    const amount = parseAmount(amountText);
    if (amount === null) {
      setFieldError(AMOUNT_RULE);
      return;
    }
    setFieldError(null);
    setPhase("busy");
    try {
      const { data: deposit } = await createDeposit(api, amount, keys.keyFor(`deposit:${amount}`));
      rememberDeposit(deposit.id);
      const url = deposit.checkoutUrl;
      if (deposit.status !== "pending") {
        // The same attempt was finished earlier: the return page shows how it ended.
        keys.done();
        void navigate(config.depositSuccessPath);
        return;
      }
      if (url === null) {
        // The provider has not answered yet: the same key finishes this deposit on the next press, so nothing is charged twice.
        setNotice("The payment page is not ready yet. Press the button again in a moment; nothing is charged twice.");
        setPhase("idle");
        return;
      }
      keys.done();
      if (!isSafeCheckoutUrl(url)) {
        setNotice("The payment page address is not valid, so the page did not open it. Try again later.");
        setPhase("idle");
        return;
      }
      setPhase("leaving");
      goToExternal(url);
    } catch (error) {
      keys.done(error);
      setFailure(error);
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";
  return (
    <form className="card" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="deposit-title" aria-busy={busy}>
      <h2 id="deposit-title">Deposit</h2>
      <p>You pay on the payment provider&apos;s page and come back here.</p>
      <AmountField id="deposit-amount" label="Amount to deposit, in credits" value={amountText} error={fieldError} disabled={busy} onChange={setAmountText} />
      <button type="submit" className="button" disabled={busy}>
        Continue to the payment page
      </button>
      {phase === "busy" ? <StatusMessage>Preparing your payment...</StatusMessage> : null}
      {phase === "leaving" ? <StatusMessage>Taking you to the payment page...</StatusMessage> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {/* No answer, or a 5xx other than 503 that names no refusal of payments (a 500, the gateway's 502 or 504): payments may have started the deposit, so the page must not say it was not. */}
      {failure ? (
        <ProblemDisplay error={failure} heading={failure instanceof ApiError && failure.outcomeUnknown ? "We do not know yet whether the deposit was started" : "The deposit could not be started"} />
      ) : null}
      {failure instanceof ApiError && failure.outcomeUnknown ? (
        <p>Press the button again without changing the amount: the same request is sent again and cannot start a second deposit. If you left this page, look at your deposits first.</p>
      ) : null}
    </form>
  );
}
