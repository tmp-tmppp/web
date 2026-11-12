import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api/ApiContext";
import { ApiError } from "../../api/errors";
import { closeMarket, openMarket, OUTCOMES, resolveMarket } from "../../api/markets";
import type { Market, Outcome } from "../../api/markets";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { formatAmount } from "../../lib/format";
import { useFocusOnShow } from "../../lib/use-focus-on-show";

type Action = "open" | "close" | `resolve-${Outcome}`;

const triggerId = (action: Action): string => `market-action-${action}`;

/** What may have been done to the market, for the heading of a failure whose outcome is unknown: "...whether the market was closed". */
const DONE_WORD = (action: Action): string => (action === "open" ? "opened" : action === "close" ? "closed" : "resolved");

const OUTCOME_UNKNOWN_ADVICE = "It may have been done. The page reads the market again: check its status above before you try again.";

const RESOLVE_TEXT: Record<Outcome, string> = {
  YES: "Winners are paid 1.00 credit per YES share and the rest of the funding goes back to the creator.",
  NO: "Winners are paid 1.00 credit per NO share and the rest of the funding goes back to the creator.",
  INVALID: "Every stake is refunded and the rest of the funding goes back to the creator. Use this when the question cannot be answered.",
};

/**
 * Plain words for a refusal the page knows, for the action that was refused: markets lets only the creator of a draft open
 * it, and any tenant admin of the tenant close or resolve a market (contracts/markets.openapi.yaml).
 */
function adviceFor(error: unknown, action: Action | null): { text: string; wallet?: boolean } | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 403 && action !== null && action !== "open") return { text: "Your role does not allow this. Only a tenant admin of this organization can close or resolve a market." };
  if (error.status === 409 && error.code === "insufficient_credits") return { text: "You do not have enough credits to fund this market. It is still a draft.", wallet: true };
  if (error.status === 409 && error.code === "invalid_state") return { text: "The market is not in a state that allows this: somebody (or the close time) changed it. It was read again below." };
  if (error.status === 502 && error.code === "funding_rejected") return { text: "Trading rejected the funding request. Nothing was taken and the market is still a draft." };
  if (error.status === 503 && error.code === "trading_unavailable") return { text: "Trading is not available right now. Nothing was taken and the market is still a draft; try again after the wait below." };
  if (error.status === 403) return { text: "Your role does not allow this. Only the tenant admin who created a draft can open it." };
  return null;
}

/** A confirmation under the button that asked for it: its text takes the focus when it appears, Escape cancels. */
function Confirmation({ question, detail, confirmLabel, busy, onConfirm, onCancel }: { question: string; detail: string; confirmLabel: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div
      className="confirmation notice-box"
      role="group"
      aria-labelledby="confirmation-question"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <p id="confirmation-question" tabIndex={-1} ref={heading}>
        <strong>{question}</strong>
      </p>
      <p>{detail}</p>
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="button button-quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface AdminActionsProps {
  market: Market;
  /** The subject of the signed-in admin: only the creator of a draft can open it. */
  userId: string;
  /** The market as the service answered an action, or read again after a failed one. */
  onChanged: (market: Market) => void;
  /** Reads the market again (after an answer that says its state is not what the page thought). */
  onReload: () => void;
}

/**
 * The tenant admin's lifecycle actions (UC-10 to UC-12, UC-16): open a draft (its creator's credits fund it; the answer
 * can be 202, "opening", which the page then follows), close an open market, resolve a closed one as YES, NO or INVALID.
 * Each action asks for a confirmation first, because none of them can be taken back.
 */
export function AdminActions({ market, userId, onChanged, onReload }: AdminActionsProps) {
  const api = useApi();
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  // The action the failure belongs to, so its advice names the rule of that action.
  const [failedAction, setFailedAction] = useState<Action | null>(null);
  // The action whose answer was lost or was a server failure that names no refusal of the service: it may have been done (ApiError.outcomeUnknown).
  const [unknownOutcomeOf, setUnknownOutcomeOf] = useState<Action | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const doneRef = useFocusOnShow<HTMLParagraphElement>(done !== null);

  async function run(action: Action) {
    setBusy(true);
    setFailure(null);
    setUnknownOutcomeOf(null);
    setDone(null);
    try {
      if (action === "open") {
        const response = await openMarket(api, market.id);
        onChanged(response.data);
        setDone(response.status === 202 ? "The funding is being confirmed. The market opens as soon as it is." : "The market is open: traders can trade now.");
      } else if (action === "close") {
        onChanged(await closeMarket(api, market.id));
        setDone("The market is closed. Resolve it when the answer is known.");
      } else {
        const outcome = action.slice("resolve-".length) as Outcome;
        onChanged(await resolveMarket(api, market.id, outcome));
        setDone(`The market is resolved as ${outcome}. The payouts are being made.`);
      }
    } catch (error) {
      setFailure(error);
      setFailedAction(action);
      // 502 funding_rejected ("nothing was taken") is the service's own refusal: outcomeUnknown is false for it.
      const unknown = error instanceof ApiError && error.outcomeUnknown;
      if (unknown) setUnknownOutcomeOf(action);
      // A refusal for the state, a funding that fell back to draft, or an answer that never came (the action may have been
      // done): what the page shows must be what the service has.
      if (unknown || (error instanceof ApiError && error.status >= 400 && error.status !== 403)) onReload();
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  const advice = adviceFor(failure, failedAction);
  const isCreator = market.createdBy === userId;
  const choose = (action: Action) => setPending((current) => (current === action ? null : action));
  // Cancelling gives the focus back to the button that asked, so a keyboard user does not start over at the top of the page.
  const cancel = (action: Action) => {
    setPending(null);
    document.getElementById(triggerId(action))?.focus();
  };

  return (
    <section aria-labelledby="admin-heading">
      <h2 id="admin-heading">Manage this market</h2>
      {market.status === "draft" ? (
        <>
          {isCreator ? (
            <button type="button" className="button" id={triggerId("open")} disabled={busy} aria-expanded={pending === "open"} onClick={() => choose("open")}>
              Open the market
            </button>
          ) : (
            <p>Only the tenant admin who created this market can open it, because their credits fund it.</p>
          )}
          {pending === "open" ? (
            <Confirmation
              question="Open this market?"
              detail={`${formatAmount(market.fundingAmount)} are taken from your balance to fund it. You get back what the market-maker bot still holds when the market is resolved.`}
              confirmLabel="Yes, open the market"
              busy={busy}
              onConfirm={() => void run("open")}
              onCancel={() => cancel("open")}
            />
          ) : null}
        </>
      ) : null}
      {market.status === "opening" ? <StatusMessage>The funding is being confirmed. Nothing to do until the market opens or falls back to a draft.</StatusMessage> : null}
      {market.status === "open" ? (
        <>
          <button type="button" className="button" id={triggerId("close")} disabled={busy} aria-expanded={pending === "close"} onClick={() => choose("close")}>
            Close the market
          </button>
          {pending === "close" ? (
            <Confirmation
              question="Close this market?"
              detail="Nobody can buy or sell after that. The market stays closed until you resolve it."
              confirmLabel="Yes, close the market"
              busy={busy}
              onConfirm={() => void run("close")}
              onCancel={() => cancel("close")}
            />
          ) : null}
        </>
      ) : null}
      {market.status === "closed" ? (
        <>
          <p>Trading has stopped. Choose the answer:</p>
          <div className="actions">
            {OUTCOMES.map((outcome) => (
              <button key={outcome} type="button" className="button" id={triggerId(`resolve-${outcome}`)} disabled={busy} aria-expanded={pending === `resolve-${outcome}`} onClick={() => choose(`resolve-${outcome}`)}>
                {`Resolve as ${outcome}`}
              </button>
            ))}
          </div>
          {OUTCOMES.map((outcome) =>
            pending === `resolve-${outcome}` ? (
              <Confirmation
                key={outcome}
                question={`Resolve this market as ${outcome}?`}
                detail={`${RESOLVE_TEXT[outcome]} This cannot be undone.`}
                confirmLabel={`Yes, resolve as ${outcome}`}
                busy={busy}
                onConfirm={() => void run(`resolve-${outcome}`)}
                onCancel={() => cancel(`resolve-${outcome}`)}
              />
            ) : null,
          )}
        </>
      ) : null}
      {market.status === "resolved" ? <p>This market is resolved: there is nothing left to do.</p> : null}
      {busy ? <StatusMessage>Working on it...</StatusMessage> : null}
      {done ? (
        <p className="success" role="status" tabIndex={-1} ref={doneRef}>
          {done}
        </p>
      ) : null}
      {failure ? (
        <>
          <ProblemDisplay error={failure} heading={unknownOutcomeOf ? `We do not know yet whether the market was ${DONE_WORD(unknownOutcomeOf)}` : "The action was not done"} />
          {unknownOutcomeOf ? <p>{OUTCOME_UNKNOWN_ADVICE}</p> : advice ? (
            <p>
              {advice.text}
              {advice.wallet ? (
                <>
                  {" "}
                  <Link to="/wallet">Go to the wallet</Link>
                </>
              ) : null}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
