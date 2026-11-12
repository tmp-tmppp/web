import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, typesOf } from "../src/api/audit";
import { filtersFromForm } from "../src/pages/audit/AuditFilterForm";
import { contractHandler, problem, reply, unauthorized, unavailable } from "./support/contract";
import { entry, platformAdminOidc, tenantAdminOidc, traderOidc } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const typing = () => userEvent.setup({ delay: null });
const open = () => renderApp({ user: tenantAdminOidc(), path: "/audit" });

describe("audit log: the list", () => {
  it("lists the entries newest first, with the details of an entry one click away", async () => {
    server.use(
      contractHandler("listAuditEntries", ({ query }) => {
        expect([...query.keys()]).toEqual([]);
        return reply(200, { items: [entry({ seq: 2, payload: { amount: 1250 } }), entry({ seq: 1, eventType: "si.chance.tenants.TenantCreated.v1", actor: null, correlationId: null, subject: "t-1" })], nextCursor: null });
      }),
    );
    open();
    const table = await screen.findByRole("table", { name: "Audit entries, newest first" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByRole("rowheader")).toHaveTextContent("2");
    expect(within(rows[2] as HTMLElement).getByRole("rowheader")).toHaveTextContent("1");
    expect(within(rows[1] as HTMLElement).getByText("si.chance.payments.DepositSucceeded.v1")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getAllByText("-")).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText(/"amount": 1250/)).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Details", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /older entries/ })).not.toBeInTheDocument();
  });

  it("loads older entries with the cursor and keeps the newer ones", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      contractHandler("listAuditEntries", ({ query }) => {
        cursors.push(query.get("cursor"));
        return query.get("cursor") === "older-1" ? reply(200, { items: [entry({ seq: 1, payload: null })], nextCursor: null }) : reply(200, { items: [entry({ seq: 2 })], nextCursor: "older-1" });
      }),
    );
    open();
    await typing().click(await screen.findByRole("button", { name: "Load older entries" }));
    const table = screen.getByRole("table");
    expect(await within(table).findByRole("rowheader", { name: "1" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "2" })).toBeInTheDocument();
    expect(cursors).toEqual([null, "older-1"]);
    expect(screen.queryByRole("button", { name: "Load older entries" })).not.toBeInTheDocument();
  });

  it("says when no entry matches", async () => {
    server.use(contractHandler("listAuditEntries", () => reply(200, { items: [], nextCursor: null })));
    open();
    expect(await screen.findByText("No entries match.")).toBeInTheDocument();
  });

  it("sends every filter that is filled in, together", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      contractHandler("listAuditEntries", ({ query }) => {
        queries.push(query);
        return reply(200, { items: [], nextCursor: null });
      }),
    );
    open();
    const user = typing();
    await user.type(await screen.findByLabelText("Event types"), "a.b.v1, c.d.v1");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01T08:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-02T09:30" } });
    await user.type(screen.getByLabelText("Correlation id"), "corr-9");
    await user.type(screen.getByLabelText("Actor"), "user-7");
    await user.type(screen.getByLabelText("Subject"), "market-3");
    await user.click(screen.getByRole("button", { name: "Apply the filters" }));
    await screen.findByText("No entries match.");
    expect(queries).toHaveLength(2);
    const sent = queries[1] as URLSearchParams;
    expect(sent.get("type")).toBe("a.b.v1,c.d.v1");
    expect(sent.get("from")).toBe(new Date("2026-11-01T08:00").toISOString());
    expect(sent.get("to")).toBe(new Date("2026-11-02T09:30").toISOString());
    expect(sent.get("correlationId")).toBe("corr-9");
    expect(sent.get("actor")).toBe("user-7");
    expect(sent.get("subject")).toBe("market-3");

    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await screen.findByText("No entries match.");
    expect(queries).toHaveLength(3);
    expect([...(queries[2] as URLSearchParams).keys()]).toEqual([]);
    expect(screen.getByLabelText("Event types")).toHaveValue("");
  });

  it("starts the list again when the same filters are applied again", async () => {
    let reads = 0;
    server.use(
      contractHandler("listAuditEntries", () => {
        reads += 1;
        return reply(200, { items: [], nextCursor: null });
      }),
    );
    open();
    await screen.findByText("No entries match.");
    await typing().click(screen.getByRole("button", { name: "Apply the filters" }));
    await screen.findByText("No entries match.");
    expect(reads).toBe(2);
  });

  it("checks the filters before a request", async () => {
    server.use(contractHandler("listAuditEntries", () => reply(200, { items: [], nextCursor: null })));
    open();
    const user = typing();
    fireEvent.change(await screen.findByLabelText("From"), { target: { value: "2026-11-05T10:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-01T10:00" } });
    await user.type(screen.getByLabelText("Event types"), Array.from({ length: 21 }, (_, index) => `t${index}`).join(","));
    await user.click(screen.getByRole("button", { name: "Apply the filters" }));
    expect(screen.getByText("The end must not be before the start.")).toBeInTheDocument();
    expect(screen.getByText("Give at most 20 event types.")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toHaveAttribute("aria-invalid", "true");
  });

  it("turns a filter form into the filters of a request", () => {
    expect(filtersFromForm(EMPTY_FILTERS)).toEqual({ filters: EMPTY_FILTERS, errors: {} });
    expect(filtersFromForm({ ...EMPTY_FILTERS, from: "garbage", to: "also garbage" }).errors).toEqual({ from: "Enter a valid date and time.", to: "Enter a valid date and time." });
    expect(typesOf(" a , b\tc,, ")).toEqual(["a", "b", "c"]);
  });

  it("shows the answers of the service when the list cannot be read", async () => {
    server.use(contractHandler("listAuditEntries", () => reply(400, problem(400, "Invalid filter", { errors: [{ field: "actor", message: "is too long" }] }))));
    open();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The audit log could not be loaded");
    expect(alert).toHaveTextContent("actor: is too long");
  });

  it.each([
    [403, "Forbidden"],
    [503, "Service unavailable"],
  ])("shows %i and loads the log on a second try", async (status, title) => {
    let fail = true;
    server.use(
      contractHandler("listAuditEntries", () => {
        if (!fail) return reply(200, { items: [entry()], nextCursor: null });
        return status === 503 ? unavailable("tenant_not_ready", 12) : reply(status, problem(status, title));
      }),
    );
    open();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(title);
    if (status === 503) expect(alert).toHaveTextContent("Try again in about 12 seconds.");
    fail = false;
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("ends the session on a 401", async () => {
    server.use(contractHandler("listAuditEntries", () => unauthorized()));
    open();
    expect(await screen.findByText(/Your session has ended/)).toBeInTheDocument();
  });

  it("is not shown to a trader or a platform admin", async () => {
    renderApp({ user: traderOidc(), path: "/audit" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });

  it("is not shown to a platform admin", async () => {
    renderApp({ user: platformAdminOidc(), path: "/audit" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });
});

describe("audit log: verify", () => {
  const empty = () => contractHandler("listAuditEntries", () => reply(200, { items: [], nextCursor: null }));

  it("says that the chain is valid and how many entries were checked", async () => {
    server.use(empty(), contractHandler("verifyAuditChain", () => reply(200, { valid: true, entries: 12, brokenAtSeq: null })));
    open();
    await typing().click(await screen.findByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Valid: the chain is intact. 12 entries were checked.")).toBeInTheDocument();
  });

  it("uses the singular for one entry", async () => {
    server.use(empty(), contractHandler("verifyAuditChain", () => reply(200, { valid: true, entries: 1, brokenAtSeq: null })));
    open();
    await typing().click(await screen.findByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Valid: the chain is intact. 1 entry was checked.")).toBeInTheDocument();
  });

  it("names the first broken entry", async () => {
    server.use(empty(), contractHandler("verifyAuditChain", () => reply(200, { valid: false, entries: 30, brokenAtSeq: 7 })));
    open();
    await typing().click(await screen.findByRole("button", { name: "Verify" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The log is broken.");
    expect(alert).toHaveTextContent("The first wrong entry is number 7.");
    expect(alert).toHaveTextContent("30 entries were checked.");
  });

  it("shows 503 verify_busy with its wait, and a result after a second try", async () => {
    let busy = true;
    server.use(empty(), contractHandler("verifyAuditChain", () => (busy ? unavailable("verify_busy", 9) : reply(200, { valid: true, entries: 0, brokenAtSeq: null }))));
    open();
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Verify" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The log could not be verified");
    expect(alert).toHaveTextContent("Try again in about 9 seconds.");
    busy = false;
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/Valid: the chain is intact\. 0 entries were checked\./)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a 403", async () => {
    server.use(empty(), contractHandler("verifyAuditChain", () => reply(403, problem(403, "Forbidden", { detail: "Tenant admins only." }))));
    open();
    await typing().click(await screen.findByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tenant admins only.");
  });
});
