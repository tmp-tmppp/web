import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { PENDING_WAIT_MS } from "../src/pages/use-me";
import { useFakeClock } from "./support/clock";
import { contractHandler, problem, reply, unavailable } from "./support/contract";
import { createFakeOidc, oidcUser } from "./support/fake-oidc";
import { lookup, MARKET_ID, organization, OTHER_TENANT_ID, quietHandlers, SHARE_TOKEN, TENANT_ID, traderOidc } from "./support/fixtures";
import type { FakeOidc } from "./support/fake-oidc";
import { TEST_CONFIG } from "./support/render";
import { server } from "./support/server";
import type { User } from "oidc-client-ts";

const typing = () => userEvent.setup({ delay: null });
const outsider = () => oidcUser({ roles: ["trader"], organization: [OTHER_TENANT_ID] });
const joined = (alias = TENANT_ID) => ({ alias, tenantId: alias, name: "Acme Traders", marketId: MARKET_ID, role: "trader", joined: true });

/** Where the router is, so a test can see that the token left the address bar. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function open(address: string, user: User | null = null): FakeOidc {
  const oidc = createFakeOidc(user);
  render(
    <MemoryRouter initialEntries={[address]}>
      <App config={TEST_CONFIG} manager={oidc.client} />
      <Where />
    </MemoryRouter>,
  );
  return oidc;
}

const link = `/share#${SHARE_TOKEN}`;
const lookupIs = (answer: Parameters<typeof lookup>[0], seen?: { body?: unknown; auth?: string | null; url?: string }) =>
  contractHandler("lookupSharedMarket", ({ body, request }) => {
    if (seen) Object.assign(seen, { body, auth: request.headers.get("Authorization"), url: request.url });
    return reply(200, lookup(answer));
  });
const notPermitted = (extra: { organization?: { name: string | null }; next?: string[] }) =>
  contractHandler("lookupSharedMarket", () => reply(403, problem(403, "Forbidden", { code: "share_link_not_permitted", detail: "This link is not for you.", ...extra })));

beforeEach(() => server.use(...quietHandlers()));

describe("the share page without a session", () => {
  it("shows the market of a link for everyone, keeps the token out of every address and offers the sign-in that comes back here", async () => {
    const seen: { body?: unknown; auth?: string | null; url?: string } = {};
    server.use(lookupIs({ next: ["sign_in"] }, seen));
    const oidc = open(link);
    expect(await screen.findByRole("heading", { name: "Will the shared market open before Friday?" })).toBeInTheDocument();
    expect(screen.getByText("Acme Traders")).toBeInTheDocument();
    expect(screen.getByText("Everyone who has the link")).toBeInTheDocument();
    expect(seen.body).toEqual({ token: SHARE_TOKEN });
    expect(seen.auth).toBeNull();
    expect(seen.url).not.toContain(SHARE_TOKEN);
    // The address bar shows the page only; the token is in memory. The page removes it in an effect after its first
    // render, which a slow machine shows after the heading, so the test waits for it.
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/share$/));
    expect(screen.getByTestId("credits-hint")).toHaveTextContent("kept per organization");

    await typing().click(screen.getByRole("button", { name: "Sign in to trade" }));
    expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: link } });
  });

  it("needs a complete link and sends no request without one", async () => {
    open("/share#short");
    expect(await screen.findByRole("alert")).toHaveTextContent("needs a share link");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/share$/));
  });

  it("opens no market without a token at all", async () => {
    open("/share");
    expect(await screen.findByRole("alert")).toHaveTextContent("needs a share link");
  });

  it("gives one answer for an unknown, expired or revoked link", async () => {
    server.use(contractHandler("lookupSharedMarket", () => reply(404, problem(404, "Not found", { code: "not_found" }))));
    open(link);
    expect(await screen.findByRole("heading", { name: "This link does not work" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ended, been revoked or been copied incompletely");
    expect(screen.queryByRole("link", { name: "Back to the start page" })).not.toBeInTheDocument();
  });

  it("asks to sign in when a members link refuses an anonymous caller", async () => {
    server.use(notPermitted({ organization: { name: "Acme Traders" }, next: ["sign_in"] }));
    const oidc = open(link);
    expect(await screen.findByRole("heading", { name: "This link is not for you" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("a market of Acme Traders");
    await typing().click(screen.getByRole("button", { name: "Sign in" }));
    expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: link } });
  });

  it("can try again after a 503", async () => {
    let calls = 0;
    server.use(
      contractHandler("lookupSharedMarket", () => {
        calls += 1;
        return calls === 1 ? unavailable("markets_unavailable", 3) : reply(200, lookup());
      }),
    );
    open(link);
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 3 seconds.");
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Will the shared market open before Friday?" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});

describe("the share page with a session", () => {
  it("sends the bearer token, and lets a member of the organization open the market", async () => {
    const seen: { auth?: string | null } = {};
    server.use(lookupIs({ linkType: "members", next: ["trade"] }, seen));
    open(link, traderOidc());
    expect(await screen.findByRole("link", { name: "Open the market" })).toHaveAttribute("href", `/markets/${MARKET_ID}`);
    expect(seen.auth).toMatch(/^Bearer \S+$/);
    expect(screen.getByRole("link", { name: "the wallet" })).toHaveAttribute("href", "/wallet");
  });

  it("joins the organization, signs in for it and comes back to the page that opens the market", async () => {
    let sent: unknown;
    server.use(
      lookupIs({ next: ["join"] }),
      contractHandler("joinByShareLink", ({ body }) => {
        sent = body;
        return reply(200, joined());
      }),
    );
    const oidc = open(link, outsider());
    await typing().click(await screen.findByRole("button", { name: "Join Acme Traders and open the market" }));
    await vi.waitFor(() => expect(oidc.signinRedirect).toHaveBeenCalledTimes(1));
    expect(sent).toEqual({ token: SHARE_TOKEN });
    expect(oidc.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: `/share/ready?market=${MARKET_ID}` },
      scope: `openid profile email chance-organization:${TENANT_ID}`,
    });
  });

  it("goes straight on when the token already is for that organization", async () => {
    server.use(
      lookupIs({ next: ["join"] }),
      contractHandler("joinByShareLink", () => reply(200, { ...joined(), joined: false })),
      contractHandler("listMyOrganizations", () => reply(200, { items: [organization()], nextCursor: null, identityPending: false })),
    );
    const oidc = open(link, traderOidc());
    await typing().click(await screen.findByRole("button", { name: "Join Acme Traders and open the market" }));
    expect(await screen.findByRole("heading", { name: "You are in Acme Traders" })).toBeInTheDocument();
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open the market" })).toHaveAttribute("href", `/markets/${MARKET_ID}`);
  });

  it("waits until the identity provider holds the membership before it signs in again", async () => {
    useFakeClock();
    let reads = 0;
    server.use(
      lookupIs({ next: ["join"] }),
      contractHandler("joinByShareLink", () => reply(200, joined())),
      contractHandler("listMyOrganizations", () => {
        reads += 1;
        return reply(200, { items: [], nextCursor: null, identityPending: reads < 3 });
      }),
    );
    const oidc = open(link, outsider());
    await typing().click(await screen.findByRole("button", { name: "Join Acme Traders and open the market" }));
    expect(await screen.findByText(/Waiting for the identity provider/)).toBeInTheDocument();
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_WAIT_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_WAIT_MS);
    });
    await vi.waitFor(() => expect(oidc.signinRedirect).toHaveBeenCalledTimes(1));
  });

  it("explains a refused join with the answer of the service", async () => {
    server.use(
      lookupIs({ next: ["join"] }),
      contractHandler("joinByShareLink", () => reply(403, problem(403, "Not allowed", { code: "share_link_not_permitted", detail: "Your e-mail address is not on the list." }))),
    );
    const oidc = open(link, outsider());
    await typing().click(await screen.findByRole("button", { name: "Join Acme Traders and open the market" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You could not join");
    expect(alert).toHaveTextContent("Your e-mail address is not on the list.");
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Join Acme Traders and open the market" })).toBeEnabled();
  });

  it("names the organization of a members link and offers the switch when the caller belongs to it", async () => {
    server.use(
      notPermitted({ organization: { name: "Acme Traders" }, next: ["switch_organization"] }),
      contractHandler("listMyOrganizations", () => reply(200, { items: [organization({ alias: OTHER_TENANT_ID, tenantId: OTHER_TENANT_ID, name: "Beta Bets" }), organization()], nextCursor: null, identityPending: false })),
    );
    const oidc = open(link, outsider());
    await typing().click(await screen.findByRole("button", { name: "Switch to Acme Traders" }));
    expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: link }, scope: `openid profile email chance-organization:${TENANT_ID}` });
  });

  it("sends a caller who is no member of that organization to its admin", async () => {
    server.use(notPermitted({ organization: { name: "Acme Traders" }, next: ["switch_organization"] }));
    open(link, outsider());
    expect(await screen.findByRole("heading", { name: "This link is not for you" })).toBeInTheDocument();
    expect(screen.getByText(/ask its admin for an invite/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch to/ })).not.toBeInTheDocument();
  });

  it("tells a caller who is not on the list of a profiles link", async () => {
    server.use(notPermitted({ organization: { name: "Acme Traders" }, next: [] }));
    open(link, traderOidc());
    expect(await screen.findByText(/verified/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the start page" })).toBeInTheDocument();
  });

  it("does not need a name for the organization", async () => {
    server.use(notPermitted({ organization: { name: null }, next: [] }));
    open(link, traderOidc());
    expect(await screen.findByRole("alert")).toHaveTextContent("a market that is not open to you");
  });

  it("tells a member of another organization to switch with the menu when the answer is only switch_organization", async () => {
    server.use(lookupIs({ next: ["switch_organization"] }));
    open(link, outsider());
    expect(await screen.findByText(/Switch to Acme Traders with the menu at the top/)).toBeInTheDocument();
  });

  it("does not offer to trade in a market that is closed", async () => {
    server.use(lookupIs({ market: { ...lookup().market, status: "closed" }, next: [] }));
    open(link, traderOidc());
    expect(await screen.findByText("Closed")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the market" })).not.toBeInTheDocument();
  });
});

describe("the page after joining", () => {
  it("opens the market and points to the wallet of the organization", async () => {
    server.use(contractHandler("listMyOrganizations", () => reply(200, { items: [organization()], nextCursor: null, identityPending: false })));
    open(`/share/ready?market=${MARKET_ID}`, traderOidc());
    expect(await screen.findByRole("heading", { name: "You are in Acme Traders" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the market" })).toHaveAttribute("href", `/markets/${MARKET_ID}`);
    expect(screen.getByRole("link", { name: "the wallet" })).toHaveAttribute("href", "/wallet");
  });

  it("falls back to the list of markets when the market id is not one", async () => {
    open("/share/ready?market=../../x", traderOidc());
    expect(await screen.findByRole("link", { name: "Go to the markets" })).toHaveAttribute("href", "/markets");
  });

  it("is only for members of an organization", async () => {
    open(`/share/ready?market=${MARKET_ID}`, oidcUser());
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });
});
