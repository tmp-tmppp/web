import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketStatus } from "../src/api/markets";
import { OPENING_POLL_MAX, OPENING_POLL_MS } from "../src/pages/markets/MarketPage";
import { useFakeClock } from "./support/clock";
import { contractHandler, problem, reply, unavailable } from "./support/contract";
import { bucket, dataMarket, history, market, MARKET_ID, NOW, portfolio, quietHandlers, tenantAdminOidc, traderOidc, USER_ID } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const typing = () => userEvent.setup({ delay: null });
const path = `/markets/${MARKET_ID}`;
const QUESTION = "Will the shared market open before Friday?";
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => server.use(...quietHandlers()));

const marketIs = (overrides: Record<string, unknown>) => server.use(contractHandler("getMarket", () => reply(200, market(overrides))));
const dataIs = (overrides: Parameters<typeof dataMarket>[0]) => server.use(contractHandler("market-data:getMarket", () => reply(200, dataMarket(overrides))));
const termValue = (scope: HTMLElement, term: string): string | null | undefined => within(scope).getByText(term, { selector: "dt" }).nextElementSibling?.textContent;
const price = () => screen.getByRole("region", { name: "Price" });
const confirmationOf = (question: string) => screen.getByRole("group", { name: question });

describe("the market page of a trader", () => {
  it("shows the question, the status and close time, the current price, the chart and the balance", async () => {
    server.use(
      contractHandler("market-data:getMarket", () => reply(200, dataMarket())),
      contractHandler("getPortfolio", () => reply(200, portfolio({ positions: [] }))),
    );
    renderApp({ user: traderOidc(), path });

    expect(await screen.findByRole("heading", { level: 1, name: QUESTION })).toBeInTheDocument();
    const article = screen.getByRole("article");
    expect(within(article).getByText("Open")).toBeInTheDocument();
    expect(within(article).getByText("Traders can buy and sell shares.")).toBeInTheDocument();
    expect(within(article).getByText("Closes")).toBeInTheDocument();
    expect(within(article).queryByText("Funding")).not.toBeInTheDocument();
    expect(within(article).queryByText("Outcome")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All markets" })).toHaveAttribute("href", "/markets");

    expect(await screen.findByRole("img", { name: "YES price over time" })).toHaveAccessibleDescription(/YES price from 0\.50 to 0\.55, lowest 0\.50, highest 0\.55, 2 points/);
    expect(termValue(price(), "YES price")).toBe("0.55");
    expect(termValue(price(), "NO price")).toBe("0.45");
    expect(termValue(price(), "Traded")).toBe("12.50 credits in 3 trades");

    // The balance and the position come from the portfolio of trading, in credits with two decimals.
    expect(await screen.findByText("90.00 credits")).toBeInTheDocument();
    expect(termValue(screen.getByRole("region", { name: "Trade" }), "YES shares you hold")).toBe("0.00");
    expect(screen.getByRole("heading", { name: "Buy shares" })).toBeInTheDocument();
    expect(screen.getByText("You hold no shares in this market yet, so there is nothing to sell.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Manage this market" })).not.toBeInTheDocument();
    // The share dialog is the one of the share feature.
    expect(await screen.findByRole("button", { name: "Make the link" })).toBeInTheDocument();
  });

  it("shows the numbers behind the chart in a table, and asks for another interval", async () => {
    const intervals: (string | null)[] = [];
    server.use(
      contractHandler("getMarketHistory", ({ query }) => {
        intervals.push(query.get("interval"));
        return reply(200, history({ interval: query.get("interval") === "1d" ? "1d" : "1h", buckets: [bucket(), bucket({ start: "2026-11-11T10:00:00Z", openYesMicro: 550_000, highYesMicro: 600_000, lowYesMicro: 540_000, closeYesMicro: 600_000, trades: 2 })] }));
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    await screen.findByRole("img", { name: "YES price over time" });
    await user.click(screen.getByText("Show the numbers"));
    const table = screen.getByRole("table", { name: "Price history in buckets of 1h" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[2] as HTMLElement).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["0.55", "0.60", "0.54", "0.60", "12.50 credits", "2"]);

    await user.selectOptions(screen.getByLabelText("Chart interval"), "1 day");
    expect(await screen.findByRole("table", { name: "Price history in buckets of 1d", hidden: true })).toBeInTheDocument();
    expect(intervals).toEqual(["1h", "1d"]);
  });

  it("says a trader cannot see a draft: the service answers 'not found'", async () => {
    server.use(contractHandler("getMarket", () => reply(404, problem(404, "Market not found", { code: "not_found", detail: "No market with this id." }))));
    renderApp({ user: traderOidc(), path });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The market could not be loaded");
    expect(alert).toHaveTextContent("Market not found");
    expect(screen.getByRole("link", { name: "Back to the markets" })).toHaveAttribute("href", "/markets");
    expect(screen.queryByRole("heading", { name: "Trade" })).not.toBeInTheDocument();
  });

  it("tries again after a failure to load the market, with the wait the service asked for", async () => {
    let reads = 0;
    server.use(contractHandler("getMarket", () => (reads++ === 0 ? unavailable("tenant_not_ready", 7) : reply(200, market()))));
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 7 seconds.");
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: QUESTION })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the chart as not ready when market-data does not know the market yet, and as unavailable when it is down", async () => {
    server.use(contractHandler("market-data:getMarket", () => reply(404, problem(404, "Market not found", { code: "not_found" }))));
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText("The price data of this market is not ready yet")).toBeInTheDocument();
    // Trading does not need market-data: the forms are there.
    expect(screen.getByText("Trading does not need the chart. You can still buy and sell.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Buy shares" })).toBeInTheDocument();

    server.use(contractHandler("getMarketHistory", () => unavailable("history_paused", 9)));
    server.use(contractHandler("market-data:getMarket", () => reply(200, dataMarket())));
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("The price chart is not available right now")).toBeInTheDocument();
    expect(screen.getByText("Try again in about 9 seconds.")).toBeInTheDocument();
  });

  it("shows a market that is closed without trading forms", async () => {
    marketIs({ status: "closed", closedAt: NOW, closedBy: "system:auto-close" });
    dataIs({ status: "closed", closedAt: NOW });
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText("Trading in this market has stopped.")).toBeInTheDocument();
    expect(screen.getByText("Trading has stopped; the tenant admin resolves it next.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Buy shares" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sell shares" })).not.toBeInTheDocument();
    // The share dialog still works for a closed market.
    expect(await screen.findByRole("button", { name: "Make the link" })).toBeInTheDocument();
  });

  it("shows the outcome of a resolved market and says where the winnings are", async () => {
    marketIs({ status: "resolved", outcome: "YES", resolvedAt: NOW, resolvedBy: USER_ID });
    dataIs({ status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000 });
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText("This market is resolved: no more trades. Winnings or refunds are in your portfolio.")).toBeInTheDocument();
    const article = screen.getByRole("article");
    expect(termValue(article, "Outcome")).toContain("YES");
    expect(within(article).getByText(/shares of YES were paid 1\.00 credit each/)).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "YES price over time" })).toBeInTheDocument();
    expect(termValue(price(), "YES price")).toBe("1.00");
    expect(termValue(price(), "NO price")).toBe("0.00");
  });

  it("calls a market resolved INVALID by its last prices, because nothing was paid out on them", async () => {
    marketIs({ status: "resolved", outcome: "INVALID", resolvedAt: NOW, description: "Counts once the doors open." });
    dataIs({ status: "resolved", outcome: "INVALID", currentPriceYesMicro: 480_000, lastPriceYesMicro: 480_000 });
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText("Last YES price")).toBeInTheDocument();
    expect(screen.getByText("Last NO price")).toBeInTheDocument();
    expect(screen.getByText(/Every stake was refunded/)).toBeInTheDocument();
    expect(screen.getByText("Counts once the doors open.")).toBeInTheDocument();
  });

  it("shows 'no trade yet' and a single trade in the singular", async () => {
    dataIs({ tradeCount: 1, lastTradeAt: null, volumeMicro: 1_000_000 });
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText("1.00 credits in 1 trade")).toBeInTheDocument();
    expect(screen.getByText("No trade yet")).toBeInTheDocument();
  });

  it("shows the balance failure beside the price and tries again", async () => {
    let reads = 0;
    server.use(contractHandler("getPortfolio", () => (reads++ === 0 ? unavailable("tenant_not_ready", 3) : reply(200, portfolio()))));
    renderApp({ user: traderOidc(), path });
    expect(await screen.findByText("Your balance could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "YES price over time" })).toBeInTheDocument();
    await typing().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("90.00 credits")).toBeInTheDocument();
    expect(termValue(screen.getByRole("region", { name: "Trade" }), "YES shares you hold")).toBe("18.18");
  });
});

describe("the market page of a tenant admin", () => {
  it("shows the actions and the funding, never the trading forms, and does not read the portfolio", async () => {
    let portfolioReads = 0;
    server.use(
      contractHandler("getPortfolio", () => {
        portfolioReads += 1;
        return reply(200, portfolio());
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByRole("heading", { name: "Manage this market" })).toBeInTheDocument();
    expect(screen.getByText("Funding")).toBeInTheDocument();
    expect(screen.getByText("1,000 credits (EUR 10.00)")).toBeInTheDocument();
    expect(screen.getByText("Tenant admins manage the markets and do not trade in them.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close the market" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "YES price over time" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Trade" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Buy shares" })).not.toBeInTheDocument();
    expect(portfolioReads).toBe(0);
  });

  it("shows a draft with no price or chart, and lets only its creator open it", async () => {
    marketIs({ status: "draft", openedAt: null, createdBy: "another-admin" });
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByText("Only the tenant admin who created this market can open it, because their credits fund it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open the market" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Price" })).not.toBeInTheDocument();
    expect(screen.getByText("Not open yet: only tenant admins see it, and nobody can trade.")).toBeInTheDocument();
  });
});

describe("closing and resolving", () => {
  it("asks before it closes, gives the focus to the question, and Cancel and Escape give it back to the button", async () => {
    let closes = 0;
    server.use(
      contractHandler("closeMarket", ({ params }) => {
        closes += 1;
        expect(params["id"]).toBe(MARKET_ID);
        return reply(200, market({ status: "closed", closedAt: NOW, closedBy: USER_ID, version: 3 }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    const trigger = await screen.findByRole("button", { name: "Close the market" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const group = confirmationOf("Close this market?");
    expect(group).toHaveTextContent("Nobody can buy or sell after that. The market stays closed until you resolve it.");
    expect(within(group).getByText("Close this market?").parentElement).toHaveFocus();

    await user.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Close this market?" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(closes).toBe(0);

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Close this market?" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(within(confirmationOf("Close this market?")).getByRole("button", { name: "Yes, close the market" }));
    expect(await screen.findByText("The market is closed. Resolve it when the answer is known.")).toBeInTheDocument();
    expect(closes).toBe(1);
    // The page follows the answer: no close button any more, the three answers instead, and no forms for traders.
    expect(screen.queryByRole("button", { name: "Close the market" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Resolve as / }).map((button) => button.textContent)).toEqual(["Resolve as YES", "Resolve as NO", "Resolve as INVALID"]);
    expect(within(screen.getByRole("article")).getByText("Closed")).toBeInTheDocument();
  });

  it.each([
    ["YES", /Winners are paid 1\.00 credit per YES share/],
    ["NO", /Winners are paid 1\.00 credit per NO share/],
    ["INVALID", /Every stake is refunded/],
  ] as const)("resolves a closed market as %s only after a confirmation that says what it does", async (outcome, effect) => {
    marketIs({ status: "closed", closedAt: NOW });
    let sent: unknown;
    server.use(
      contractHandler("resolveMarket", ({ body }) => {
        sent = body;
        return reply(200, market({ status: "resolved", outcome, resolvedAt: NOW, resolvedBy: USER_ID, version: 4 }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: `Resolve as ${outcome}` }));
    const group = confirmationOf(`Resolve this market as ${outcome}?`);
    expect(group).toHaveTextContent(effect);
    expect(group).toHaveTextContent("This cannot be undone.");
    expect(sent).toBeUndefined();
    await user.click(within(group).getByRole("button", { name: `Yes, resolve as ${outcome}` }));
    expect(await screen.findByText(`The market is resolved as ${outcome}. The payouts are being made.`)).toBeInTheDocument();
    expect(sent).toEqual({ outcome });
    expect(screen.getByText("This market is resolved: there is nothing left to do.")).toBeInTheDocument();
    expect(termValue(screen.getByRole("article"), "Outcome")).toContain(outcome);
  });

  it("shows one confirmation at a time, and the same button again withdraws it", async () => {
    marketIs({ status: "closed", closedAt: NOW });
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Resolve as YES" }));
    expect(screen.getByRole("button", { name: "Resolve as YES" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Resolve as NO" }));
    expect(screen.queryByRole("group", { name: "Resolve this market as YES?" })).not.toBeInTheDocument();
    expect(confirmationOf("Resolve this market as NO?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resolve as NO" }));
    expect(screen.queryByRole("group", { name: /^Resolve this market/ })).not.toBeInTheDocument();
  });

  it.each([
    ["close", "Close the market", "Yes, close the market", "closeMarket"],
    ["resolve", "Resolve as NO", "Yes, resolve as NO", "resolveMarket"],
  ] as const)("shows a refusal to %s because the state changed, and reads the market again", async (_name, trigger, confirm, operation) => {
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => reply(200, reads++ === 0 ? market({ status: operation === "closeMarket" ? "open" : "closed" }) : market({ status: "resolved", outcome: "YES", resolvedAt: NOW }))),
      contractHandler(operation, () => reply(409, problem(409, "Market is not in the right state", { code: "invalid_state", detail: "The market is resolved." }))),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: trigger }));
    await user.click(screen.getByRole("button", { name: confirm }));
    const alert = await screen.findByText("The action was not done");
    expect(alert.closest("[role=alert]")).toHaveTextContent("Market is not in the right state");
    expect(screen.getByText(/somebody \(or the close time\) changed it/)).toBeInTheDocument();
    // What the page shows is what the service has: the market is resolved now.
    expect(await screen.findByText("This market is resolved: there is nothing left to do.")).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  // markets: any tenant admin of the tenant may close or resolve (contracts/markets.openapi.yaml); only opening is the creator's.
  it.each([
    ["close", "Close the market", "Yes, close the market", "closeMarket"],
    ["resolve", "Resolve as NO", "Yes, resolve as NO", "resolveMarket"],
  ] as const)("explains a 403 to %s with the rule of that action, not the rule of opening a draft", async (_name, trigger, confirm, operation) => {
    server.use(
      contractHandler("getMarket", () => reply(200, market({ status: operation === "closeMarket" ? "open" : "closed" }))),
      contractHandler(operation, () => reply(403, problem(403, "Forbidden", { code: "forbidden", detail: "Details of the refusal." }))),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: trigger }));
    await user.click(screen.getByRole("button", { name: confirm }));
    const alert = (await screen.findByText("The action was not done")).closest("[role=alert]");
    expect(alert).toHaveTextContent("Forbidden");
    expect(screen.getByText("Your role does not allow this. Only a tenant admin of this organization can close or resolve a market.")).toBeInTheDocument();
    expect(screen.queryByText(/Only the tenant admin who created a draft can open it/)).not.toBeInTheDocument();
  });

  it("shows an answer it has no advice for as the problem it is, and nothing more", async () => {
    server.use(contractHandler("closeMarket", () => reply(409, problem(409, "Market is busy", { code: "something_new", detail: "Another change is being made." }))));
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Close the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, close the market" }));
    const alert = (await screen.findByText("The action was not done")).closest("[role=alert]");
    expect(alert).toHaveTextContent("Market is busy");
    expect(alert).toHaveTextContent("Another change is being made.");
    expect(screen.queryByText(/somebody \(or the close time\) changed it/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to the wallet" })).not.toBeInTheDocument();
  });

  it("gives the focus back to the button that asked when a confirmation to open or to resolve is cancelled", async () => {
    marketIs({ status: "draft", openedAt: null, createdBy: USER_ID });
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    const open = await screen.findByRole("button", { name: "Open the market" });
    await user.click(open);
    await user.click(within(confirmationOf("Open this market?")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Open this market?" })).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("gives the focus back to the answer that was chosen when its confirmation is cancelled", async () => {
    marketIs({ status: "closed", closedAt: NOW });
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    const resolve = await screen.findByRole("button", { name: "Resolve as INVALID" });
    await user.click(resolve);
    await user.click(within(confirmationOf("Resolve this market as INVALID?")).getByRole("button", { name: "Cancel" }));
    expect(resolve).toHaveFocus();
  });
});

describe("opening a draft", () => {
  const draft = { status: "draft" as const, openedAt: null, createdBy: USER_ID };

  it("asks first, says what it costs, takes the funding and shows the open market", async () => {
    marketIs(draft);
    let opens = 0;
    server.use(
      contractHandler("openMarket", ({ params }) => {
        opens += 1;
        expect(params["id"]).toBe(MARKET_ID);
        return reply(200, market({ status: "open", version: 3 }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Open the market" }));
    const group = screen.getByRole("group", { name: "Open this market?" });
    expect(group).toHaveTextContent("1,000 credits (EUR 10.00) are taken from your balance to fund it.");
    expect(opens).toBe(0);
    await user.click(within(group).getByRole("button", { name: "Yes, open the market" }));
    expect(await screen.findByText("The market is open: traders can trade now.")).toBeInTheDocument();
    expect(opens).toBe(1);
    expect(screen.getByRole("button", { name: "Close the market" })).toBeInTheDocument();
    // An open market has a price and a chart; the draft had none.
    expect(await screen.findByRole("img", { name: "YES price over time" })).toBeInTheDocument();
  });

  it("follows a market whose funding is unconfirmed (202) until it is open", async () => {
    useFakeClock();
    let status: MarketStatus = "draft";
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => {
        reads += 1;
        return reply(200, market({ ...draft, status }));
      }),
      contractHandler("openMarket", () => {
        status = "opening";
        return reply(202, market({ ...draft, status: "opening" }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Open the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, open the market" }));
    expect(await screen.findByText(/The funding of this market is being confirmed\. This page follows it and updates by itself\./)).toBeInTheDocument();
    expect(screen.getByText("The funding is being confirmed. The market opens as soon as it is.")).toBeInTheDocument();
    expect(screen.getByText("Opening", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close the market" })).not.toBeInTheDocument();
    const readsWhileOpening = reads;

    status = "open";
    await advance(OPENING_POLL_MS);
    expect(await screen.findByRole("button", { name: "Close the market" })).toBeInTheDocument();
    expect(screen.queryByText(/This page follows it/)).not.toBeInTheDocument();
    expect(reads).toBeGreaterThan(readsWhileOpening);
    // Settled: the polling stopped.
    const settled = reads;
    await advance(OPENING_POLL_MS * 5);
    expect(reads).toBe(settled);
  });

  it("follows a market that is being opened when the page is loaded, and shows it as a draft again when the funding failed", async () => {
    useFakeClock();
    let status: MarketStatus = "opening";
    server.use(contractHandler("getMarket", () => reply(200, market({ ...draft, status }))));
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByText(/The funding of this market is being confirmed/)).toBeInTheDocument();
    expect(screen.getByText("The funding is being confirmed. Nothing to do until the market opens or falls back to a draft.")).toBeInTheDocument();
    status = "draft";
    await advance(OPENING_POLL_MS);
    expect(await screen.findByRole("button", { name: "Open the market" })).toBeInTheDocument();
    expect(screen.queryByText(/This page follows it/)).not.toBeInTheDocument();
  });

  it("shows a failed read while it follows, goes on after the wait, and offers 'Check again' when it takes too long", async () => {
    useFakeClock();
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => {
        reads += 1;
        // The page load (read 1) works; the first poll read (2) fails with a wait; the rest say "opening".
        return reads === 2 ? unavailable("tenant_not_ready", 4) : reply(200, market({ ...draft, status: "opening" }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByText("The status could not be read")).toBeInTheDocument();
    expect(screen.getByText("Try again in about 4 seconds.")).toBeInTheDocument();
    await advance(4000);
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.queryByText("The status could not be read")).not.toBeInTheDocument());

    await advance(OPENING_POLL_MS * OPENING_POLL_MAX);
    expect(await screen.findByText(/This takes longer than usual\. The market goes on opening in the background; nothing is lost\./)).toBeInTheDocument();
    const before = reads;
    await typing().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reads).toBe(before + 1));
  });

  it.each([
    [409, "insufficient_credits", "Not enough credits", "You do not have enough credits to fund this market. It is still a draft.", true],
    [502, "funding_rejected", "Funding rejected", "Trading rejected the funding request. Nothing was taken and the market is still a draft.", false],
    [403, "forbidden", "Forbidden", "Your role does not allow this. Only the tenant admin who created a draft can open it.", false],
  ] as const)("explains a refusal of %i %s in plain words", async (status, code, title, advice, wallet) => {
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => {
        reads += 1;
        return reply(200, market(draft));
      }),
      contractHandler("openMarket", () => reply(status, problem(status, title, { code, detail: "Details of the refusal." }))),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Open the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, open the market" }));
    const alert = await screen.findByText("The action was not done");
    expect(alert.closest("[role=alert]")).toHaveTextContent(title);
    expect(alert.closest("[role=alert]")).toHaveTextContent("Details of the refusal.");
    expect(screen.getByText(new RegExp(advice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to the wallet" }) !== null).toBe(wallet);
    // A refusal of the role changes nothing; every other answer makes the page read the market again.
    await waitFor(() => expect(reads).toBe(status === 403 ? 1 : 2));
    // The market is still a draft and can be opened again.
    expect(screen.getByRole("button", { name: "Open the market" })).toBeEnabled();
  });

  it("says trading is away, with the wait, and that nothing was taken", async () => {
    marketIs(draft);
    server.use(contractHandler("openMarket", () => unavailable("trading_unavailable", 7)));
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Open the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, open the market" }));
    expect(await screen.findByText(/Trading is not available right now\. Nothing was taken and the market is still a draft; try again after the wait below\./)).toBeInTheDocument();
    expect(screen.getByText("Try again in about 7 seconds.")).toBeInTheDocument();
  });

  it("takes a 502 funding_rejected as the service's own answer: it says nothing was taken, never 'we do not know yet', and the market can be opened again at once", async () => {
    let answers = 0;
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => {
        reads += 1;
        return reply(200, market(draft));
      }),
      contractHandler("openMarket", () => {
        answers += 1;
        return answers === 1 ? reply(502, problem(502, "Funding rejected", { code: "funding_rejected", detail: "Trading refused the funding." })) : reply(200, market({ ...draft, status: "open" }));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Open the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, open the market" }));
    const heading = await screen.findByText("The action was not done");
    expect(heading.closest("[role=alert]")).toHaveTextContent("Trading refused the funding.");
    expect(screen.getByText(/Trading rejected the funding request\. Nothing was taken and the market is still a draft\./)).toBeInTheDocument();
    expect(screen.queryByText(/We do not know yet/)).not.toBeInTheDocument();
    // A definite answer: the page reads the market again, and the next open is a new request.
    await waitFor(() => expect(reads).toBe(2));
    await user.click(screen.getByRole("button", { name: "Open the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, open the market" }));
    expect(await screen.findByText("The market is open: traders can trade now.")).toBeInTheDocument();
    expect(answers).toBe(2);
  });

  it.each([
    ["a bad gateway page", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })],
    ["a 500 internal_error", () => reply(500, problem(500, "Internal error", { code: "internal_error" }))],
  ])("still says it does not know yet whether the market was opened after %s", async (_name, answer) => {
    marketIs(draft);
    server.use(http.post("http://gateway.test/v1/markets/:id/open", () => answer()));
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Open the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, open the market" }));
    expect(await screen.findByText("We do not know yet whether the market was opened")).toBeInTheDocument();
    expect(screen.queryByText("The action was not done")).not.toBeInTheDocument();
  });
});
