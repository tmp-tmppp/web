import { useCallback } from "react";
import { useApi } from "../../api/ApiContext";
import { listMembers } from "../../api/tenants";
import { useAuth } from "../../auth/AuthContext";
import { ListFooter } from "../../components/ListFooter";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { usePagedList } from "../../lib/use-paged-list";
import { MemberRow } from "./MemberRow";

/** Tenant admin: the members of the own tenant, page by page, and a role change per member. The service lists ids only. */
export function MembersPage() {
  const api = useApi();
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? "";
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => listMembers(api, tenantId, cursor, signal), [api, tenantId]);
  const list = usePagedList(fetchPage);

  return (
    <section>
      <h1>Members</h1>
      <p>Change a member&apos;s role here. A tenant always keeps at least one tenant admin.</p>
      {list.phase === "loading" ? <StatusMessage>Loading the members...</StatusMessage> : null}
      {list.phase === "error" ? (
        <>
          <ProblemDisplay error={list.error} heading="The members could not be loaded" />
          <button type="button" className="button button-quiet" onClick={list.reload}>
            Try again
          </button>
        </>
      ) : null}
      {list.phase === "ready" && list.items.length === 0 ? <p>The tenant has no members.</p> : null}
      {list.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Members of your tenant</caption>
            <thead>
              <tr>
                <th scope="col">User id</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col">Change the role</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((member) => (
                <MemberRow
                  key={member.userId}
                  tenantId={tenantId}
                  member={member}
                  isSelf={member.userId === user?.id}
                  onChanged={(membership) => list.replaceItem((item) => item.userId === membership.userId, { ...member, userId: membership.userId, role: membership.role })}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListFooter list={list} more="more members" />
    </section>
  );
}
