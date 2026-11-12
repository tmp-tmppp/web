import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailProblem, parseEmails } from "../src/lib/emails";
import { contractHandler, problem, reply } from "./support/contract";
import { createdShareLink, market, MARKET_ID, quietHandlers, SHARE_LINK_ID, SHARE_TOKEN, shareLink, sharing, tenantAdminOidc, traderOidc } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const typing = () => userEvent.setup({ delay: null });
const path = `/markets/${MARKET_ID}`;
const allTypes = sharing({ whoMayShare: "members", linkTypes: ["members", "profiles", "everyone"] });
const made = (overrides: Parameters<typeof createdShareLink>[0] = {}) =>
  reply(201, createdShareLink(overrides), { headers: { Location: `/v1/markets/${MARKET_ID}/share-links/${SHARE_LINK_ID}` } });
const urlOfLink = () => `${window.location.origin}/share#${SHARE_TOKEN}`;

beforeEach(() => server.use(...quietHandlers()));
afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(document, "execCommand");
});

const marketIs = (overrides: Record<string, unknown>) => server.use(contractHandler("getMarket", () => reply(200, market(overrides))));

describe("parseEmails", () => {
  it("splits on commas, spaces, semicolons and lines, lower-cases and drops repeats", () => {
    expect(parseEmails("Ana@Example.test, ben@example.test;\nana@example.test  cy@example.test")).toEqual({
      emails: ["ana@example.test", "ben@example.test", "cy@example.test"],
      invalid: [],
    });
  });

  it("separates what is no address and explains the problem", () => {
    const parsed = parseEmails("ana@example.test nope @x.test a@b");
    expect(parsed.invalid).toEqual(["nope", "@x.test", "a@b"]);
    expect(emailProblem(parsed)).toContain("nope, @x.test, a@b");
    expect(emailProblem(parseEmails(""))).toBe("Enter at least one e-mail address.");
    expect(emailProblem({ emails: Array.from({ length: 51 }, (_, index) => `u${index}@example.test`), invalid: [] })).toContain("at most 50");
    expect(emailProblem(parseEmails("ana@example.test"))).toBeNull();
  });
});

describe("the share dialog on the market page", () => {
  it("offers only the link types the policy allows", async () => {
    marketIs({ sharing: sharing({ linkTypes: ["members", "everyone"] }) });
    renderApp({ user: traderOidc(), path });
    const group = await screen.findByRole("group", { name: "Who may open the link" });
    expect(within(group).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["members", "everyone"]);
    expect(screen.queryByLabelText("E-mail addresses")).not.toBeInTheDocument();
  });

  it.each([
    [{ whoMayShare: "none", linkTypes: ["members"] }, "open", "turned sharing off"],
    [{ whoMayShare: "admins", linkTypes: ["members"] }, "open", "Only tenant admins may share"],
    [{ whoMayShare: "members", linkTypes: ["members"] }, "draft", "once it is open"],
  ])("offers a trader no link under %j, market %s", async (policy, status, text) => {
    marketIs({ sharing: policy, status });
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make the link" })).not.toBeInTheDocument();
  });

  it("offers a tenant admin the types of an admins-only policy", async () => {
    marketIs({ sharing: sharing({ whoMayShare: "admins", linkTypes: ["profiles"] }) });
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByLabelText("E-mail addresses")).toBeInTheDocument();
    // Sign-up verifies the address by mail, so the dialog no longer warns that nobody's address is verified.
    expect(screen.getByText(/A person counts once they have confirmed their address from the verification mail Chance sends them\./)).toBeInTheDocument();
    expect(screen.queryByText(/does not verify addresses/)).not.toBeInTheDocument();
  });

  it("checks the addresses of a profiles link, sends them normalised with the expiry, and shows the link once", async () => {
    marketIs({ sharing: allTypes });
    let body: { type: string; emails?: string[]; expiresAt?: string } | undefined;
    let url = "";
    server.use(
      contractHandler("createShareLink", ({ body: sent, request }) => {
        body = sent;
        url = request.url;
        return made({ type: "profiles", emails: sent.emails });
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("radio", { name: /Chosen profiles/ }));
    await user.type(screen.getByLabelText("E-mail addresses"), "nope");
    await user.click(screen.getByRole("button", { name: "Make the link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("These are not e-mail addresses: nope.");
    expect(body).toBeUndefined();

    await user.clear(screen.getByLabelText("E-mail addresses"));
    await user.type(screen.getByLabelText("E-mail addresses"), "ANA@Example.test, ben@example.test ana@example.test");
    await user.selectOptions(screen.getByLabelText("The link ends"), "7 days");
    const before = Date.now();
    await user.click(screen.getByRole("button", { name: "Make the link" }));

    expect(await screen.findByTestId("share-url")).toHaveValue(urlOfLink());
    expect(body?.type).toBe("profiles");
    expect(body?.emails).toEqual(["ana@example.test", "ben@example.test"]);
    expect(Date.parse(body?.expiresAt ?? "") - before).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(Date.parse(body?.expiresAt ?? "") - before).toBeLessThan(7 * 86_400_000 + 60_000);
    expect(url).not.toContain(SHARE_TOKEN);
    expect(screen.getByText(/It is shown only once/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByTestId("share-url")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SHARE_TOKEN);
  });

  it("makes a link without addresses and without an expiry when the type needs none", async () => {
    marketIs({ sharing: allTypes });
    let body: unknown;
    server.use(
      contractHandler("createShareLink", ({ body: sent }) => {
        body = sent;
        return made();
      }),
    );
    renderApp({ user: traderOidc(), path });
    await userEvent.setup({ delay: null }).click(await screen.findByRole("button", { name: "Make the link" }));
    await screen.findByTestId("share-url");
    expect(body).toEqual({ type: "members" });
  });

  it("copies the link with the Clipboard API", async () => {
    marketIs({ sharing: allTypes });
    server.use(contractHandler("createShareLink", () => made()));
    renderApp({ user: traderOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Make the link" }));
    await user.click(await screen.findByRole("button", { name: "Copy the link" }));
    expect(await navigator.clipboard.readText()).toBe(urlOfLink());
    expect(screen.getByText("Copied to the clipboard.")).toBeInTheDocument();
  });

  it("falls back to selecting the text and the copy command, and says so when that fails too", async () => {
    marketIs({ sharing: allTypes });
    server.use(contractHandler("createShareLink", () => made()));
    renderApp({ user: traderOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Make the link" }));
    await screen.findByTestId("share-url");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const command = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: command, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy the link" }));
    expect(await screen.findByText("Copied to the clipboard.")).toBeInTheDocument();
    expect(command).toHaveBeenCalledWith("copy");

    command.mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Copy the link" }));
    expect(await screen.findByText(/did not allow copying/)).toBeInTheDocument();
  });

  it("offers the share sheet only where the browser has one", async () => {
    marketIs({ sharing: allTypes });
    server.use(contractHandler("createShareLink", () => made()));
    renderApp({ user: traderOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Make the link" }));
    await screen.findByTestId("share-url");
    expect(screen.queryByRole("button", { name: "Share..." })).not.toBeInTheDocument();
  });

  it("treats a closed share sheet as no failure", async () => {
    marketIs({ sharing: allTypes });
    server.use(contractHandler("createShareLink", () => made()));
    const share = vi.fn().mockRejectedValue(Object.assign(new Error("closed"), { name: "AbortError" }));
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    renderApp({ user: traderOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Make the link" }));
    await user.click(await screen.findByRole("button", { name: "Share..." }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/could not be opened/)).not.toBeInTheDocument();
  });

  it("opens the share sheet with the link", async () => {
    marketIs({ sharing: allTypes });
    server.use(contractHandler("createShareLink", () => made()));
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    renderApp({ user: traderOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Make the link" }));
    await user.click(await screen.findByRole("button", { name: "Share..." }));
    expect(share).toHaveBeenCalledWith({ title: "A market on Chance", url: urlOfLink() });
  });

  it("says when the share sheet cannot open", async () => {
    marketIs({ sharing: allTypes });
    server.use(contractHandler("createShareLink", () => made()));
    Object.defineProperty(navigator, "share", { value: vi.fn().mockRejectedValue(new Error("no")), configurable: true });
    renderApp({ user: traderOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Make the link" }));
    await user.click(await screen.findByRole("button", { name: "Share..." }));
    expect(await screen.findByText(/could not be opened/)).toBeInTheDocument();
  });

  it("shows a refusal of the service in its own words", async () => {
    marketIs({ sharing: allTypes });
    server.use(contractHandler("createShareLink", () => reply(409, problem(409, "The market cannot be shared", { code: "invalid_state", detail: "The market is not open." }))));
    renderApp({ user: traderOidc(), path });
    await typing().click(await screen.findByRole("button", { name: "Make the link" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The link could not be made");
    expect(alert).toHaveTextContent("The market is not open.");
    expect(screen.queryByTestId("share-url")).not.toBeInTheDocument();
  });

  it("lists the links without any token and revokes an active one", async () => {
    marketIs({ sharing: allTypes });
    let revoked = false;
    let revokedId = "";
    server.use(
      contractHandler("listShareLinks", () =>
        reply(200, {
          items: [
            shareLink({ status: revoked ? "revoked" : "active", revokedAt: revoked ? "2026-11-11T11:00:00Z" : null }),
            shareLink({ id: "0192f3a4-5b6c-7d8e-9f01-23456789ab01", type: "profiles", emails: ["ana@example.test"], status: "expired", expiresAt: "2026-11-01T10:00:00Z" }),
          ],
          nextCursor: null,
        }),
      ),
      contractHandler("revokeShareLink", ({ params }) => {
        revoked = true;
        revokedId = params["linkId"] ?? "";
        return reply(204);
      }),
    );
    renderApp({ user: traderOidc(), path });
    const table = await screen.findByRole("table", { name: "Share links of this market" });
    expect(within(table).getByText("ana@example.test")).toBeInTheDocument();
    expect(within(table).getByText("Expired")).toBeInTheDocument();
    expect(within(table).getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    await typing().click(within(table).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Share links of this market" })).getByText("Revoked")).toBeInTheDocument());
    expect(revokedId).toBe(SHARE_LINK_ID);
    expect(document.body.textContent).not.toContain(SHARE_TOKEN);
  });

  it("says so when there is no link yet", async () => {
    marketIs({ sharing: allTypes });
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText("No link has been made for this market yet.")).toBeInTheDocument();
  });

  it("shows no dialog when the market cannot be read: the page says so instead", async () => {
    server.use(contractHandler("getMarket", () => reply(404, problem(404, "Market not found", { code: "not_found" }))));
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByRole("alert")).toHaveTextContent("The market could not be loaded");
    expect(screen.queryByRole("group", { name: "Who may open the link" })).not.toBeInTheDocument();
  });
});
