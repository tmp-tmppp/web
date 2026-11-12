import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { contractHandler, problem, reply, unavailable } from "./support/contract";
import { INVITE_CODE, member, OTHER_TENANT_ID, platformAdminOidc, tenant, tenantAdminOidc, TENANT_ID, USER_ID } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const typing = () => userEvent.setup({ delay: null });
const EXPIRES = "2026-11-18T10:00:00Z";
const invite = (overrides = {}) => ({ code: INVITE_CODE, role: "tenant-admin", maxUses: 1, expiresAt: EXPIRES, ...overrides });

describe("platform admin: tenants", () => {
  it("lists the tenants page by page with the cursor of the service", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      contractHandler("listTenants", ({ query }) => {
        cursors.push(query.get("cursor"));
        return query.get("cursor") === "next-1"
          ? reply(200, { items: [tenant({ id: OTHER_TENANT_ID, name: "Globex", slug: "globex", status: "suspended" })], nextCursor: null })
          : reply(200, { items: [tenant()], nextCursor: "next-1" });
      }),
    );
    renderApp({ user: platformAdminOidc() });
    const table = await screen.findByRole("table", { name: "Tenants, oldest first" });
    expect(within(table).getByRole("rowheader", { name: "Acme Traders" })).toBeInTheDocument();
    expect(within(table).getByText("Active")).toBeInTheDocument();
    await typing().click(screen.getByRole("button", { name: "Load more tenants" }));
    expect(await within(table).findByRole("rowheader", { name: "Globex" })).toBeInTheDocument();
    expect(within(table).getByText("Suspended")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more tenants" })).not.toBeInTheDocument();
    expect(cursors).toEqual([null, "next-1"]);
  });

  it("says when there are no tenants", async () => {
    server.use(contractHandler("listTenants", () => reply(200, { items: [], nextCursor: null })));
    renderApp({ user: platformAdminOidc() });
    expect(await screen.findByText("There are no tenants yet.")).toBeInTheDocument();
  });

  it("creates a tenant and shows the first admin's invite code once, with a copy button", async () => {
    let created = false;
    let sent: unknown;
    server.use(
      contractHandler("listTenants", () => reply(200, { items: created ? [tenant({ name: "Globex", slug: "globex" })] : [], nextCursor: null })),
      contractHandler("createTenant", ({ body }) => {
        sent = body;
        created = true;
        return reply(201, { tenant: tenant({ id: OTHER_TENANT_ID, name: "Globex", slug: "globex" }), adminInvite: invite() });
      }),
    );
    renderApp({ user: platformAdminOidc() });
    const user = typing();
    await user.type(await screen.findByLabelText("Name"), "  Globex  ");
    await user.type(screen.getByLabelText("Slug"), "globex");
    await user.click(screen.getByRole("button", { name: "Create the tenant" }));

    const heading = await screen.findByRole("heading", { name: "First admin invite for Globex" });
    expect(sent).toEqual({ name: "Globex", slug: "globex" });
    expect(heading).toHaveFocus();
    expect(screen.getByTestId("one-time-code")).toHaveTextContent(INVITE_CODE);
    expect(screen.getByText(/It is shown only once/)).toBeInTheDocument();
    expect(screen.getByText("Tenant admin", { selector: "dd" })).toBeInTheDocument();
    expect(await screen.findByRole("rowheader", { name: "Globex" })).toBeInTheDocument();
    // The form is empty again for the next tenant.
    expect(screen.getByLabelText("Name")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Copy the code" }));
    expect(await screen.findByText("Copied to the clipboard.")).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(INVITE_CODE);

    await user.click(screen.getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByTestId("one-time-code")).not.toBeInTheDocument();
  });

  it("tells the user when the browser refuses to copy", async () => {
    server.use(
      contractHandler("listTenants", () => reply(200, { items: [], nextCursor: null })),
      contractHandler("createTenant", () => reply(201, { tenant: tenant(), adminInvite: invite() })),
    );
    renderApp({ user: platformAdminOidc() });
    const user = typing();
    await user.type(await screen.findByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Slug"), "acme");
    await user.click(screen.getByRole("button", { name: "Create the tenant" }));
    await screen.findByTestId("one-time-code");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy the code" }));
    expect(await screen.findByText(/did not allow copying/)).toBeInTheDocument();
  });

  it("checks the name and the slug before a request", async () => {
    server.use(contractHandler("listTenants", () => reply(200, { items: [], nextCursor: null })));
    renderApp({ user: platformAdminOidc() });
    const user = typing();
    await user.type(await screen.findByLabelText("Slug"), "Bad Slug");
    await user.click(screen.getByRole("button", { name: "Create the tenant" }));
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription("Enter a name of 1 to 100 characters.");
    expect(screen.getByText("Enter a name of 1 to 100 characters.")).toBeInTheDocument();
    expect(screen.getByText(/Use 3 to 40 lowercase letters/, { selector: "p.field-error" })).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toHaveAttribute("aria-invalid", "true");
  });

  it("shows a taken slug as the service explains it", async () => {
    server.use(
      contractHandler("listTenants", () => reply(200, { items: [], nextCursor: null })),
      contractHandler("createTenant", () => reply(409, problem(409, "The slug is taken", { code: "slug_taken", detail: "Another tenant uses the slug acme." }))),
    );
    renderApp({ user: platformAdminOidc() });
    const user = typing();
    await user.type(await screen.findByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Slug"), "acme");
    await user.click(screen.getByRole("button", { name: "Create the tenant" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The tenant could not be created");
    expect(alert).toHaveTextContent("The slug is taken");
    expect(alert).toHaveTextContent("Another tenant uses the slug acme.");
    expect(screen.queryByTestId("one-time-code")).not.toBeInTheDocument();
  });

  it.each([
    [400, "Validation failed"],
    [403, "Forbidden"],
  ])("shows the answer %i of the service when the tenant is not created", async (status, title) => {
    server.use(
      contractHandler("listTenants", () => reply(200, { items: [], nextCursor: null })),
      contractHandler("createTenant", () => reply(status, problem(status, title, { errors: status === 400 ? [{ field: "slug", message: "is reserved" }] : [] }))),
    );
    renderApp({ user: platformAdminOidc() });
    const user = typing();
    await user.type(await screen.findByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Slug"), "acme");
    await user.click(screen.getByRole("button", { name: "Create the tenant" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(title);
    if (status === 400) expect(alert).toHaveTextContent("slug: is reserved");
  });

  it("shows a 503 with its wait when the list cannot be loaded, and loads it on a second try", async () => {
    let fail = true;
    server.use(contractHandler("listTenants", () => (fail ? unavailable("identity_provider_unavailable", 11) : reply(200, { items: [tenant()], nextCursor: null }))));
    renderApp({ user: platformAdminOidc() });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The tenants could not be loaded");
    expect(alert).toHaveTextContent("Try again in about 11 seconds.");
    fail = false;
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("rowheader", { name: "Acme Traders" })).toBeInTheDocument();
  });

  it("keeps the tenants shown when a later page fails", async () => {
    let calls = 0;
    server.use(contractHandler("listTenants", () => (calls++ === 0 ? reply(200, { items: [tenant()], nextCursor: "n" }) : unavailable("tenant_not_ready", 2))));
    renderApp({ user: platformAdminOidc() });
    await typing().click(await screen.findByRole("button", { name: "Load more tenants" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load more tenants");
    expect(screen.getByRole("rowheader", { name: "Acme Traders" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more tenants" })).toBeEnabled();
  });
});

describe("tenant admin: invites", () => {
  it("creates an invite with the defaults and shows the code once", async () => {
    let seen: { id?: string; body?: unknown } = {};
    server.use(
      contractHandler("createInvite", ({ params, body }) => {
        seen = { id: params["id"], body };
        return reply(201, invite({ role: "trader" }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/admin/invites" });
    await typing().click(await screen.findByRole("button", { name: "Create the invite" }));
    const heading = await screen.findByRole("heading", { name: "Invite code" });
    expect(seen).toEqual({ id: TENANT_ID, body: { role: "trader", maxUses: 1, expiresInHours: 168 } });
    expect(heading).toHaveFocus();
    expect(screen.getByTestId("one-time-code")).toHaveTextContent(INVITE_CODE);
    expect(screen.getByText("One person")).toBeInTheDocument();
  });

  it("sends the role, the uses and the validity the admin chose", async () => {
    let sent: unknown;
    server.use(
      contractHandler("createInvite", ({ body }) => {
        sent = body;
        return reply(201, invite({ maxUses: 5 }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/admin/invites" });
    const user = typing();
    await user.selectOptions(await screen.findByLabelText("Role it gives"), "tenant-admin");
    await user.clear(screen.getByLabelText("How many people may use it"));
    await user.type(screen.getByLabelText("How many people may use it"), "5");
    await user.clear(screen.getByLabelText("Valid for (hours)"));
    await user.type(screen.getByLabelText("Valid for (hours)"), "24");
    await user.click(screen.getByRole("button", { name: "Create the invite" }));
    expect(await screen.findByText("Up to 5 people")).toBeInTheDocument();
    expect(sent).toEqual({ role: "tenant-admin", maxUses: 5, expiresInHours: 24 });
    await user.click(screen.getByRole("button", { name: "Copy the code" }));
    expect(await navigator.clipboard.readText()).toBe(INVITE_CODE);
  });

  it("checks the numbers before a request", async () => {
    renderApp({ user: tenantAdminOidc(), path: "/admin/invites" });
    const user = typing();
    await user.clear(await screen.findByLabelText("How many people may use it"));
    await user.type(screen.getByLabelText("How many people may use it"), "0");
    await user.clear(screen.getByLabelText("Valid for (hours)"));
    await user.type(screen.getByLabelText("Valid for (hours)"), "721");
    await user.click(screen.getByRole("button", { name: "Create the invite" }));
    expect(screen.getByText("Enter a whole number from 1 to 100.")).toBeInTheDocument();
    expect(screen.getByText("Enter a whole number of hours from 1 to 720.")).toBeInTheDocument();
  });

  it.each([
    [400, "Invalid invite"],
    [403, "Forbidden"],
    [404, "Tenant not found"],
  ])("shows the answer %i of the service", async (status, title) => {
    server.use(contractHandler("createInvite", () => reply(status, problem(status, title, { detail: "Detail of it." }))));
    renderApp({ user: tenantAdminOidc(), path: "/admin/invites" });
    await typing().click(await screen.findByRole("button", { name: "Create the invite" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The invite could not be created");
    expect(alert).toHaveTextContent(title);
    expect(screen.getByText(/refresh your session/)).toBeInTheDocument();
    expect(screen.queryByTestId("one-time-code")).not.toBeInTheDocument();
  });

  it("shows a 503 with its wait", async () => {
    server.use(contractHandler("createInvite", () => unavailable("identity_provider_unavailable", 4)));
    renderApp({ user: tenantAdminOidc(), path: "/admin/invites" });
    await typing().click(await screen.findByRole("button", { name: "Create the invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 4 seconds.");
  });
});

describe("tenant admin: members", () => {
  it("lists the members page by page and marks the user", async () => {
    server.use(
      contractHandler("listMembers", ({ params, query }) => {
        expect(params["id"]).toBe(TENANT_ID);
        return query.get("cursor") === "m2"
          ? reply(200, { items: [member({ userId: "member-2" })], nextCursor: null })
          : reply(200, { items: [member({ userId: USER_ID, role: "tenant-admin" }), member()], nextCursor: "m2" });
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/admin/members" });
    const table = await screen.findByRole("table", { name: "Members of your tenant" });
    expect(within(table).getByText("(you)")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    await typing().click(screen.getByRole("button", { name: "Load more members" }));
    expect(await within(table).findByText("member-2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more members" })).not.toBeInTheDocument();
  });

  it("changes the role of a member and says when the change reaches the token", async () => {
    let sent: { params: Record<string, string>; body: unknown } | undefined;
    server.use(
      contractHandler("listMembers", () => reply(200, { items: [member({ userId: "kc|user 7" })], nextCursor: null })),
      contractHandler("changeMemberRole", ({ params, body }) => {
        sent = { params, body };
        return reply(200, { tenantId: TENANT_ID, userId: "kc|user 7", role: "tenant-admin", joinedAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T11:00:00Z" });
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/admin/members" });
    const user = typing();
    const button = await screen.findByRole("button", { name: "Change the role of kc|user 7" });
    expect(button).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("New role of kc|user 7"), "tenant-admin");
    await user.click(button);
    expect(await screen.findByText(/The role is now Tenant admin/)).toBeInTheDocument();
    expect(sent).toEqual({ params: { id: TENANT_ID, userId: "kc|user 7" }, body: { role: "tenant-admin" } });
    expect(screen.getByRole("cell", { name: "Tenant admin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change the role of kc|user 7" })).toBeDisabled();
  });

  it("shows why the last tenant admin cannot be demoted, in the service's words", async () => {
    server.use(
      contractHandler("listMembers", () => reply(200, { items: [member({ userId: USER_ID, role: "tenant-admin" })], nextCursor: null })),
      contractHandler("changeMemberRole", () => reply(409, problem(409, "Last tenant admin", { code: "last_tenant_admin", detail: "A tenant needs at least one tenant admin." }))),
    );
    renderApp({ user: tenantAdminOidc(), path: "/admin/members" });
    const user = typing();
    await user.selectOptions(await screen.findByLabelText(`New role of ${USER_ID}`), "trader");
    await user.click(screen.getByRole("button", { name: `Change the role of ${USER_ID}` }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The role could not be changed");
    expect(alert).toHaveTextContent("Last tenant admin");
    expect(alert).toHaveTextContent("A tenant needs at least one tenant admin.");
    expect(screen.getByLabelText(`New role of ${USER_ID}`)).toHaveValue("tenant-admin");
  });

  it.each([
    [400, "Bad role"],
    [403, "Forbidden"],
    [404, "Member not found"],
  ])("shows the answer %i for a role change", async (status, title) => {
    server.use(
      contractHandler("listMembers", () => reply(200, { items: [member()], nextCursor: null })),
      contractHandler("changeMemberRole", () => reply(status, problem(status, title))),
    );
    renderApp({ user: tenantAdminOidc(), path: "/admin/members" });
    const user = typing();
    await user.selectOptions(await screen.findByLabelText("New role of member-1"), "tenant-admin");
    await user.click(screen.getByRole("button", { name: "Change the role of member-1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(title);
  });

  it("shows a 503 with its wait for a role change", async () => {
    server.use(
      contractHandler("listMembers", () => reply(200, { items: [member()], nextCursor: null })),
      contractHandler("changeMemberRole", () => unavailable("identity_provider_unavailable", 6)),
    );
    renderApp({ user: tenantAdminOidc(), path: "/admin/members" });
    const user = typing();
    await user.selectOptions(await screen.findByLabelText("New role of member-1"), "tenant-admin");
    await user.click(screen.getByRole("button", { name: "Change the role of member-1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 6 seconds.");
  });

  it("says when the list cannot be loaded and when it is empty", async () => {
    let answer: "forbidden" | "empty" = "forbidden";
    server.use(contractHandler("listMembers", () => (answer === "forbidden" ? reply(403, problem(403, "Forbidden")) : reply(200, { items: [], nextCursor: null }))));
    renderApp({ user: tenantAdminOidc(), path: "/admin/members" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The members could not be loaded");
    answer = "empty";
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("The tenant has no members.")).toBeInTheDocument();
  });

  it("is not shown to a role that may not open it", async () => {
    renderApp({ user: platformAdminOidc(), path: "/admin/members" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });
});
