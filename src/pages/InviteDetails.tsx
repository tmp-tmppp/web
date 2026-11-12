import { MEMBER_ROLE_LABELS } from "../api/tenants";
import type { Invite } from "../api/tenants";
import { Time } from "../components/Time";

/** What an invite code gives and until when: the role, how many people may use it and its end. Never the code itself. */
export function InviteDetails({ invite }: { invite: Pick<Invite, "role" | "maxUses" | "expiresAt"> }) {
  return (
    <dl className="details">
      <dt>Role it gives</dt>
      <dd>{MEMBER_ROLE_LABELS[invite.role]}</dd>
      <dt>Uses</dt>
      <dd>{invite.maxUses === 1 ? "One person" : `Up to ${invite.maxUses} people`}</dd>
      <dt>Valid until</dt>
      <dd>
        <Time value={invite.expiresAt} />
      </dd>
    </dl>
  );
}
