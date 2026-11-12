import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PENDING_MAX_WAITS, PENDING_WAIT_MS } from "../src/pages/use-me";
import { useFakeClock } from "./support/clock";
import { contractHandler, problem, reply, unauthorized, unavailable } from "./support/contract";
import { createFakeOidc } from "./support/fake-oidc";
import { INVITE_CODE, me, newcomerOidc, platformAdminOidc, TENANT_ID, traderOidc, USER_ID } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const timers = useFakeClock;
const typing = () => userEvent.setup({ delay: null });

function definition(term: string): HTMLElement {
  const dt = screen.getByText(term, { selector: "dt" });
  return dt.nextElementSibling as HTMLElement;
}

describe("profile", () => {
  it("shows the user, the tenant and the role", async () => {
    server.use(contractHandler("getMe", () => reply(200, me({ role: "tenant-admin" }))));
    renderApp({ user: traderOidc(), path: "/profile" });
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    await screen.findByText("Role in the tenant");
    expect(definition("Name")).toHaveTextContent("Ana Novak");
    expect(definition("E-mail")).toHaveTextContent("ana@example.test");
    expect(definition("User id")).toHaveTextContent(USER_ID);
    expect(definition("Tenant")).toHaveTextContent(TENANT_ID);
    expect(definition("Role in the tenant")).toHaveTextContent("Tenant admin");
    expect(screen.queryByText(/being set up/)).not.toBeInTheDocument();
  });

  it("points a user without a tenant to the invite code", async () => {
    server.use(contractHandler("getMe", () => reply(200, me({ tenantId: null, role: null, tokenTenantId: null }))));
    renderApp({ user: newcomerOidc(), path: "/profile" });
    await screen.findByText("Role in the tenant");
    expect(definition("Role in the tenant")).toHaveTextContent("None");
    expect(within(definition("Tenant")).getByRole("link", { name: "join an organization" })).toHaveAttribute("href", "/join");
  });

  it("shows the platform role of a platform admin", async () => {
    server.use(contractHandler("getMe", () => reply(200, me({ tenantId: null, role: null, tokenTenantId: null }))));
    renderApp({ user: platformAdminOidc(), path: "/profile" });
    await screen.findByText("Platform role");
    expect(definition("Platform role")).toHaveTextContent("Platform admin");
  });

  it("waits while the identity provider catches up, then refreshes the session once and reads again", async () => {
    timers();
    const answers = [me({ identityPending: true, tokenNeedsRefresh: true, tokenTenantId: null }), me({ tokenNeedsRefresh: true, tokenTenantId: null }), me()];
    let reads = 0;
    server.use(contractHandler("getMe", () => reply(200, answers[Math.min(reads++, answers.length - 1)])));
    const oidc = renderApp({ user: newcomerOidc(), path: "/profile" });
    expect(await screen.findByText(/being set up at the identity provider/)).toBeInTheDocument();
    expect(oidc.signinSilent).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_WAIT_MS);
    });
    await waitFor(() => expect(oidc.signinSilent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.queryByText(/Refreshing your session/)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Refresh your session" })).not.toBeInTheDocument();
    expect(oidc.signinSilent).toHaveBeenCalledTimes(1);
  });

  it("gives up waiting after a while and offers to check again", async () => {
    timers();
    let pending = true;
    let reads = 0;
    server.use(
      contractHandler("getMe", () => {
        reads += 1;
        return reply(200, me({ identityPending: pending }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/profile" });
    await screen.findByText(/being set up/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_WAIT_MS * PENDING_MAX_WAITS);
    });
    expect(await screen.findByText(/has not caught up yet/)).toBeInTheDocument();
    expect(reads).toBe(PENDING_MAX_WAITS + 1);
    pending = false;
    await typing().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByText(/has not caught up yet/)).not.toBeInTheDocument());
    expect(reads).toBe(PENDING_MAX_WAITS + 2);
  });

  it("says so when the renewed session still differs, and refreshes again on request", async () => {
    server.use(contractHandler("getMe", () => reply(200, me({ tokenNeedsRefresh: true }))));
    const oidc = createFakeOidc(traderOidc());
    oidc.signinSilent.mockRejectedValue(new Error("no refresh token"));
    renderApp({ oidc, path: "/profile" });
    expect(await screen.findByText(/does not show your latest tenant or role/)).toBeInTheDocument();
    expect(oidc.signinSilent).toHaveBeenCalledTimes(1);
    await typing().click(screen.getByRole("button", { name: "Refresh your session" }));
    await waitFor(() => expect(oidc.signinSilent.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText(/does not show your latest tenant or role/)).toBeInTheDocument();
  });

  it("shows a 503 with its wait and recovers on a second try", async () => {
    let fail = true;
    server.use(contractHandler("getMe", () => (fail ? unavailable("identity_provider_unavailable", 7) : reply(200, me()))));
    renderApp({ user: traderOidc(), path: "/profile" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your profile could not be loaded");
    expect(alert).toHaveTextContent("Try again in about 7 seconds.");
    fail = false;
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Role in the tenant")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ends the session on a 401 that stays after the renewal", async () => {
    server.use(contractHandler("getMe", () => unauthorized()));
    renderApp({ user: traderOidc(), path: "/profile" });
    expect(await screen.findByText(/Your session has ended/)).toBeInTheDocument();
  });
});

describe("join", () => {
  it("accepts the invite code and goes to the profile, which waits for the identity provider", async () => {
    let sentCode = "";
    server.use(
      contractHandler("acceptInvite", ({ params }) => {
        sentCode = params["code"] ?? "";
        return reply(200, { tenantId: TENANT_ID, role: "trader" });
      }),
      contractHandler("getMe", () => reply(200, me({ identityPending: true }))),
    );
    renderApp({ user: newcomerOidc(), path: "/join" });
    const user = typing();
    await user.type(await screen.findByLabelText("Invite code"), `  ${INVITE_CODE}  `);
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(sentCode).toBe(INVITE_CODE);
    expect(screen.getByText("You joined the organization as trader.")).toBeInTheDocument();
    expect(await screen.findByText(/being set up at the identity provider/)).toBeInTheDocument();
  });

  it("rejects a code of the wrong length before any request", async () => {
    renderApp({ user: newcomerOidc(), path: "/join" });
    const user = typing();
    await user.type(await screen.findByLabelText("Invite code"), "short");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("16 to 128 characters");
    expect(screen.getByLabelText("Invite code")).toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    [400, "The request is invalid", "validation_failed", undefined],
    [404, "Invite not found", "invite_not_found", "typing mistakes"],
    [410, "Invite expired", "invite_expired", "new invite code"],
  ])("shows the answer %i with the service's own words", async (status, title, code, advice) => {
    server.use(contractHandler("acceptInvite", () => reply(status, problem(status, title, { code, detail: "Detail of the problem." }))));
    renderApp({ user: newcomerOidc(), path: "/join" });
    const user = typing();
    await user.type(await screen.findByLabelText("Invite code"), INVITE_CODE);
    await user.click(screen.getByRole("button", { name: "Join" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You could not join");
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent("Detail of the problem.");
    if (advice) expect(screen.getByText(new RegExp(advice))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
  });

  it("shows a 503 with its wait", async () => {
    server.use(contractHandler("acceptInvite", () => unavailable("identity_provider_unavailable", 3)));
    renderApp({ user: newcomerOidc(), path: "/join" });
    const user = typing();
    await user.type(await screen.findByLabelText("Invite code"), INVITE_CODE);
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 3 seconds.");
  });

  it("ends the session on a 401", async () => {
    server.use(contractHandler("acceptInvite", () => unauthorized()));
    renderApp({ user: newcomerOidc(), path: "/join" });
    const user = typing();
    await user.type(await screen.findByLabelText("Invite code"), INVITE_CODE);
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText(/Your session has ended/)).toBeInTheDocument();
  });
});
