import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { evaluateAccess } from "../auth/access";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABELS } from "../auth/roles";
import type { AuthUser } from "../auth/types";
import { OrganizationsProvider } from "../organizations/OrganizationsContext";
import type { AppRoute } from "../routes/route-table";
import { OrganizationSwitcher } from "./OrganizationSwitcher";

/** The navigation entries a user may see: the routes with a nav label whose access rule the user meets. */
export function navigationFor(user: AuthUser, routes: readonly AppRoute[]): { path: string; label: string }[] {
  return routes
    .filter((route) => route.nav && evaluateAccess(user, route.access).allowed)
    .sort((a, b) => (a.nav?.order ?? 0) - (b.nav?.order ?? 0))
    .map((route) => ({ path: route.path, label: route.nav?.label ?? route.title }));
}

function roleSummary(user: AuthUser): string {
  if (user.roles.length > 0) return user.roles.map((role) => ROLE_LABELS[role]).join(", ");
  return user.tenantId ? "Member" : "No tenant yet";
}

/** The frame of the signed-in app: skip link, header with the role-filtered navigation and the user, then the page. */
export function Layout({ user, routes }: { user: AuthUser; routes: readonly AppRoute[] }) {
  const { logout } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const items = navigationFor(user, routes);

  // After a navigation the focus moves to the page, so keyboard and screen reader users start at its top.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus();
  }, [location.pathname]);

  return (
    <OrganizationsProvider>
      <a className="skip-link" href="#main">
        Skip to the page
      </a>
      <header className="topbar">
        <Link className="brand" to="/">
          Chance
        </Link>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          Menu
        </button>
        <nav id="main-nav" className={menuOpen ? "nav nav-open" : "nav"} aria-label="Main">
          <ul>
            {items.map((item) => (
              <li key={item.path}>
                <NavLink to={item.path} onClick={() => setMenuOpen(false)}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="account">
          <OrganizationSwitcher />
          <span className="account-name">{user.name}</span>
          <span className="account-role">{roleSummary(user)}</span>
          <button type="button" className="button button-quiet" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" className="content" tabIndex={-1} ref={main}>
        <Outlet />
      </main>
    </OrganizationsProvider>
  );
}
