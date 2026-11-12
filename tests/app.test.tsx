import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateAccess, landingPath } from "../src/auth/access";
import type { AuthUser } from "../src/auth/types";
import { navigationFor } from "../src/components/Layout";
import { buildRoutes } from "../src/routes/route-table";
import { createFakeOidc, oidcUser } from "./support/fake-oidc";
import { renderApp, TEST_CONFIG } from "./support/render";
import { server } from "./support/server";
import { MARKET_ID, quietHandlers, TENANT_ID } from "./support/fixtures";
import { gqlPage, graphqlEndpoint } from "./support/graphql";

const trader = () => oidcUser({ roles: ["trader"], organization: [TENANT_ID] });
const tenantAdmin = () => oidcUser({ roles: ["tenant-admin"], organization: [TENANT_ID] });
const platformAdmin = () => oidcUser({ roles: ["platform-admin"] });
const newcomer = () => oidcUser();

// The pages read their data on mount; these tests are about the shell, so the services answer with empty results.
beforeEach(() => server.use(...quietHandlers()));

async function menu(): Promise<string[]> {
  const nav = await screen.findByRole("navigation", { name: "Main" });
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

function user(partial: Partial<AuthUser>): AuthUser {
  return { id: "u", username: "u", name: "U", email: null, roles: [], tenantId: null, ...partial };
}

describe("without a session", () => {
  it("shows the sign-in page, and the button returns to the page that was asked for", async () => {
    const oidc = renderApp({ path: "/wallet" });
    expect(screen.getByRole("status")).toHaveTextContent("Signing you in");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("heading", { name: "Chance" })).toBeInTheDocument();
    expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: "/wallet" } });
    await waitFor(() => expect(document.title).toBe("Sign in - Chance"));
  });

  it("says that the session ended", async () => {
    const oidc = renderApp({ user: trader() });
    await menu();
    act(() => oidc.emit.expired());
    expect(await screen.findByText(/Your session has ended/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

describe("a completed login", () => {
  it("returns to the page the user asked for, not to the start page", async () => {
    const signedIn = oidcUser({ roles: ["tenant-admin"], organization: [TENANT_ID], state: { returnTo: "/audit" } });
    const oidc = createFakeOidc(signedIn);
    oidc.signinCallback.mockResolvedValue(signedIn);
    renderApp({ oidc, path: "/auth/callback?code=abc&state=xyz" });
    expect(await screen.findByRole("heading", { name: "Audit log" })).toBeInTheDocument();
  });
});

describe("a failed login", () => {
  it("is explained and can be retried", async () => {
    const oidc = createFakeOidc(null);
    oidc.signinCallback.mockRejectedValue(new Error("The login was refused"));
    renderApp({ oidc, path: "/auth/callback?error=access_denied" });
    expect(await screen.findByRole("heading", { name: "Sign-in failed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The login was refused");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: "/" } });
  });

  it("falls back to a general message when the error has none", async () => {
    const oidc = createFakeOidc(null);
    oidc.signinCallback.mockRejectedValue(new Error(""));
    renderApp({ oidc, path: "/auth/callback?error=x" });
    expect(await screen.findByRole("alert")).toHaveTextContent("did not complete the login");
  });
});

describe("navigation by role", () => {
  it("a trader sees the trading pages and the wallet, and lands on the markets", async () => {
    renderApp({ user: trader() });
    expect(await menu()).toEqual(["Profile", "Join an organization", "Markets", "Portfolio", "Market data", "Wallet"]);
    expect(await screen.findByRole("heading", { name: "Markets" })).toBeInTheDocument();
  });

  it("a tenant admin also sees members, invites and the audit log", async () => {
    renderApp({ user: tenantAdmin() });
    expect(await menu()).toEqual(["Profile", "Join an organization", "Markets", "Portfolio", "Market data", "Wallet", "Members", "Invites", "Audit log"]);
  });

  it("a platform admin sees the tenants and nothing of the trading side, and lands on the tenants", async () => {
    renderApp({ user: platformAdmin() });
    expect(await menu()).toEqual(["Profile", "Tenants"]);
    expect(await screen.findByRole("heading", { name: "Tenants" })).toBeInTheDocument();
  });

  it("a user without a tenant can only join one, and lands on the join page", async () => {
    renderApp({ user: newcomer() });
    expect(await menu()).toEqual(["Profile", "Join an organization"]);
    expect(await screen.findByRole("heading", { name: "Join an organization" })).toBeInTheDocument();
  });

  it("shows the name and role of the user and signs out", async () => {
    const oidc = renderApp({ user: tenantAdmin() });
    await menu();
    expect(screen.getByText("Ana Novak")).toBeInTheDocument();
    expect(screen.getByText("Tenant admin")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(oidc.signoutRedirect).toHaveBeenCalledTimes(1);
  });

  it("labels a member without an app role and a user without a tenant", async () => {
    renderApp({ user: oidcUser({ organization: ["acme"] }) });
    await menu();
    expect(screen.getByText("Member")).toBeInTheDocument();
  });

  it("marks the current page and moves the focus to it after a navigation", async () => {
    renderApp({ user: trader() });
    await menu();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Wallet" }));
    expect(await screen.findByRole("heading", { name: "Wallet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wallet" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    await waitFor(() => expect(document.title).toBe("Wallet - Chance"));
  });

  it("opens and closes the menu on a narrow screen", async () => {
    renderApp({ user: trader() });
    await menu();
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Main" })).toHaveClass("nav-open");
    await user.click(screen.getByRole("link", { name: "Portfolio" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("has a link that skips the navigation", async () => {
    renderApp({ user: trader() });
    await menu();
    expect(screen.getByRole("link", { name: "Skip to the page" })).toHaveAttribute("href", "#main");
  });

  it("goes to the start page from the brand", async () => {
    renderApp({ user: platformAdmin(), path: "/profile" });
    await menu();
    await userEvent.setup().click(screen.getByRole("link", { name: "Chance" }));
    expect(await screen.findByRole("heading", { name: "Tenants" })).toBeInTheDocument();
  });
});

describe("the guard", () => {
  it("shows 'not allowed' for a page of another role, also by direct address", async () => {
    renderApp({ user: trader(), path: "/audit" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your role does not allow this page.");
    await waitFor(() => expect(document.title).toBe("Not allowed - Chance"));
    expect(screen.queryByRole("heading", { name: "Audit log" })).not.toBeInTheDocument();
  });

  it.each(["/platform/tenants", "/admin/members", "/admin/invites"])("keeps a trader out of %s", async (path) => {
    renderApp({ user: trader(), path });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });

  it("keeps a platform admin out of the trading pages and tells a tenant-less user to join", async () => {
    renderApp({ user: platformAdmin(), path: "/wallet" });
    expect(await screen.findByRole("alert")).toHaveTextContent("only for members of a tenant");
    expect(screen.queryByRole("link", { name: /join your tenant/ })).not.toBeInTheDocument();
  });

  it("points a user without a tenant to the invite code", async () => {
    renderApp({ user: newcomer(), path: "/markets" });
    expect(await screen.findByRole("alert")).toHaveTextContent("only for members of a tenant");
    expect(screen.getByRole("link", { name: /join your tenant/ })).toHaveAttribute("href", "/join");
  });

  it("opens the join page for a member too: an invite adds a further organization", async () => {
    renderApp({ user: tenantAdmin(), path: "/join" });
    expect(await screen.findByRole("heading", { name: "Join an organization" })).toBeInTheDocument();
  });

  it("keeps a platform admin off the join page", async () => {
    renderApp({ user: platformAdmin(), path: "/join" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });

  it("opens a page the role allows", async () => {
    renderApp({ user: tenantAdmin(), path: "/audit" });
    expect(await screen.findByRole("heading", { name: "Audit log" })).toBeInTheDocument();
  });

  it("answers an unknown address with 'page not found'", async () => {
    renderApp({ user: trader(), path: "/nothing/here" });
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Page not found - Chance"));
  });

  it("leaves the login callback address for the start page", async () => {
    renderApp({ user: trader(), path: "/auth/callback" });
    expect(await screen.findByRole("heading", { name: "Markets" })).toBeInTheDocument();
  });
});

describe("deposit return pages", () => {
  it("exist at the paths of the configuration", async () => {
    renderApp({ user: trader(), path: "/deposits/success" });
    expect(await screen.findByRole("heading", { name: "Deposit" })).toBeInTheDocument();
  });

  it("follow another configuration and are not in the menu", async () => {
    renderApp({ user: trader(), path: "/back/ok", config: { ...TEST_CONFIG, depositSuccessPath: "/back/ok", depositCancelPath: "/back/no" } });
    expect(await screen.findByRole("heading", { name: "Deposit" })).toBeInTheDocument();
    expect(await menu()).not.toContain("Deposit");
  });

  it("are only for wallet users", async () => {
    renderApp({ user: platformAdmin(), path: "/deposits/cancelled" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });
});

describe("the markets pages", () => {
  // The market overview asks market-data's GraphQL endpoint; here it answers that there is no market.
  beforeEach(() => server.use(graphqlEndpoint({ markets: () => gqlPage([]) }).handler));

  it.each([
    ["/markets", "Markets"],
    [`/markets/${MARKET_ID}`, "Will the shared market open before Friday?"],
    ["/portfolio", "Portfolio"],
    ["/market-data", "Market data"],
  ])("%s is a real page, not a placeholder", async (path, heading) => {
    renderApp({ user: trader(), path });
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Placeholder.")).not.toBeInTheDocument();
    expect(document.querySelector("[data-placeholder='markets-trading']")).toBeNull();
    expect(document.querySelector("[data-share-hook]")).toBeNull();
  });
});

describe("access rules", () => {
  it("evaluates every condition of a rule", () => {
    expect(evaluateAccess(user({}), {})).toEqual({ allowed: true });
    expect(evaluateAccess(user({}), { roles: ["trader"] })).toEqual({ allowed: false, reason: "role" });
    expect(evaluateAccess(user({ roles: ["trader"] }), { roles: ["trader", "tenant-admin"] })).toEqual({ allowed: true });
    expect(evaluateAccess(user({ roles: ["platform-admin"] }), { notRoles: ["platform-admin"] })).toEqual({ allowed: false, reason: "role" });
    expect(evaluateAccess(user({}), { tenant: "required" })).toEqual({ allowed: false, reason: "tenant-required" });
    expect(evaluateAccess(user({ tenantId: "t" }), { tenant: "required" })).toEqual({ allowed: true });
    expect(evaluateAccess(user({ tenantId: "t" }), { tenant: "none" })).toEqual({ allowed: false, reason: "tenant-present" });
    expect(evaluateAccess(user({}), { tenant: "none" })).toEqual({ allowed: true });
  });

  it("picks the start page by role and tenant", () => {
    expect(landingPath(user({ roles: ["platform-admin"] }))).toBe("/platform/tenants");
    expect(landingPath(user({}))).toBe("/join");
    expect(landingPath(user({ roles: ["trader"], tenantId: "t" }))).toBe("/markets");
  });

  it("lists the menu entries of a role in order, from the same table as the guard", () => {
    const routes = buildRoutes(TEST_CONFIG);
    expect(navigationFor(user({ roles: ["tenant-admin"], tenantId: "t" }), routes).map((item) => item.label)).toEqual([
      "Profile",
      "Join an organization",
      "Markets",
      "Portfolio",
      "Market data",
      "Wallet",
      "Members",
      "Invites",
      "Audit log",
    ]);
    expect(navigationFor(user({}), routes).map((item) => item.path)).toEqual(["/profile", "/join"]);
    expect(new Set(routes.map((route) => route.path)).size).toBe(routes.length);
  });
});
