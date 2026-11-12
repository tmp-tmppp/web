import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { OVERVIEW_PAGE_SIZE, OVERVIEW_WINDOWS } from "../src/api/market-data-graphql";
import { problem, reply, unavailable } from "./support/contract";
import { bucket, MARKET_2, MARKET_3, MARKET_ID, newcomerOidc, platformAdminOidc, quietHandlers, tenantAdminOidc, traderOidc } from "./support/fixtures";
import { fieldError, GRAPHQL_URL, gqlHistory, gqlMarket, gqlPage, graphqlEndpoint } from "./support/graphql";
import type { Resolvers } from "./support/graphql";
import { renderApp } from "./support/render";
import { server } from "./support/server";

// The market overview (/market-data, requirement 17): one GraphQL endpoint answers a page of markets with their prices and
// then the histories of exactly those markets. The mock endpoint is built from contracts/market-data.graphql
// (tests/support/graphql.ts), so a document the schema does not accept, or one over the limits of the service, fails a test.

const typing = () => userEvent.setup({ delay: null });

const Q_OPEN = "Will the shared market open before Friday?";
const Q_CLOSED = "Will it rain on Sunday in Ljubljana?";
const Q_RESOLVED = "Will the new office open in March?";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const openMarket = () => gqlMarket();
const closedMarket = () => gqlMarket({ marketId: MARKET_2, question: Q_CLOSED, status: "closed", currentPriceYesMicro: 120_000, lastTradeAt: "2026-11-10T18:30:00Z" });
const resolvedMarket = () => gqlMarket({ marketId: MARKET_3, question: Q_RESOLVED, status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000, lastTradeAt: null });

const WINDOW = { from: "2026-11-10T10:00:00Z", to: "2026-11-11T10:00:00Z" };

// 0.50 before the window, then three buckets: the price ends at 0.55 after a high of 0.57 and a low of 0.48.
const openHistory = (previousCloseYesMicro: number | null = 500_000) =>
  gqlHistory({
    ...WINDOW,
    marketId: MARKET_ID,
    previousCloseYesMicro,
    buckets: [
      bucket({ start: "2026-11-11T07:00:00Z", openYesMicro: 500_000, highYesMicro: 520_000, lowYesMicro: 480_000, closeYesMicro: 520_000 }),
      bucket({ start: "2026-11-11T08:00:00Z", openYesMicro: 520_000, highYesMicro: 570_000, lowYesMicro: 520_000, closeYesMicro: 560_000 }),
      bucket({ start: "2026-11-11T09:00:00Z", openYesMicro: 560_000, highYesMicro: 560_000, lowYesMicro: 540_000, closeYesMicro: 550_000 }),
    ],
  });
const closedHistory = () =>
  gqlHistory({ ...WINDOW, marketId: MARKET_2, previousCloseYesMicro: 200_000, buckets: [bucket({ start: "2026-11-10T18:00:00Z", openYesMicro: 200_000, highYesMicro: 200_000, lowYesMicro: 100_000, closeYesMicro: 120_000 })] });
// A market that was not traded in the window and has nothing before it: no trend.
const emptyHistory = () => gqlHistory({ ...WINDOW, marketId: MARKET_3, previousCloseYesMicro: null, buckets: [] });

const historyOf = (marketId: string) => (marketId === MARKET_ID ? openHistory() : marketId === MARKET_2 ? closedHistory() : emptyHistory());

const ALT_OPEN = "YES price over the last 24 hours: from 0.50 to 0.55, lowest 0.48, highest 0.57.";
const ALT_CLOSED = "YES price over the last 24 hours: from 0.20 to 0.12, lowest 0.10, highest 0.20.";

const threeMarkets = (): Resolvers => ({
  markets: () => gqlPage([openMarket(), closedMarket(), resolvedMarket()]),
  history: (args) => historyOf(String(args["marketId"])),
});

const rowOf = (question: string): HTMLElement => screen.getByRole("link", { name: question }).closest("tr") as HTMLElement;
const cellsOf = (row: HTMLElement): string[] => within(row).getAllByRole("cell").map((cell) => cell.textContent ?? "");
const tableName = (phrase = "the last 24 hours") => `Overview of the markets with their price, its change and its trend over ${phrase}`;

/**
 * The start the page asked the history from: a bucket start (the service would round anything else down and stretch the
 * span beyond its label), not before now minus the window and less than one interval after it.
 */
function expectWindowStart(from: string, durationMs: number, intervalMs: number) {
  const start = Date.parse(from);
  expect(start % intervalMs).toBe(0);
  expect(start).toBeGreaterThanOrEqual(Date.now() - durationMs - 60_000);
  expect(start).toBeLessThan(Date.now() - durationMs + intervalMs);
}

/** The mock endpoint of a test, with the calls it saw. */
function serve(resolvers: Resolvers) {
  const endpoint = graphqlEndpoint(resolvers);
  server.use(endpoint.handler);
  return endpoint.calls;
}

beforeEach(() => server.use(...quietHandlers()));

describe("the market overview of a trader", () => {
  it("shows every market with its YES price, its change over the window, the last trade and a sparkline, from two GraphQL queries", async () => {
    const calls = serve(threeMarkets());
    renderApp({ user: traderOidc(), path: "/market-data" });

    expect(await screen.findByRole("table", { name: tableName() })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Market data", level: 1 })).toBeInTheDocument();
    expect(cellsOf(rowOf(Q_OPEN))).toEqual(["Open", "0.55", "+0.05", expect.any(String), ALT_OPEN]);
    expect(cellsOf(rowOf(Q_CLOSED))).toEqual(["Closed", "0.12", "-0.08", expect.any(String), ALT_CLOSED]);
    expect(cellsOf(rowOf(Q_RESOLVED))).toEqual(["Resolved: YES", "1.00", "No history", "No trade yet", "No history"]);
    expect(within(rowOf(Q_OPEN)).getByText((_, element) => element?.tagName === "TIME")).toHaveAttribute("datetime", "2026-11-11T10:00:00Z");
    expect(screen.getByRole("link", { name: Q_OPEN })).toHaveAttribute("href", `/markets/${MARKET_ID}`);
    expect(screen.getByRole("columnheader", { name: "Change, 24 hours" })).toBeInTheDocument();

    // The schema has no history inside a market: a page of markets, then one query with an aliased history per market of that page.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("query MarketOverview");
    expect(calls[0]?.variables).toEqual({ first: OVERVIEW_PAGE_SIZE, after: null });
    expect(calls[1]?.query).toContain("query MarketSparklines");
    // Every bucket of 24 hours and one spare (a browser clock behind the server's), from a bucket start inside the window.
    expect(calls[1]?.variables).toMatchObject({ interval: "ONE_HOUR", first: 26, id0: MARKET_ID, id1: MARKET_2, id2: MARKET_3 });
    expectWindowStart(String(calls[1]?.variables["from"]), DAY, HOUR);
    // No request names a tenant: the tenant comes from the token.
    expect(JSON.stringify(calls)).not.toMatch(/tenant/i);
  });

  it("draws the sparkline as an image with the text that says what it shows, and a path of its own", async () => {
    serve(threeMarkets());
    renderApp({ user: traderOidc(), path: "/market-data" });
    const image = await screen.findByRole("img", { name: ALT_OPEN });
    expect(image.querySelector("path")?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+( H[\d.]+ V[\d.]+)+$/);
    expect(screen.getByRole("img", { name: ALT_CLOSED })).toBeInTheDocument();
    // A market with no history has no picture and no text pretending to describe one.
    expect(within(screen.getByRole("table")).getAllByRole("img")).toHaveLength(2);
  });

  it("says a price that did not move did not move, and starts the change at the opening price of a market opened inside the window", async () => {
    serve({
      markets: () => gqlPage([openMarket()]),
      history: () =>
        gqlHistory({ ...WINDOW, marketId: MARKET_ID, previousCloseYesMicro: null, buckets: [bucket({ start: "2026-11-11T08:00:00Z", openYesMicro: 550_000, highYesMicro: 550_000, lowYesMicro: 550_000, closeYesMicro: 550_000 })] }),
    });
    renderApp({ user: traderOidc(), path: "/market-data" });
    await screen.findByRole("table");
    expect(cellsOf(rowOf(Q_OPEN)).slice(1, 3)).toEqual(["0.55", "0.00"]);
    expect(screen.getByRole("img", { name: "YES price over the last 24 hours: unchanged at 0.55." })).toBeInTheDocument();
  });

  it("leads from the question to the market page", async () => {
    serve(threeMarkets());
    renderApp({ user: traderOidc(), path: "/market-data" });
    await typing().click(await screen.findByRole("link", { name: Q_OPEN }));
    expect(await screen.findByRole("heading", { name: Q_OPEN, level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("table", { name: tableName() })).not.toBeInTheDocument());
  });

  it("says so when there is no market, and does not ask for histories then", async () => {
    const calls = serve({ markets: () => gqlPage([]) });
    renderApp({ user: traderOidc(), path: "/market-data" });
    expect(await screen.findByText("There are no markets yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });
});

describe("the window", () => {
  it("reads the history again in 4-hour buckets over 7 days and words the change and the text for it", async () => {
    const calls = serve({
      markets: () => gqlPage([openMarket()]),
      history: (args) => (args["interval"] === "FOUR_HOURS" ? openHistory(400_000) : openHistory()),
    });
    renderApp({ user: traderOidc(), path: "/market-data" });
    const user = typing();
    await screen.findByRole("table", { name: tableName() });
    expect(cellsOf(rowOf(Q_OPEN))[2]).toBe("+0.05");

    const select = screen.getByLabelText("Show the change over");
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(OVERVIEW_WINDOWS.map((entry) => entry.label));
    await user.selectOptions(select, "7 days");

    expect(await screen.findByRole("table", { name: tableName("the last 7 days") })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Change, 7 days" })).toBeInTheDocument();
    expect(cellsOf(rowOf(Q_OPEN))[2]).toBe("+0.15");
    expect(screen.getByRole("img", { name: "YES price over the last 7 days: from 0.40 to 0.55, lowest 0.40, highest 0.57." })).toBeInTheDocument();
    const [, , , second] = calls;
    expect(calls).toHaveLength(4);
    expect(second?.variables).toMatchObject({ interval: "FOUR_HOURS", first: 44, id0: MARKET_ID });
    expectWindowStart(String(second?.variables["from"]), 7 * DAY, 4 * HOUR);
  });
});

describe("the pages of markets", () => {
  const pages = (): Resolvers => ({
    markets: (args) => (args["after"] === "cursor-1" ? gqlPage([closedMarket()]) : gqlPage([openMarket()], "cursor-1")),
    history: (args) => historyOf(String(args["marketId"])),
  });

  it("loads the next page with the cursor of the service and the histories of that page only", async () => {
    const calls = serve(pages());
    renderApp({ user: traderOidc(), path: "/market-data" });
    await typing().click(await screen.findByRole("button", { name: "Load more markets" }));
    expect(await screen.findByRole("link", { name: Q_CLOSED })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: Q_OPEN })).toBeInTheDocument();
    // Per query: the cursor of a page of markets, the first id of the histories of that page.
    expect(calls.map((call) => ("id0" in call.variables ? call.variables["id0"] : call.variables["after"]))).toEqual([null, MARKET_ID, "cursor-1", MARKET_2]);
    expect(screen.queryByRole("button", { name: "Load more markets" })).not.toBeInTheDocument();
  });

  it("keeps the rows it has when the next page fails, and loads it on the second try", async () => {
    let failing = true;
    const calls = serve({
      markets: (args) => {
        if (args["after"] === "cursor-1" && failing) throw fieldError("internal_error", 500, "boom");
        return pages().markets?.(args);
      },
      history: (args) => historyOf(String(args["marketId"])),
    });
    renderApp({ user: traderOidc(), path: "/market-data" });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Load more markets" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load more markets");
    expect(screen.getByRole("link", { name: Q_OPEN })).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Load more markets" }));
    expect(await screen.findByRole("link", { name: Q_CLOSED })).toBeInTheDocument();
    // The first page and its histories, the failed second page, the second page again and its histories.
    expect(calls).toHaveLength(5);
  });
});

describe("a browser clock behind the server's", () => {
  it("still gets the newest bucket when the range spans one bucket more than the window: the page asks for a spare one", async () => {
    // 26 hourly buckets: what the service holds for a start the browser placed one interval early. Only the newest has the
    // high of 0.90. The mock pages like the service: at most `first` buckets, oldest first.
    const all = Array.from({ length: 26 }, (_, index) =>
      bucket({ start: new Date(Date.parse("2026-11-10T09:00:00Z") + index * HOUR).toISOString(), openYesMicro: 500_000, highYesMicro: index === 25 ? 900_000 : 500_000, lowYesMicro: 500_000, closeYesMicro: index === 25 ? 550_000 : 500_000 }),
    );
    serve({
      markets: () => gqlPage([openMarket()]),
      history: (args) => gqlHistory({ ...WINDOW, marketId: MARKET_ID, previousCloseYesMicro: 500_000, buckets: all.slice(0, Number(args["first"])) }),
    });
    renderApp({ user: traderOidc(), path: "/market-data" });
    expect(await screen.findByRole("img", { name: "YES price over the last 24 hours: from 0.50 to 0.55, lowest 0.50, highest 0.90." })).toBeInTheDocument();
  });
});

describe("a failure of the markets query", () => {
  // The error codes of a field (README "GraphQL"), as the service sends them in `errors` of a 200 answer, and what the
  // person reads: the code decides the words, the message of the service is never shown.
  it.each([
    ["not_found", 404, "Not found", "The market does not exist, belongs to another organization or is not listed yet."],
    ["updating", 409, "The price data is catching up", "Market data does not have the latest trade yet."],
    ["validation_failed", 400, "The request was not accepted", "Market data did not accept what the page asked for."],
    ["history_paused", 503, "The price history is paused", "Prices are current, but the history is switched off for a moment."],
    ["tenant_not_ready", 503, "The market data of your organization is not ready yet", "It is being set up."],
    ["internal_error", 500, "Something went wrong on the server", "Try again in a moment."],
    ["a_code_from_the_future", 500, "Something went wrong on the server", "Try again in a moment."],
  ])("words %s as the problem it is and offers to try again", async (code, status, title, detail) => {
    let calls = 0;
    serve({
      markets: () => {
        calls += 1;
        if (calls === 1) throw fieldError(code, status, "an internal sentence of the service", { retryAfterSeconds: 7 });
        return gqlPage([openMarket()]);
      },
      history: () => openHistory(),
    });
    renderApp({ user: traderOidc(), path: "/market-data" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The market overview could not be loaded");
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(detail);
    expect(alert).toHaveTextContent("Try again in about 7 seconds.");
    expect(alert).not.toHaveTextContent("an internal sentence of the service");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: Q_OPEN })).toBeInTheDocument();
  });

  // A refusal of the whole request, as the service sends it (src/web/graphql/errors.ts, src/web/auth.ts): an HTTP error
  // status, the GraphQL error shape instead of a problem body, Retry-After in the header. 401 is the session's (it ends it).
  it.each([
    ["forbidden", 403, "Not allowed", "Your role does not allow reading market data."],
    ["identity_provider_unavailable", 503, "Sign-in is not available right now", "Market data could not check your session."],
    ["bad_request", 400, "The request was not accepted", "Check what you asked for and try again."],
    ["graphql_validation_failed", 400, "This page and market data do not agree", "The page asked a question that market data does not accept."],
    ["complexity_limit_exceeded", 400, "This page and market data do not agree", "if it stays, tell the people who run the app."],
    ["depth_limit_exceeded", 400, "This page and market data do not agree", "The page asked a question that market data does not accept."],
    ["a_code_from_the_future", 503, "Something went wrong on the server", "Try again in a moment."],
  ])("words a refusal of the whole request with %s (HTTP %i) by its code and offers to try again", async (code, status, title, detail) => {
    let calls = 0;
    server.use(
      http.post(GRAPHQL_URL, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ errors: [{ message: "an internal sentence of the service", extensions: { code, status } }] }, { status, headers: { "Retry-After": "7" } })
          : HttpResponse.json({ data: { markets: gqlPage([openMarket()]) } });
      }),
    );
    renderApp({ user: traderOidc(), path: "/market-data" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The market overview could not be loaded");
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(detail);
    expect(alert).toHaveTextContent("Try again in about 7 seconds.");
    expect(alert).not.toHaveTextContent("an internal sentence of the service");
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: Q_OPEN })).toBeInTheDocument();
  });

  it("shows the invalid fields a validation error names", async () => {
    serve({ markets: () => { throw fieldError("validation_failed", 400, "x", { fields: [{ field: "first", message: "first must be at most 100" }] }); } });
    renderApp({ user: traderOidc(), path: "/market-data" });
    expect(await screen.findByRole("alert")).toHaveTextContent("first: first must be at most 100");
  });

  it("shows a refusal of the whole request (HTTP 503 with Retry-After, 403) as the problem it is", async () => {
    let calls = 0;
    server.use(
      http.post(GRAPHQL_URL, () => {
        calls += 1;
        return calls === 1 ? unavailable("market_data_unavailable") : reply(403, problem(403, "Forbidden", { code: "forbidden", detail: "Your role may not read markets." }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/market-data" });
    const user = typing();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The market overview could not be loaded");
    expect(alert).toHaveTextContent("Service unavailable");
    expect(alert).toHaveTextContent("Try again in about 7 seconds.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Forbidden"));
    expect(screen.getByRole("alert")).toHaveTextContent("Your role may not read markets.");
  });

  it("says the server cannot be reached when no answer comes", async () => {
    server.use(http.post(GRAPHQL_URL, () => HttpResponse.error()));
    renderApp({ user: traderOidc(), path: "/market-data" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The server cannot be reached");
  });

  it("does not show an answer it cannot read: a body that is no GraphQL answer, and a status the schema does not have", async () => {
    let calls = 0;
    server.use(
      http.post(GRAPHQL_URL, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ hello: "world" });
        return HttpResponse.json({ data: { markets: { items: [{ ...openMarket(), status: "PENDING" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }),
    );
    renderApp({ user: traderOidc(), path: "/market-data" });
    const user = typing();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server sent an answer the app cannot read");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The server sent an answer the app cannot read"));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("a failure of the history query", () => {
  it("keeps the prices and says the change and the trend are missing, in the words of the code (history_paused for every market)", async () => {
    serve({
      markets: () => gqlPage([openMarket(), closedMarket()]),
      history: () => {
        throw fieldError("history_paused", 503, "The history is paused", { retryAfterSeconds: 7 });
      },
    });
    renderApp({ user: traderOidc(), path: "/market-data" });
    expect(await screen.findByRole("table", { name: tableName() })).toBeInTheDocument();
    expect(cellsOf(rowOf(Q_OPEN))).toEqual(["Open", "0.55", "Unavailable", expect.any(String), "Unavailable"]);
    expect(cellsOf(rowOf(Q_CLOSED))).toEqual(["Closed", "0.12", "Unavailable", expect.any(String), "Unavailable"]);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("The price history is missing for 2 markets, so their change and trend cannot be shown. The prices are current.");
    expect(notice).toHaveTextContent("The price history is paused: Prices are current, but the history is switched off for a moment.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fails only the market whose history failed (not_found), and the others keep their trend", async () => {
    serve({
      markets: () => gqlPage([openMarket(), closedMarket()]),
      history: (args) => {
        if (args["marketId"] === MARKET_2) throw fieldError("not_found", 404, "Market not found");
        return openHistory();
      },
    });
    renderApp({ user: traderOidc(), path: "/market-data" });
    await screen.findByRole("table");
    expect(cellsOf(rowOf(Q_OPEN))[2]).toBe("+0.05");
    expect(cellsOf(rowOf(Q_CLOSED))[2]).toBe("Unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("The price history is missing for 1 market,");
  });

  it("keeps the prices when the whole history query fails (a gateway page), and shows the trends after 'Try again'", async () => {
    let failing = true;
    serve(threeMarkets());
    // Added after the mock endpoint, so it is asked first; it answers only the history query, and only while `failing`.
    server.use(
      http.post(GRAPHQL_URL, async ({ request }) => {
        const { query } = (await request.clone().json()) as { query: string };
        if (!failing || !query.includes("MarketSparklines")) return undefined;
        return new HttpResponse("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
      }),
    );
    renderApp({ user: traderOidc(), path: "/market-data" });
    expect(await screen.findByRole("table", { name: tableName() })).toBeInTheDocument();
    expect(cellsOf(rowOf(Q_OPEN)).slice(0, 3)).toEqual(["Open", "0.55", "Unavailable"]);
    expect(screen.getByRole("status")).toHaveTextContent("The service is not available: Try again in a moment.");
    failing = false;
    await typing().click(within(screen.getByRole("status")).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("img", { name: ALT_OPEN })).toBeInTheDocument();
    expect(cellsOf(rowOf(Q_OPEN))[2]).toBe("+0.05");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("who may open the market overview", () => {
  it.each([
    ["a trader", traderOidc],
    ["a tenant admin", tenantAdminOidc],
  ])("shows %s the same table, and the menu entry", async (_name, oidc) => {
    serve(threeMarkets());
    renderApp({ user: oidc(), path: "/market-data" });
    expect(await screen.findByRole("table", { name: tableName() })).toBeInTheDocument();
    expect(cellsOf(rowOf(Q_OPEN))[1]).toBe("0.55");
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Market data" })).toHaveAttribute("href", "/market-data");
  });

  it("shows a platform admin nothing of a tenant and sends no request for it", async () => {
    const calls = serve(threeMarkets());
    renderApp({ user: platformAdminOidc(), path: "/market-data" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
    expect(screen.getByText("This page is only for members of a tenant.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Market data" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("sends a user without a tenant to the join page and sends no request", async () => {
    const calls = serve(threeMarkets());
    renderApp({ user: newcomerOidc(), path: "/market-data" });
    expect(await screen.findByText("This page is only for members of a tenant.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "join your tenant with it" })).toHaveAttribute("href", "/join");
    expect(calls).toHaveLength(0);
  });
});
