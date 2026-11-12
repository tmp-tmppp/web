import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../api/ApiContext";
import { ApiError } from "../api/errors";
import { acceptInvite, INVITE_CODE_MAX, INVITE_CODE_MIN } from "../api/tenants";
import { Field } from "../components/Field";
import { useOrganizations } from "../organizations/OrganizationsContext";
import { ProblemDisplay } from "../components/ProblemDisplay";
import { StatusMessage } from "../components/StatusMessage";

/** What to do next, by the answer: the service's title and detail say what happened, this says what the user can do about it. */
function adviceFor(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.status) {
    case 404:
      return "Check the code for typing mistakes, or ask the admin of the organization to send it again.";
    case 410:
      return "Ask the admin of the organization for a new invite code.";
    default:
      return null;
  }
}

/**
 * A user joins an organization with the invite code its tenant admin handed over (POST /v1/invites/{code}/accept). Also a
 * user who already belongs to one: the membership is added, and the switcher in the header changes between them.
 */
export function JoinPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { reload } = useOrganizations();
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    setFailure(null);
    if (trimmed.length < INVITE_CODE_MIN || trimmed.length > INVITE_CODE_MAX) {
      setFieldError(`An invite code has ${INVITE_CODE_MIN} to ${INVITE_CODE_MAX} characters. Paste it exactly as you received it.`);
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      const joined = await acceptInvite(api, trimmed);
      // The list of organizations in the header learns the new one; the token carries it only after the user signs in to it
      // (the switcher), and the profile page waits for the identity provider to catch up.
      reload();
      void navigate("/profile", { state: { joined: { role: joined.role, tenantId: joined.tenantId } } });
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return (
    <section className="content-narrow">
      <h1>Join an organization</h1>
      <p>Enter the invite code a tenant admin gave you. You can belong to several organizations and switch between them in the header.</p>
      <form onSubmit={(event) => void submit(event)} noValidate aria-busy={busy}>
        <Field id="invite-code" label="Invite code" error={fieldError}>
          {(control) => (
            <input
              {...control}
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <button type="submit" className="button" disabled={busy}>
          Join
        </button>
      </form>
      {busy ? <StatusMessage>Joining...</StatusMessage> : null}
      {failure ? <ProblemDisplay error={failure} heading="You could not join" /> : null}
      {failure && adviceFor(failure) ? <p>{adviceFor(failure)}</p> : null}
    </section>
  );
}
