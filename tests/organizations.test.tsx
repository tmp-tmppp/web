import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { scopeFor } from "../src/auth/oidc";
import { contractHandler, reply, unavailable } from "./support/contract";
import { INVITE_CODE, OTHER_TENANT_ID, newcomerOidc, organization, quietHandlers, TENANT_ID, tenantAdminOidc, traderOidc } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const acme = organization();
const beta = organization({ alias: OTHER_TENANT_ID, tenantId: OTHER_TENANT_ID, name: "Beta Bets", slug: "beta-bets", role: "tenant-admin" });

const organizationsAre = (items: ReturnType<typeof organization>[], identityPending = false) =>
  contractHandler("listMyOrganizations", () => reply(200, { items, nextCursor: null, identityPending }));

beforeEach(() => server.use(...quietHandlers()));

describe("scopeFor", () => {
  it("asks for the plain organization scope first and for one organization when an alias is given", () => {
    expect(scopeFor()).toBe("openid profile email chance-organization");
    expect(scopeFor(null)).toBe("openid profile email chance-organization");
    expect(scopeFor(TENANT_ID)).toBe(`openid profile email chance-organization:${TENANT_ID}`);
  });

  it.each(["a b", "acme:*", "a/b", "*", "acme\n"])("refuses the alias %j", (alias) => {
    expect(() => scopeFor(alias)).toThrow("not valid");
  });
});

describe("the organization switcher", () => {
  it("shows nothing for a user without an organization", async () => {
    renderApp({ user: newcomerOidc() });
    await screen.findByRole("heading", { name: "Join an organization" });
    expect(screen.queryByTestId("organization-name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
  });

  it("shows the name of the only organization as text", async () => {
    server.use(organizationsAre([acme]));
    renderApp({ user: traderOidc() });
    expect(await screen.findByTestId("organization-name")).toHaveTextContent("Acme Traders");
    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
  });

  it("lists every organization and signs in again for the chosen one, coming back to the same page", async () => {
    server.use(organizationsAre([acme, beta]));
    const oidc = renderApp({ user: traderOidc(), path: "/wallet" });
    const select = await screen.findByLabelText("Organization");
    expect(select).toHaveValue(TENANT_ID);
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Acme Traders", "Beta Bets"]);
    await userEvent.setup().selectOptions(select, OTHER_TENANT_ID);
    expect(oidc.signinRedirect).toHaveBeenCalledTimes(1);
    expect(oidc.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: "/wallet" },
      scope: `openid profile email chance-organization:${OTHER_TENANT_ID}`,
    });
  });

  it("does not sign in again for the organization the token already is for", async () => {
    server.use(organizationsAre([acme, beta]));
    const oidc = renderApp({ user: traderOidc() });
    const select = await screen.findByLabelText("Organization");
    await userEvent.setup().selectOptions(select, TENANT_ID);
    expect(oidc.signinRedirect).not.toHaveBeenCalled();
  });

  it("asks a user whose token has no organization to choose one", async () => {
    server.use(organizationsAre([acme]));
    renderApp({ user: newcomerOidc() });
    const select = await screen.findByLabelText("Organization");
    expect(select).toHaveValue("");
    expect(within(select).getByRole("option", { name: "Choose an organization" })).toBeDisabled();
  });

  it("reads every page of the list", async () => {
    server.use(
      contractHandler("listMyOrganizations", ({ query }) =>
        query.get("cursor") === "next" ? reply(200, { items: [beta], nextCursor: null, identityPending: false }) : reply(200, { items: [acme], nextCursor: "next", identityPending: false }),
      ),
    );
    renderApp({ user: traderOidc() });
    const select = await screen.findByLabelText("Organization");
    expect(within(select).getAllByRole("option")).toHaveLength(2);
  });

  it("leaves the page working when the list cannot be read", async () => {
    server.use(contractHandler("listMyOrganizations", () => unavailable("tenants_unavailable")));
    renderApp({ user: traderOidc() });
    expect(await screen.findByRole("heading", { name: "Markets" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
  });
});

describe("joining a further organization", () => {
  it("lets a member join with an invite, then reads the organizations again", async () => {
    let reads = 0;
    server.use(
      contractHandler("listMyOrganizations", () => {
        reads += 1;
        return reply(200, { items: reads === 1 ? [acme] : [acme, beta], nextCursor: null, identityPending: false });
      }),
      contractHandler("acceptInvite", () => reply(200, { tenantId: OTHER_TENANT_ID, role: "tenant-admin" })),
    );
    renderApp({ user: tenantAdminOidc(), path: "/join" });
    expect(await screen.findByRole("heading", { name: "Join an organization" })).toBeInTheDocument();
    const user = userEvent.setup({ delay: null });
    await user.type(await screen.findByLabelText("Invite code"), INVITE_CODE);
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText("You joined the organization as tenant-admin.")).toBeInTheDocument();
    expect(await screen.findByLabelText("Organization")).toHaveValue(TENANT_ID);
    expect(reads).toBe(2);
  });
});
