import { Link, useSearchParams } from "react-router";
import { useAuth } from "../../auth/AuthContext";
import { useOrganizations } from "../../organizations/OrganizationsContext";
import { CreditsHint } from "./parts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a user lands after joining the organization of a shared market and signing in for it: the token now carries
 * that organization, so the market and the wallet of that organization are open. The market id is in the query (it is
 * no secret; the share token never leaves the share page).
 */
export function ShareReadyPage() {
  const { user } = useAuth();
  const { organizations } = useOrganizations();
  const [params] = useSearchParams();
  const marketId = params.get("market") ?? "";
  const name = organizations.find((organization) => organization.alias === user?.tenantId)?.name ?? "your organization";
  return (
    <section>
      <h1>You are in {name}</h1>
      <p className="success" role="status">
        You belong to {name} and your session is for it. The shared market is open to you.
      </p>
      <div className="actions">
        {UUID.test(marketId) ? (
          <Link className="button" to={`/markets/${marketId}`}>
            Open the market
          </Link>
        ) : (
          <Link className="button" to="/markets">
            Go to the markets
          </Link>
        )}
      </div>
      <CreditsHint organization={name} />
    </section>
  );
}
