import { useState } from "react";
import { useApi } from "../../api/ApiContext";
import { changeMemberRole, MEMBER_ROLES, MEMBER_ROLE_LABELS } from "../../api/tenants";
import type { Member, MemberRole, Membership } from "../../api/tenants";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";

interface MemberRowProps {
  tenantId: string;
  member: Member;
  isSelf: boolean;
  onChanged: (membership: Membership) => void;
}

/** One member of the tenant with the control that changes the role (PUT .../members/{userId}/role). */
export function MemberRow({ tenantId, member, isSelf, onChanged }: MemberRowProps) {
  const api = useApi();
  const [choice, setChoice] = useState<MemberRole>(member.role);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [done, setDone] = useState<MemberRole | null>(null);

  async function save() {
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const membership = await changeMemberRole(api, tenantId, member.userId, choice);
      setDone(membership.role);
      onChanged(membership);
    } catch (error) {
      // The row shows the service's own explanation, for example that the last tenant admin cannot be demoted.
      setFailure(error);
      setChoice(member.role);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <th scope="row">
          <code>{member.userId}</code>
          {isSelf ? <span className="badge"> (you)</span> : null}
        </th>
        <td>{MEMBER_ROLE_LABELS[member.role]}</td>
        <td>
          <Time value={member.joinedAt} />
        </td>
        <td>
          <div className="inline-form">
            <select aria-label={`New role of ${member.userId}`} value={choice} onChange={(event) => setChoice(event.target.value as MemberRole)} disabled={busy}>
              {MEMBER_ROLES.map((value) => (
                <option key={value} value={value}>
                  {MEMBER_ROLE_LABELS[value]}
                </option>
              ))}
            </select>
            <button type="button" className="button button-quiet" aria-label={`Change the role of ${member.userId}`} disabled={busy || choice === member.role} onClick={() => void save()}>
              Change role
            </button>
          </div>
        </td>
      </tr>
      {busy || failure || done ? (
        <tr>
          <td colSpan={4}>
            {busy ? <StatusMessage>Changing the role...</StatusMessage> : null}
            {done ? (
              <p className="success" role="status">
                The role is now {MEMBER_ROLE_LABELS[done]}. The identity provider follows shortly; the member&apos;s current token keeps the old role for up to 5 minutes.
              </p>
            ) : null}
            {failure ? <ProblemDisplay error={failure} heading="The role could not be changed" /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
