import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { API_BASE, contractHandler, problem, reply, unavailable } from "./support/contract";
import { dataMarket, market, MARKET_2, MARKET_3, MARKET_ID, newcomerOidc, organization, platformAdminOidc, quietHandlers, tenantAdminOidc, traderOidc } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const typing = () => userEvent.setup({ delay: null });

const OPEN_QUESTION = "Will the shared market open before Friday?";
const CLOSED_QUESTION = "Will it rain on Sunday in Ljubljana?";
const DRAFT_QUESTION = "Will the new office open in March?";
const OPENING_QUESTION = "Will the summer sale beat last year?";

const page = (items: unknown[], nextCursor: string | null = null) => reply(200, { items, nextCursor });
const closedData = () => dataMarket({ marketId: MARKET_2, question: CLOSED_QUESTION, status: "closed", currentPriceYesMicro: 120_000, volumeMicro: 3_400_000 });
const draft = () => market({ id: MARKET_3, question: DRAFT_QUESTION, status: "draft", openedAt: null });
const opening = () => market({ id: MARKET_2, question: OPENING_QUESTION, status: "opening", openedAt: null });
const rowOf = (question: string): HTMLElement => screen.getByRole("link", { name: question }).closest("tr") as HTMLElement;
const cellsOf = (row: HTMLElement): string[] => within(row).getAllByRole("cell").map((cell) => cell.textContent ?? "");

beforeEach(() => server.use(...quietHandlers()));

describe("the market list of a trader", () => {
  it("shows the open, closed and resolved markets with their current YES price and what was traded", async () => {
    const queries: string[] = [];
    let marketsCalls = 0;
    server.use(
      contractHandler("market-data:listMarkets", ({ query }) => {
        queries.push(query.toString());
        return page([dataMarket(), closedData()]);
      }),
      contractHandler("listMarkets", () => {
        marketsCalls += 1;
        return page([]);
      }),
      contractHandler("listMyOrganizations", () => reply(200, { items: [organization()], nextCursor: null, identityPending: false })),
    );
    renderApp({ user: traderOidc(), path: "/markets" });

    expect(await screen.findByRole("table", { name: "List of markets" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Markets" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText("Acme Traders")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: OPEN_QUESTION })).toHaveAttribute("href", `/markets/${MARKET_ID}`);
    expect(cellsOf(rowOf(OPEN_QUESTION))).toEqual(["Open", expect.any(String), "0.55", "12.50 credits"]);
    expect(cellsOf(rowOf(CLOSED_QUESTION))).toEqual(["Closed", expect.any(String), "0.12", "3.40 credits"]);
    // A trader asks market-data once, with no filter; the markets service is not asked, and there is no form to make a market.
    expect(queries).toEqual([""]);
    expect(marketsCalls).toBe(0);
    expect(screen.queryByRole("button", { name: "Create a market" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Prices are not available/)).not.toBeInTheDocument();
  });

  it("shows the outcome of a resolved market beside its status", async () => {
    server.use(contractHandler("market-data:listMarkets", () => page([dataMarket({ status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000, resolvedAt: "2026-12-31T13:00:00Z" })])));
    renderApp({ user: traderOidc(), path: "/markets" });
    expect(await screen.findByRole("link", { name: OPEN_QUESTION })).toBeInTheDocument();
    expect(cellsOf(rowOf(OPEN_QUESTION))).toEqual(["Resolved: YES", expect.any(String), "1.00", "12.50 credits"]);
  });

  it("offers a trader only the statuses a trader may ask for, and asks market-data for the chosen one", async () => {
    const statuses: (string | null)[] = [];
    server.use(
      contractHandler("market-data:listMarkets", ({ query }) => {
        statuses.push(query.get("status"));
        return page(query.get("status") === "closed" ? [closedData()] : [dataMarket(), closedData()]);
      }),
    );
    renderApp({ user: traderOidc(), path: "/markets" });
    const user = typing();
    const filter = await screen.findByLabelText("Show");
    expect(within(filter).getAllByRole("option").map((option) => option.textContent)).toEqual(["All markets", "Open", "Closed", "Resolved"]);

    await user.selectOptions(filter, "Closed");
    expect(await screen.findByRole("table", { name: "List of closed markets" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: OPEN_QUESTION })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: CLOSED_QUESTION })).toBeInTheDocument();
    expect(statuses).toEqual([null, "closed"]);
  });

  it("says so when there is no market, and when there is none of the chosen status", async () => {
    server.use(contractHandler("market-data:listMarkets", () => page([])));
    renderApp({ user: traderOidc(), path: "/markets" });
    expect(await screen.findByText("There are no markets yet.")).toBeInTheDocument();
    await typing().selectOptions(screen.getByLabelText("Show"), "Open");
    expect(await screen.findByText("There are no open markets.")).toBeInTheDocument();
  });

  it("loads the next page with the cursor of the service", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      contractHandler("market-data:listMarkets", ({ query }) => {
        cursors.push(query.get("cursor"));
        return query.get("cursor") ? page([closedData()]) : page([dataMarket()], "eyJpZCI6IjEifQ");
      }),
    );
    renderApp({ user: traderOidc(), path: "/markets" });
    await typing().click(await screen.findByRole("button", { name: "Load more markets" }));
    expect(await screen.findByRole("link", { name: CLOSED_QUESTION })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: OPEN_QUESTION })).toBeInTheDocument();
    expect(cursors).toEqual([null, "eyJpZCI6IjEifQ"]);
    expect(screen.queryByRole("button", { name: "Load more markets" })).not.toBeInTheDocument();
  });

  it("shows the failure of the list with its problem title and tries again", async () => {
    let calls = 0;
    server.use(
      contractHandler("market-data:listMarkets", () => {
        calls += 1;
        return calls === 1 ? reply(403, problem(403, "Forbidden", { code: "forbidden", detail: "Your role may not read markets." })) : page([dataMarket()]);
      }),
      contractHandler("listMarkets", () => page([])),
    );
    renderApp({ user: traderOidc(), path: "/markets" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The markets could not be loaded");
    expect(alert).toHaveTextContent("Forbidden");
    expect(alert).toHaveTextContent("Your role may not read markets.");
    // A refusal is not an outage: the list does not fall back to the markets service.
    expect(screen.queryByText(/Prices are not available/)).not.toBeInTheDocument();
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: OPEN_QUESTION })).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});

describe("the market list when market-data is down", () => {
  const fromMarkets = () => [market({ question: OPEN_QUESTION }), market({ id: MARKET_2, question: CLOSED_QUESTION, status: "closed" })];

  it("falls back to the markets service, shows no prices and says why", async () => {
    server.use(
      contractHandler("market-data:listMarkets", () => unavailable("market_data_unavailable")),
      contractHandler("listMarkets", () => page(fromMarkets())),
    );
    renderApp({ user: traderOidc(), path: "/markets" });
    expect(await screen.findByText(/Prices are not available right now/)).toBeInTheDocument();
    expect(screen.getByText(/Trading is not affected/)).toBeInTheDocument();
    expect(cellsOf(rowOf(OPEN_QUESTION))).toEqual(["Open", expect.any(String), "Unavailable", "-"]);
    expect(cellsOf(rowOf(CLOSED_QUESTION))).toEqual(["Closed", expect.any(String), "Unavailable", "-"]);
    // Every market is still reachable, so the trader can trade without prices.
    expect(screen.getByRole("link", { name: OPEN_QUESTION })).toHaveAttribute("href", `/markets/${MARKET_ID}`);
  });

  it("falls back when market-data cannot be reached at all, and shows the prices again after 'Try again'", async () => {
    server.use(
      http.get(`${API_BASE}/v1/market-data/markets`, () => HttpResponse.error()),
      contractHandler("listMarkets", () => page(fromMarkets())),
    );
    renderApp({ user: traderOidc(), path: "/markets" });
    await screen.findByText(/Prices are not available right now/);

    server.use(contractHandler("market-data:listMarkets", () => page([dataMarket()])));
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("0.55")).toBeInTheDocument();
    expect(screen.queryByText(/Prices are not available/)).not.toBeInTheDocument();
  });

  it("keeps the next pages of the fallback on the markets service, not on market-data", async () => {
    const marketsCursors: (string | null)[] = [];
    let dataCalls = 0;
    server.use(
      contractHandler("market-data:listMarkets", () => {
        dataCalls += 1;
        return unavailable("market_data_unavailable");
      }),
      contractHandler("listMarkets", ({ query }) => {
        marketsCursors.push(query.get("cursor"));
        return query.get("cursor") ? page([market({ id: MARKET_2, question: CLOSED_QUESTION, status: "closed" })]) : page([market({ question: OPEN_QUESTION })], "bWFya2V0cw");
      }),
    );
    renderApp({ user: traderOidc(), path: "/markets" });
    await typing().click(await screen.findByRole("button", { name: "Load more markets" }));
    expect(await screen.findByRole("link", { name: CLOSED_QUESTION })).toBeInTheDocument();
    expect(marketsCursors).toEqual([null, "bWFya2V0cw"]);
    expect(dataCalls).toBe(1);
  });

  it("asks the markets service for the chosen status", async () => {
    const statuses: (string | null)[] = [];
    server.use(
      contractHandler("market-data:listMarkets", () => unavailable("market_data_unavailable")),
      contractHandler("listMarkets", ({ query }) => {
        statuses.push(query.get("status"));
        return page([market({ id: MARKET_2, question: CLOSED_QUESTION, status: "closed" })]);
      }),
    );
    renderApp({ user: traderOidc(), path: "/markets" });
    await screen.findByText(/Prices are not available right now/);
    await typing().selectOptions(screen.getByLabelText("Show"), "Closed");
    await waitFor(() => expect(statuses).toEqual([null, "closed"]));
    expect(await screen.findByRole("table", { name: "List of closed markets" })).toBeInTheDocument();
  });
});

describe("the market list of a tenant admin", () => {
  const adminLists = (statuses: (string | null)[] = [], drafts = [draft()], opens = [opening()]) =>
    contractHandler("listMarkets", ({ query }) => {
      const status = query.get("status");
      statuses.push(status);
      return page(status === "draft" ? drafts : status === "opening" ? opens : []);
    });

  it("also shows the drafts and the markets being opened, which only the markets service has", async () => {
    const statuses: (string | null)[] = [];
    server.use(adminLists(statuses), contractHandler("market-data:listMarkets", () => page([dataMarket()])));
    renderApp({ user: tenantAdminOidc(), path: "/markets" });

    expect(await screen.findByRole("heading", { name: "Drafts" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Being opened" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Open, closed and resolved" })).toBeInTheDocument();
    expect(cellsOf(rowOf(DRAFT_QUESTION))).toEqual(["Draft", expect.any(String), "Not open yet", "-"]);
    expect(cellsOf(rowOf(OPENING_QUESTION))).toEqual(["Opening", expect.any(String), "Not open yet", "-"]);
    expect(cellsOf(rowOf(OPEN_QUESTION))).toEqual(["Open", expect.any(String), "0.55", "12.50 credits"]);
    expect([...statuses].sort()).toEqual(["draft", "opening"]);
    expect(screen.getByRole("button", { name: "Create a market" })).toBeInTheDocument();
  });

  it("shows no heading for a kind of market the admin has none of", async () => {
    server.use(adminLists([], [], []), contractHandler("market-data:listMarkets", () => page([dataMarket()])));
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    expect(await screen.findByRole("heading", { name: "Open, closed and resolved" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Drafts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Being opened" })).not.toBeInTheDocument();
  });

  it("filters by draft and by opening, with a sentence for an empty list", async () => {
    const statuses: (string | null)[] = [];
    server.use(adminLists(statuses, [draft()], []), contractHandler("market-data:listMarkets", () => page([dataMarket()])));
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    const filter = await screen.findByLabelText("Show");
    expect(within(filter).getAllByRole("option").map((option) => option.textContent)).toEqual(["All markets", "Draft", "Opening", "Open", "Closed", "Resolved"]);

    await user.selectOptions(filter, "Draft");
    expect(await screen.findByRole("table", { name: "List of drafts" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: DRAFT_QUESTION })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: OPEN_QUESTION })).not.toBeInTheDocument();

    await user.selectOptions(filter, "Opening");
    expect(await screen.findByText("No market is being opened.")).toBeInTheDocument();
    expect(statuses.at(-1)).toBe("opening");
  });

  it("says there are no drafts when the filter asks for them and there are none", async () => {
    server.use(adminLists([], [], []), contractHandler("market-data:listMarkets", () => page([])));
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    await typing().selectOptions(await screen.findByLabelText("Show"), "Draft");
    expect(await screen.findByText("There are no drafts.")).toBeInTheDocument();
  });

  it("does not list a draft twice when market-data is down and the markets service stands in", async () => {
    server.use(
      contractHandler("market-data:listMarkets", () => unavailable("market_data_unavailable")),
      contractHandler("listMarkets", ({ query }) => {
        const status = query.get("status");
        if (status === "draft") return page([draft()]);
        if (status === "opening") return page([]);
        return page([draft(), market({ question: OPEN_QUESTION })]);
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    expect(await screen.findByText(/Prices are not available right now/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: DRAFT_QUESTION })).toHaveLength(1);
    expect(cellsOf(rowOf(OPEN_QUESTION))).toEqual(["Open", expect.any(String), "Unavailable", "-"]);
  });
});

describe("who may open the market list", () => {
  it("shows a platform admin nothing of a tenant and sends no request for it", async () => {
    let calls = 0;
    const counted = () => {
      calls += 1;
      return page([]);
    };
    server.use(contractHandler("market-data:listMarkets", counted), contractHandler("listMarkets", counted), contractHandler("listTenants", () => page([])));
    renderApp({ user: platformAdminOidc(), path: "/markets" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
    expect(screen.getByText("This page is only for members of a tenant.")).toBeInTheDocument();
    // A platform admin has no tenant to join, so there is no link to the join page either.
    expect(screen.queryByRole("link", { name: "join your tenant with it" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Markets" })).not.toBeInTheDocument();
    expect(calls).toBe(0);
  });

  it("sends a user without a tenant to the join page", async () => {
    renderApp({ user: newcomerOidc(), path: "/markets" });
    expect(await screen.findByText("This page is only for members of a tenant.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "join your tenant with it" })).toHaveAttribute("href", "/join");
  });
});

describe("the form that makes a market", () => {
  const closeText = (): string => {
    const date = new Date(Date.now() + 10 * 86_400_000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const QUESTION = "Will the new office open by March?";

  async function openForm(user: ReturnType<typeof typing>) {
    await user.click(await screen.findByRole("button", { name: "Create a market" }));
    return screen.getByRole("form", { name: "New market" });
  }

  async function fill(user: ReturnType<typeof typing>, values: { question?: string; description?: string; closeTime?: string; price?: string; funding?: string } = {}) {
    const all = { question: QUESTION, description: "Counts once the doors open.", closeTime: closeText(), price: "0,35", funding: "1000", ...values };
    await user.type(screen.getByLabelText("Question"), all.question);
    if (all.description) await user.type(screen.getByLabelText("Description (optional)"), all.description);
    fireEvent.change(screen.getByLabelText("Closes at"), { target: { value: all.closeTime } });
    await user.type(screen.getByLabelText("Starting YES price"), all.price);
    await user.type(screen.getByLabelText("Funding, in credits"), all.funding);
  }

  const lists = (drafts: () => unknown[] = () => []) =>
    server.use(
      contractHandler("listMarkets", ({ query }) => page(query.get("status") === "draft" ? drafts() : [])),
      contractHandler("market-data:listMarkets", () => page([])),
    );

  it("opens and closes, and names the fields that are wrong in words before anything is sent", async () => {
    lists();
    let sent = 0;
    server.use(
      contractHandler("createMarket", () => {
        sent += 1;
        return reply(201, draft());
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    const toggle = await screen.findByRole("button", { name: "Create a market" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await openForm(user);
    expect(screen.getByRole("button", { name: "Hide the form" })).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: "Create the draft" }));
    expect(screen.getByText("Write the question in 10 to 200 characters.")).toBeInTheDocument();
    expect(screen.getByText("Choose the date and time when the market closes.")).toBeInTheDocument();
    expect(screen.getByText(/Enter a price from 0\.01 to 0\.99/)).toBeInTheDocument();
    expect(screen.getByText("Enter a whole number of credits, at least 1.")).toBeInTheDocument();
    expect(screen.getByLabelText("Question")).toBeInvalid();
    expect(screen.getByLabelText("Question")).toHaveAccessibleDescription(expect.stringContaining("Write the question in 10 to 200 characters."));
    expect(sent).toBe(0);

    await user.click(screen.getByRole("button", { name: "Hide the form" }));
    expect(screen.queryByRole("form", { name: "New market" })).not.toBeInTheDocument();
  });

  it("refuses a close time in the past, a price off the 0.01 grid and funding that is not a whole number", async () => {
    lists();
    let sent = 0;
    server.use(
      contractHandler("createMarket", () => {
        sent += 1;
        return reply(201, draft());
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    await openForm(user);
    await fill(user, { closeTime: "2020-01-01T10:00", price: "0.355", funding: "12.5" });
    await user.click(screen.getByRole("button", { name: "Create the draft" }));
    expect(screen.getByText("The close time must be in the future.")).toBeInTheDocument();
    expect(screen.getByText(/Enter a price from 0\.01 to 0\.99/)).toBeInTheDocument();
    expect(screen.getByText("Enter a whole number of credits, at least 1.")).toBeInTheDocument();

    for (const bad of ["1.5", "0.00", "abc"]) {
      await user.clear(screen.getByLabelText("Starting YES price"));
      await user.type(screen.getByLabelText("Starting YES price"), bad);
      await user.click(screen.getByRole("button", { name: "Create the draft" }));
      expect(screen.getByLabelText("Starting YES price")).toBeInvalid();
    }
    expect(sent).toBe(0);
  });

  it("shows the funding in credits and euros while it is typed", async () => {
    lists();
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    await openForm(user);
    await user.type(screen.getByLabelText("Funding, in credits"), "1250");
    expect(screen.getByText(/That is 1,250 credits \(EUR 12\.50\), taken from your balance/)).toBeInTheDocument();
  });

  it("creates a draft with the price as a number with two decimals, then reads the lists again and links to the market", async () => {
    let draftsShown = 0;
    lists(() => {
      draftsShown += 1;
      return draftsShown === 1 ? [] : [draft()];
    });
    let body: Record<string, unknown> | undefined;
    server.use(
      contractHandler("createMarket", ({ body: sent }) => {
        body = sent;
        return reply(201, market({ id: MARKET_3, question: QUESTION, status: "draft", fundingAmount: 1000 }), { headers: { Location: `/v1/markets/${MARKET_3}` } });
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    await openForm(user);
    const closes = closeText();
    await fill(user, { closeTime: closes });
    await user.click(screen.getByRole("button", { name: "Create the draft" }));

    expect(await screen.findByText(/The draft was created\./)).toBeInTheDocument();
    expect(body).toEqual({ question: QUESTION, description: "Counts once the doors open.", closeTime: new Date(closes).toISOString(), startingPrice: 0.35, fundingAmount: 1000 });
    expect(screen.getByRole("link", { name: "Go to the market" })).toHaveAttribute("href", `/markets/${MARKET_3}`);
    expect(screen.getByText(/opening takes 1,000 credits \(EUR 10\.00\) from your balance/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New market" })).not.toBeInTheDocument();
    // The drafts were read again: the new one is in the list.
    expect(await screen.findByRole("heading", { name: "Drafts" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: DRAFT_QUESTION })).toBeInTheDocument();
    expect(draftsShown).toBe(2);
  });

  it("sends the sharing policy only when it differs from the default", async () => {
    lists();
    let body: Record<string, unknown> | undefined;
    server.use(
      contractHandler("createMarket", ({ body: sent }) => {
        body = sent;
        return reply(201, draft(), { headers: { Location: `/v1/markets/${MARKET_3}` } });
      }),
    );
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    await openForm(user);
    await fill(user, { description: "" });
    await user.selectOptions(screen.getByLabelText("Who may make share links"), "Tenant admins only");
    await user.click(screen.getByRole("checkbox", { name: /Members of this organization/ }));
    await user.click(screen.getByRole("checkbox", { name: /Everyone who has the link/ }));
    await user.click(screen.getByRole("checkbox", { name: /Chosen profiles/ }));
    await user.click(screen.getByRole("button", { name: "Create the draft" }));

    expect(await screen.findByText(/The draft was created\./)).toBeInTheDocument();
    expect(body?.["sharing"]).toEqual({ whoMayShare: "admins", linkTypes: ["profiles", "everyone"] });
    expect(body).not.toHaveProperty("description");
  });

  it("puts the service's field errors under their fields and keeps what was typed", async () => {
    lists();
    server.use(
      contractHandler("createMarket", () =>
        reply(
          400,
          problem(400, "Invalid request", {
            code: "validation_failed",
            detail: "Two fields are not valid.",
            errors: [
              { field: "startingPrice", message: "must be at most 0.99" },
              { field: "body.closeTime", message: "must be later than now plus 5 minutes" },
              { field: "sharing/linkTypes", message: "must not repeat a kind" },
            ],
          }),
        ),
      ),
    );
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    await openForm(user);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create the draft" }));

    expect(await screen.findByText("must be at most 0.99")).toBeInTheDocument();
    expect(screen.getByLabelText("Starting YES price")).toBeInvalid();
    expect(screen.getByLabelText("Starting YES price")).toHaveAccessibleDescription(expect.stringContaining("must be at most 0.99"));
    expect(screen.getByText("must be later than now plus 5 minutes")).toBeInTheDocument();
    const alerts = screen.getAllByRole("alert");
    const summary = alerts.find((alert) => alert.textContent?.includes("The market was not created"));
    expect(summary).toHaveTextContent("Invalid request");
    expect(summary).toHaveTextContent("Two fields are not valid.");
    // A field the form shows by itself is not repeated in the summary; one it does not show is.
    expect(summary).toHaveTextContent("sharing/linkTypes: must not repeat a kind");
    expect(summary).not.toHaveTextContent("startingPrice:");
    expect(screen.getByLabelText("Question")).toHaveValue(QUESTION);
    expect(screen.getByLabelText("Funding, in credits")).toHaveValue("1000");
  });

  it.each([
    ["a refusal", () => reply(403, problem(403, "Forbidden", { code: "forbidden", detail: "Only tenant admins make markets." })), "Only tenant admins make markets."],
    ["an outage with a wait", () => unavailable("markets_unavailable", 7), "Try again in about 7 seconds."],
  ])("shows %s as the problem it is, without a stack", async (_name, answer, text) => {
    lists();
    server.use(contractHandler("createMarket", answer));
    renderApp({ user: tenantAdminOidc(), path: "/markets" });
    const user = typing();
    await openForm(user);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create the draft" }));
    const alert = await screen.findByText("The market was not created");
    expect(alert.closest("[role=alert]")).toHaveTextContent(text);
    expect(screen.queryByText(/The draft was created/)).not.toBeInTheDocument();
    // The button is usable again: the form is not stuck busy.
    await waitFor(() => expect(screen.getByRole("button", { name: "Create the draft" })).toBeEnabled());
  });
});
