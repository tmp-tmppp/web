import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../api/ApiContext";
import { canShareStatus, createShareLink, LINK_TYPE_LABELS, linkTypesFor, listShareLinks, revokeShareLink, shareUrl } from "../api/markets";
import type { CreatedShareLink, LinkType, MarketStatus, SharingPolicy } from "../api/markets";
import { canShare, copyText, shareLink } from "../lib/clipboard";
import { emailProblem, parseEmails } from "../lib/emails";
import { usePagedList } from "../lib/use-paged-list";
import { Field } from "./Field";
import { ListFooter } from "./ListFooter";
import { ProblemDisplay } from "./ProblemDisplay";
import { StatusMessage } from "./StatusMessage";
import { Time } from "./Time";

/**
 * Props of the share dialog. The market page mounts it with one line and the values it already has:
 *
 *   <ShareDialog marketId={market.id} sharing={market.sharing} role={role} marketStatus={market.status} />
 *
 * - marketId: the market (uuid) the links lead to.
 * - sharing: the sharing policy of the market (`Market.sharing`, fixed when the market was created).
 * - role: the caller's role in the market's organization, from the token ("trader" or "tenant-admin").
 * - marketStatus: `Market.status`; only an open, closed or resolved market can be shared.
 */
export interface ShareDialogProps {
  marketId: string;
  sharing: SharingPolicy;
  role: "trader" | "tenant-admin";
  marketStatus: MarketStatus;
}

const TYPE_HINTS: Record<LinkType, string> = {
  members: "Only people who belong to this organization can open it.",
  profiles: "Only the people you list, signed in with that e-mail address. A person counts once they have confirmed their address from the verification mail Chance sends them.",
  everyone: "Anyone who has the link can look at the market. To trade they sign in and join the organization.",
};

const EXPIRY_CHOICES = [
  { value: "never", label: "Does not expire", days: null },
  { value: "1", label: "1 day", days: 1 },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
] as const;

const STATUS_LABELS = { active: "Active", revoked: "Revoked", expired: "Expired" } as const;

/** Why nobody can make a link here, in words. */
function refusalFor(sharing: SharingPolicy, role: ShareDialogProps["role"], status: MarketStatus): string {
  if (!canShareStatus(status)) return "A market can be shared once it is open.";
  if (sharing.whoMayShare === "none") return "The admin who created this market turned sharing off.";
  if (sharing.whoMayShare === "admins" && role !== "tenant-admin") return "Only tenant admins may share this market.";
  return "This market allows no link type.";
}

/** The address of a link that was just made, shown once with the ways to hand it on. */
function NewLink({ link, origin, onDismiss }: { link: CreatedShareLink; origin: string; onDismiss: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const url = shareUrl(origin, link.urlPath);

  async function copy() {
    const result = await copyText(url, input.current);
    setMessage(result === "copied" ? "Copied to the clipboard." : "The browser did not allow copying. The link is selected: copy it by hand.");
  }

  async function share() {
    const result = await shareLink({ title: "A market on Chance", url });
    if (result === "failed") setMessage("The share sheet could not be opened. Copy the link instead.");
  }

  return (
    <section className="card one-time" aria-labelledby="share-new-title">
      <h3 id="share-new-title">Your link</h3>
      <p>
        <strong>It is shown only once.</strong> Copy it now; the service keeps only a hash of it and cannot show it again. Whoever has the link and
        meets the rule below can open it.
      </p>
      <p>
        <label htmlFor="share-url" className="sr-only">
          Share link
        </label>
        <input id="share-url" ref={input} className="code-value share-url" type="text" readOnly value={url} data-testid="share-url" onFocus={(event) => event.currentTarget.select()} />
      </p>
      <div className="actions">
        <button type="button" className="button" onClick={() => void copy()}>
          Copy the link
        </button>
        {canShare() ? (
          <button type="button" className="button button-quiet" onClick={() => void share()}>
            Share...
          </button>
        ) : null}
        <button type="button" className="button button-quiet" onClick={onDismiss}>
          I have saved it
        </button>
      </div>
      <p role="status" className="status">
        {message}
      </p>
    </section>
  );
}

/**
 * The links of the market with their state and a revoke button. The list never holds a token: the service does not
 * return it again. The parent gives it a new key after a link was made, so the list starts again.
 */
function LinkList({ marketId }: { marketId: string }) {
  const api = useApi();
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => listShareLinks(api, marketId, cursor, signal), [api, marketId]);
  const list = usePagedList(fetchPage);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  async function revoke(linkId: string) {
    setBusyId(linkId);
    setFailure(null);
    try {
      await revokeShareLink(api, marketId, linkId);
      list.reload();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h3>Links of this market</h3>
      {list.phase === "loading" ? <StatusMessage>Loading the links...</StatusMessage> : null}
      {list.phase === "error" ? (
        <>
          <ProblemDisplay error={list.error} heading="The links could not be loaded" />
          <button type="button" className="button button-quiet" onClick={list.reload}>
            Try again
          </button>
        </>
      ) : null}
      {list.phase === "ready" && list.items.length === 0 ? <p>No link has been made for this market yet.</p> : null}
      {failure ? <ProblemDisplay error={failure} heading="The link could not be revoked" /> : null}
      {list.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Share links of this market</caption>
            <thead>
              <tr>
                <th scope="col">Who may open it</th>
                <th scope="col">Made</th>
                <th scope="col">Expires</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="sr-only">Revoke</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((link) => (
                <tr key={link.id}>
                  <td>
                    {LINK_TYPE_LABELS[link.type]}
                    {link.type === "profiles" && link.emails.length > 0 ? <div className="hint">{link.emails.join(", ")}</div> : null}
                  </td>
                  <td>
                    <Time value={link.createdAt} />
                  </td>
                  <td>{link.expiresAt ? <Time value={link.expiresAt} /> : "Never"}</td>
                  <td>{STATUS_LABELS[link.status]}</td>
                  <td>
                    {link.status === "active" ? (
                      <button type="button" className="button button-quiet" disabled={busyId === link.id} onClick={() => void revoke(link.id)}>
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListFooter list={list} more="more links" />
    </div>
  );
}

/**
 * Share a market by link: the sharer picks who may open it (only the types the market's sharing policy allows for the
 * caller), the e-mail addresses of a "chosen profiles" link and an expiry, gets the address once (copy, or the share
 * sheet of the device) and can revoke any link later. The address is `<origin>/share#<token>`: the token sits after
 * "#", so no server ever sees it. It lives in this component's state only: never in a log, a storage or the list.
 */
export function ShareDialog({ marketId, sharing, role, marketStatus }: ShareDialogProps) {
  const api = useApi();
  const types = canShareStatus(marketStatus) ? linkTypesFor(sharing, role) : [];
  const [type, setType] = useState<LinkType | null>(null);
  const [emailText, setEmailText] = useState("");
  const [expiry, setExpiry] = useState<string>("never");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const [round, setRound] = useState(0);

  const chosen: LinkType | null = type && types.includes(type) ? type : (types[0] ?? null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    setFailure(null);
    let emails: string[] | undefined;
    if (chosen === "profiles") {
      const parsed = parseEmails(emailText);
      const problem = emailProblem(parsed);
      if (problem) {
        setFieldError(problem);
        return;
      }
      emails = parsed.emails;
    }
    setFieldError(null);
    const days = EXPIRY_CHOICES.find((choice) => choice.value === expiry)?.days ?? null;
    setBusy(true);
    try {
      const link = await createShareLink(api, marketId, {
        type: chosen,
        ...(emails ? { emails } : {}),
        ...(days !== null ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
      });
      setCreated(link);
      setEmailText("");
      setRound((value) => value + 1);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  if (types.length === 0) {
    return (
      <section className="card" aria-labelledby="share-title" data-testid="share-dialog">
        <h2 id="share-title">Share this market</h2>
        <p>{refusalFor(sharing, role, marketStatus)}</p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="share-title" data-testid="share-dialog">
      <h2 id="share-title">Share this market</h2>
      <p>Make a link and hand it to the people you want to trade with. You choose who may open it.</p>
      <form onSubmit={(event) => void submit(event)} noValidate aria-busy={busy}>
        <fieldset>
          <legend>Who may open the link</legend>
          {types.map((value) => (
            <p key={value} className="choice">
              <label>
                <input type="radio" name="share-type" value={value} checked={chosen === value} onChange={() => setType(value)} /> {LINK_TYPE_LABELS[value]}
              </label>
              <span className="hint"> {TYPE_HINTS[value]}</span>
            </p>
          ))}
        </fieldset>
        {chosen === "profiles" ? (
          <Field id="share-emails" label="E-mail addresses" hint={`Separate them with commas, spaces or new lines. Up to 50.`} error={fieldError}>
            {(control) => <textarea {...control} rows={3} value={emailText} onChange={(event) => setEmailText(event.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
        ) : null}
        <Field id="share-expiry" label="The link ends">
          {(control) => (
            <select {...control} value={expiry} onChange={(event) => setExpiry(event.target.value)}>
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className="button" disabled={busy}>
          Make the link
        </button>
        {busy ? <StatusMessage>Making the link...</StatusMessage> : null}
      </form>
      {failure ? <ProblemDisplay error={failure} heading="The link could not be made" /> : null}
      {created ? <NewLink link={created} origin={window.location.origin} onDismiss={() => setCreated(null)} /> : null}
      <LinkList key={round} marketId={marketId} />
    </section>
  );
}
