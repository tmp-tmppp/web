import { useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../../api/ApiContext";
import { createInvite, INVITE_EXPIRY_HOURS, INVITE_MAX_USES, MEMBER_ROLES, MEMBER_ROLE_LABELS } from "../../api/tenants";
import type { Invite, MemberRole } from "../../api/tenants";
import { useAuth } from "../../auth/AuthContext";
import { Field } from "../../components/Field";
import { OneTimeCode } from "../../components/OneTimeCode";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { wholeNumberInRange } from "../../lib/numbers";
import { InviteDetails } from "../InviteDetails";

interface Errors {
  maxUses?: string;
  expiresInHours?: string;
}

/** Tenant admin: makes an invite code for the own tenant (POST /v1/tenants/{id}/invites). The code is shown once. */
export function InvitesPage() {
  const api = useApi();
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? null;
  const [role, setRole] = useState<MemberRole>("trader");
  const [maxUses, setMaxUses] = useState(String(INVITE_MAX_USES.default));
  const [hours, setHours] = useState(String(INVITE_EXPIRY_HOURS.default));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Invite | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const uses = wholeNumberInRange(maxUses, INVITE_MAX_USES.min, INVITE_MAX_USES.max);
    const expiry = wholeNumberInRange(hours, INVITE_EXPIRY_HOURS.min, INVITE_EXPIRY_HOURS.max);
    const found: Errors = {};
    if (uses === null) found.maxUses = `Enter a whole number from ${INVITE_MAX_USES.min} to ${INVITE_MAX_USES.max}.`;
    if (expiry === null) found.expiresInHours = `Enter a whole number of hours from ${INVITE_EXPIRY_HOURS.min} to ${INVITE_EXPIRY_HOURS.max}.`;
    setErrors(found);
    if (uses === null || expiry === null || tenantId === null) return;
    setBusy(true);
    try {
      setCreated(await createInvite(api, tenantId, { role, maxUses: uses, expiresInHours: expiry }));
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Invites</h1>
      <p>An invite code lets one or more people join your tenant with the role you choose. The service keeps only a hash of the code, so it cannot show a code again.</p>
      <form className="card" onSubmit={(event) => void submit(event)} noValidate aria-busy={busy}>
        <Field id="invite-role" label="Role it gives">
          {(control) => (
            <select {...control} value={role} onChange={(event) => setRole(event.target.value as MemberRole)}>
              {MEMBER_ROLES.map((value) => (
                <option key={value} value={value}>
                  {MEMBER_ROLE_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="invite-uses" label="How many people may use it" error={errors.maxUses ?? null}>
          {(control) => (
            <input {...control} type="number" inputMode="numeric" min={INVITE_MAX_USES.min} max={INVITE_MAX_USES.max} value={maxUses} onChange={(event) => setMaxUses(event.target.value)} />
          )}
        </Field>
        <Field id="invite-hours" label="Valid for (hours)" hint="Up to 720 hours (30 days)." error={errors.expiresInHours ?? null}>
          {(control) => (
            <input
              {...control}
              type="number"
              inputMode="numeric"
              min={INVITE_EXPIRY_HOURS.min}
              max={INVITE_EXPIRY_HOURS.max}
              value={hours}
              onChange={(event) => setHours(event.target.value)}
            />
          )}
        </Field>
        <button type="submit" className="button" disabled={busy}>
          Create the invite
        </button>
        {busy ? <StatusMessage>Creating the invite...</StatusMessage> : null}
      </form>
      {failure ? (
        <>
          <ProblemDisplay error={failure} heading="The invite could not be created" />
          <p>If the message says the tenant was not found, open your profile and refresh your session, then try again.</p>
        </>
      ) : null}
      {created ? (
        <OneTimeCode title="Invite code" code={created.code} onDismiss={() => setCreated(null)}>
          <InviteDetails invite={created} />
        </OneTimeCode>
      ) : null}
    </section>
  );
}
