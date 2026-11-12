import { useCallback, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { listTenants } from "../../api/tenants";
import type { CreateTenantResponse } from "../../api/tenants";
import { ListFooter } from "../../components/ListFooter";
import { OneTimeCode } from "../../components/OneTimeCode";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";
import { usePagedList } from "../../lib/use-paged-list";
import { InviteDetails } from "../InviteDetails";
import { CreateTenantForm } from "./CreateTenantForm";

/** Platform admin: all tenants, oldest first, and a form to create one; the first admin's invite code is shown once. */
export function PlatformTenantsPage() {
  const api = useApi();
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => listTenants(api, cursor, signal), [api]);
  const list = usePagedList(fetchPage);
  const [created, setCreated] = useState<CreateTenantResponse | null>(null);

  return (
    <section>
      <h1>Tenants</h1>
      <CreateTenantForm
        onCreated={(response) => {
          setCreated(response);
          list.reload();
        }}
      />
      {created ? (
        <OneTimeCode title={`First admin invite for ${created.tenant.name}`} code={created.adminInvite.code} onDismiss={() => setCreated(null)}>
          <p>
            Tenant <strong>{created.tenant.name}</strong> (<code>{created.tenant.slug}</code>) was created.
          </p>
          <InviteDetails invite={created.adminInvite} />
        </OneTimeCode>
      ) : null}

      <h2>All tenants</h2>
      {list.phase === "loading" ? <StatusMessage>Loading the tenants...</StatusMessage> : null}
      {list.phase === "error" ? (
        <>
          <ProblemDisplay error={list.error} heading="The tenants could not be loaded" />
          <button type="button" className="button button-quiet" onClick={list.reload}>
            Try again
          </button>
        </>
      ) : null}
      {list.phase === "ready" && list.items.length === 0 ? <p>There are no tenants yet.</p> : null}
      {list.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Tenants, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Id</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((tenant) => (
                <tr key={tenant.id}>
                  <th scope="row">{tenant.name}</th>
                  <td>
                    <code>{tenant.slug}</code>
                  </td>
                  <td>{tenant.status === "active" ? "Active" : "Suspended"}</td>
                  <td>
                    <Time value={tenant.createdAt} />
                  </td>
                  <td>
                    <code>{tenant.id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListFooter list={list} more="more tenants" />
    </section>
  );
}
