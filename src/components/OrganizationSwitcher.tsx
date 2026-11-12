import { useLocation } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { useOrganizations } from "../organizations/OrganizationsContext";

/**
 * The organization the token is for, and the way to another one. The token carries exactly one organization (token
 * contract v2), so a change is a new sign-in with the scope of the chosen alias; the single sign-on session of the
 * identity provider usually answers at once, without a form, and the browser comes back to the same page.
 * Nothing is shown to a user without an organization (a platform admin, or someone who has not joined one yet).
 */
export function OrganizationSwitcher() {
  const { user, login } = useAuth();
  const { organizations } = useOrganizations();
  const location = useLocation();
  const current = user?.tenantId ?? null;
  const active = organizations.find((organization) => organization.alias === current);

  if (organizations.length === 0) return null;
  if (organizations.length === 1 && active) {
    return (
      <span className="organization-name" data-testid="organization-name">
        {active.name}
      </span>
    );
  }
  return (
    <div className="organization-switcher">
      <label htmlFor="organization-switcher">Organization</label>
      <select
        id="organization-switcher"
        value={active ? active.alias : ""}
        onChange={(event) => {
          const alias = event.target.value;
          if (alias !== "" && alias !== current) void login(`${location.pathname}${location.search}`, { organization: alias });
        }}
      >
        {active ? null : (
          <option value="" disabled>
            Choose an organization
          </option>
        )}
        {organizations.map((organization) => (
          <option key={organization.alias} value={organization.alias}>
            {organization.name}
          </option>
        ))}
      </select>
    </div>
  );
}
