import type { ReactElement } from "react";
import type { RouteAccess } from "../auth/access";
import type { AppConfig } from "../config/types";
import { InvitesPage } from "../pages/admin/InvitesPage";
import { MembersPage } from "../pages/admin/MembersPage";
import { AuditPage } from "../pages/audit/AuditPage";
import { JoinPage } from "../pages/JoinPage";
import { PlatformTenantsPage } from "../pages/platform/PlatformTenantsPage";
import { ProfilePage } from "../pages/ProfilePage";
import { MarketDataPage } from "../pages/markets/MarketDataPage";
import { MarketPage } from "../pages/markets/MarketPage";
import { MarketsPage } from "../pages/markets/MarketsPage";
import { PortfolioPage } from "../pages/markets/PortfolioPage";
import { ShareReadyPage } from "../pages/share/ShareReadyPage";
import { SharePage } from "../pages/share/SharePage";
import { DepositReturnPage } from "../pages/wallet/DepositReturnPage";
import { WalletPage } from "../pages/wallet/WalletPage";

export interface AppRoute {
  path: string;
  /** Page title: the browser tab and, for a route without a page of its own yet, the heading. */
  title: string;
  /** Who may open it. The same rule hides the menu entry and guards a direct address. */
  access: RouteAccess;
  /** Present: the route has a menu entry. Entries are ordered by "order". */
  nav?: { label: string; order: number };
  element: ReactElement;
}

const TRADING_ROLES = ["trader", "tenant-admin"] as const;

/**
 * Every page of the app with who may open it. A page is added here and nowhere else: the router, the menu and the
 * guard all read this table. The paths of the deposit return pages come from the runtime configuration because the
 * payments service fixes them (DEPOSIT_SUCCESS_URL, DEPOSIT_CANCEL_URL).
 */
export function buildRoutes(config: AppConfig): AppRoute[] {
  const wallet: RouteAccess = { roles: TRADING_ROLES, tenant: "required" };
  const tenantAdmin: RouteAccess = { roles: ["tenant-admin"], tenant: "required" };
  return [
    // Account: every signed-in user (tenants service).
    { path: "/profile", title: "Profile", access: {}, nav: { label: "Profile", order: 10 }, element: <ProfilePage /> },
    {
      path: "/join",
      title: "Join an organization",
      // Also for a user who already belongs to one: an invite adds a further organization (token contract v2).
      access: { notRoles: ["platform-admin"] },
      nav: { label: "Join an organization", order: 20 },
      element: <JoinPage />,
    },

    // Markets, trading and market-data (src/pages/markets/): the market list and one market, and the portfolio below.
    { path: "/markets", title: "Markets", access: wallet, nav: { label: "Markets", order: 30 }, element: <MarketsPage /> },
    { path: "/markets/:marketId", title: "Market", access: wallet, element: <MarketPage /> },
    // A share link leads here (the link itself is /share#<token>, which a server never sees): open to everybody.
    { path: "/share", title: "Shared market", access: {}, element: <SharePage /> },
    { path: "/share/ready", title: "Shared market", access: { roles: TRADING_ROLES, tenant: "required" }, element: <ShareReadyPage /> },
    { path: "/portfolio", title: "Portfolio", access: wallet, nav: { label: "Portfolio", order: 40 }, element: <PortfolioPage /> },
    { path: "/market-data", title: "Market data", access: wallet, nav: { label: "Market data", order: 50 }, element: <MarketDataPage /> },

    // Wallet (payments): deposit, withdraw, and the two pages the payment provider sends the buyer back to.
    { path: "/wallet", title: "Wallet", access: wallet, nav: { label: "Wallet", order: 60 }, element: <WalletPage /> },
    { path: config.depositSuccessPath, title: "Deposit", access: wallet, element: <DepositReturnPage variant="success" /> },
    { path: config.depositCancelPath, title: "Deposit cancelled", access: wallet, element: <DepositReturnPage variant="cancelled" /> },

    // Tenant admin (tenants, audit).
    { path: "/admin/members", title: "Members", access: tenantAdmin, nav: { label: "Members", order: 70 }, element: <MembersPage /> },
    { path: "/admin/invites", title: "Invites", access: tenantAdmin, nav: { label: "Invites", order: 80 }, element: <InvitesPage /> },
    { path: "/audit", title: "Audit log", access: tenantAdmin, nav: { label: "Audit log", order: 90 }, element: <AuditPage /> },

    // Platform admin (tenants).
    {
      path: "/platform/tenants",
      title: "Tenants",
      access: { roles: ["platform-admin"] },
      nav: { label: "Tenants", order: 100 },
      element: <PlatformTenantsPage />,
    },
  ];
}
