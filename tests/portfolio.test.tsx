import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Portfolio } from "../src/api/trading";
import { contractHandler, problem, reply, unavailable } from "./support/contract";
import { dataMarket, MARKET_2, MARKET_3, MARKET_ID, NOW, platformAdminOidc, portfolio, quietHandlers, tenantAdminOidc, traderOidc, TRADE_ID } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const typing = () => userEvent.setup({ delay: null });
const QUESTION = "Will the shared market open before Friday?";
const SECOND = "Will it rain on Sunday in Ljubljana?";
const THIRD = "Will the new office open in March?";

beforeEach(() => server.use(...quietHandlers()));

const prices = (markets: ReturnType<typeof dataMarket>[], calls: URLSearchParams[] = []) =>
  contractHandler("market-data:listMarkets", ({ query }) => {
    calls.push(query);
    const wanted = (query.get("ids") ?? "").split(",");
    return reply(200, { items: markets.filter((entry) => wanted.includes(entry.marketId)), nextCursor: null });
  });
const rowOf = (name: string): HTMLElement => screen.getByRole("link", { name }).closest("tr") as HTMLElement;
const cellsOf = (row: HTMLElement): string[] => within(row).getAllByRole("cell").map((cell) => cell.textContent ?? "");
const termValue = (term: string): string | null | undefined => screen.getByText(term, { selector: "dt" }).nextElementSibling?.textContent;
const withPortfolio = (overrides: Partial<Portfolio>) => server.use(contractHandler("getPortfolio", () => reply(200, portfolio(overrides))));

describe("the portfolio of a trader", () => {
  it("shows the balance, the positions with their current prices from one batch call, and the trades", async () => {
    const batches: URLSearchParams[] = [];
    const limits: (string | null)[] = [];
    server.use(
      contractHandler("getPortfolio", ({ query }) => {
        limits.push(query.get("limit"));
        return reply(200, portfolio());
      }),
      prices([dataMarket()], batches),
    );
    renderApp({ user: traderOidc(), path: "/portfolio" });

    expect(await screen.findByRole("heading", { level: 1, name: "Portfolio" })).toBeInTheDocument();
    expect(termValue("Balance")).toBe("90.00 credits");
    expect(termValue("You can withdraw")).toContain("90 credits (EUR 0.90)");
    expect(screen.getByRole("link", { name: "Go to the wallet" })).toHaveAttribute("href", "/wallet");
    expect(limits).toEqual(["50"]);

    // 18.181818 YES shares at 0.55 are worth 9.999999 credits, shown as 10.00.
    const positions = await screen.findByRole("table", { name: "Your positions" });
    expect(cellsOf(within(positions).getByRole("link", { name: QUESTION }).closest("tr") as HTMLElement)).toEqual(["Open", "18.18", "0.00", "0.55", "10.00 credits"]);
    expect(screen.getByText("Your positions are worth about 10.00 credits at the current prices.")).toBeInTheDocument();
    expect(within(positions).getByRole("link", { name: QUESTION })).toHaveAttribute("href", `/markets/${MARKET_ID}`);
    // One call for every market the page mentions, never one per position (DM-12).
    expect(batches).toHaveLength(1);
    expect(batches[0]?.get("ids")).toBe(MARKET_ID);

    const trades = screen.getByRole("table", { name: "Your recent trades, newest first" });
    expect(cellsOf(within(trades).getByRole("link", { name: QUESTION }).closest("tr") as HTMLElement)).toEqual([expect.any(String), "Bought YES", "18.18", "Paid 10.00 credits", "0.55"]);
    expect(screen.getByText(/No payout yet: winnings, refunds and returned funding appear here/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Markets you funded" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Portfolio - Chance"));
  });

  it("values resolved markets by their outcome, leaves out a market resolved INVALID, and lists the payouts and refunds", async () => {
    const batches: URLSearchParams[] = [];
    withPortfolio({
      positions: [
        { marketId: MARKET_ID, yesMicro: 18_181_818, noMicro: 0, question: QUESTION, status: "open", closeTime: null },
        { marketId: MARKET_2, yesMicro: 4_000_000, noMicro: 1_500_000, question: SECOND, status: "resolved", closeTime: null },
        { marketId: MARKET_3, yesMicro: 3_000_000, noMicro: 0, question: THIRD, status: "resolved", closeTime: null },
      ],
      recentTrades: [
        { tradeId: TRADE_ID, marketId: MARKET_ID, kind: "sale", side: "NO", sharesMicro: 2_000_000, costMicro: 900_000, proceedsMicro: 1_100_000, averagePriceMicro: 550_000, tradeSequence: 5, executedAt: NOW },
        { tradeId: "0192f3a4-5b6c-7d8e-9f01-23456789ab12", marketId: MARKET_2, kind: "buy", side: "YES", sharesMicro: 4_000_000, costMicro: 2_000_000, proceedsMicro: null, averagePriceMicro: 500_000, tradeSequence: 2, executedAt: NOW },
      ],
      payouts: [
        { marketId: MARKET_2, kind: "winnings", amountMicro: 4_000_000, outcome: "YES", paidAt: NOW },
        { marketId: MARKET_3, kind: "refund", amountMicro: 3_000_000, outcome: "INVALID", paidAt: NOW },
        { marketId: MARKET_3, kind: "returned", amountMicro: 250_000, outcome: null, paidAt: NOW },
      ],
    });
    server.use(
      prices(
        [
          dataMarket(),
          dataMarket({ marketId: MARKET_2, question: SECOND, status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000, resolvedAt: NOW }),
          dataMarket({ marketId: MARKET_3, question: THIRD, status: "resolved", outcome: "INVALID", currentPriceYesMicro: 480_000, resolvedAt: NOW }),
        ],
        batches,
      ),
    );
    renderApp({ user: traderOidc(), path: "/portfolio" });
    await screen.findByRole("table", { name: "Your positions" });

    const positions = within(screen.getByRole("table", { name: "Your positions" }));
    expect(cellsOf(positions.getByRole("link", { name: SECOND }).closest("tr") as HTMLElement)).toEqual(["Resolved: YES", "4.00", "1.50", "1.00", "4.00 credits"]);
    expect(cellsOf(positions.getByRole("link", { name: THIRD }).closest("tr") as HTMLElement)).toEqual(["Resolved: INVALID", "3.00", "0.00", "0.48", "Voided (refunded)"]);
    // 10.00 + 4.00; the voided market counts for nothing because its stake was refunded.
    expect(screen.getByText("Your positions are worth about 14.00 credits at the current prices.")).toBeInTheDocument();

    const trades = within(screen.getByRole("table", { name: "Your recent trades, newest first" }));
    expect(cellsOf(trades.getByRole("link", { name: QUESTION }).closest("tr") as HTMLElement)).toEqual([expect.any(String), "Sold NO", "2.00", "Received 1.10 credits", "0.55"]);

    const payouts = within(screen.getByRole("table", { name: "Your payouts, newest first" }));
    expect(payouts.getAllByRole("row").slice(1).map((row) => cellsOf(row).slice(1))).toEqual([
      ["Winnings", "4.00 credits", "YES"],
      ["Refund of a market resolved INVALID", "3.00 credits", "INVALID"],
      ["Funding that came back to you", "0.25 credits", "-"],
    ]);
    // Three markets are mentioned in the positions, the trades and the payouts: one call, each id once.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.get("ids")?.split(",").sort()).toEqual([MARKET_ID, MARKET_2, MARKET_3].sort());
  });

  it("shows everything but the prices when market-data is down, and says so", async () => {
    withPortfolio({
      positions: [
        { marketId: MARKET_ID, yesMicro: 18_181_818, noMicro: 0, question: QUESTION, status: "open", closeTime: null },
        { marketId: MARKET_2, yesMicro: 1_000_000, noMicro: 0, question: null, status: "funded", closeTime: null },
      ],
      recentTrades: [],
    });
    server.use(contractHandler("market-data:listMarkets", () => unavailable("tenant_not_ready", 5)));
    renderApp({ user: traderOidc(), path: "/portfolio" });
    expect(await screen.findByText(/Current prices are not available right now, so the positions are shown without them/)).toBeInTheDocument();
    expect(termValue("Balance")).toBe("90.00 credits");
    expect(cellsOf(rowOf(QUESTION))).toEqual(["Open", "18.18", "0.00", "-", "-"]);
    // A market with no name in trading's copy is named by the start of its id; its status is trading's own word.
    expect(cellsOf(rowOf("Market 0192f3a4"))).toEqual(["Opening", "1.00", "0.00", "-", "-"]);
    expect(screen.queryByText(/Your positions are worth about/)).not.toBeInTheDocument();
  });

  it("says so when there is nothing yet, and asks market-data for nothing", async () => {
    let batches = 0;
    withPortfolio({ positions: [], recentTrades: [], payouts: [], balanceMicro: 0, withdrawableCredits: 0 });
    server.use(
      contractHandler("market-data:listMarkets", () => {
        batches += 1;
        return reply(200, { items: [], nextCursor: null });
      }),
    );
    renderApp({ user: traderOidc(), path: "/portfolio" });
    expect(await screen.findByText("You hold no shares in any market yet. Open a market and buy some.")).toBeInTheDocument();
    expect(screen.getByText("You have not traded yet.")).toBeInTheDocument();
    expect(termValue("Balance")).toBe("0.00 credits");
    expect(batches).toBe(0);
    expect(screen.queryByText(/Current prices are not available/)).not.toBeInTheDocument();
  });

  it("shows a failure with its problem title and tries again, and refreshes on request", async () => {
    let reads = 0;
    server.use(
      contractHandler("getPortfolio", () => {
        reads += 1;
        return reads === 1 ? reply(503, problem(503, "Trading is starting", { code: "tenant_not_ready", detail: "Your account is being set up." }), { headers: { "Retry-After": "6" } }) : reply(200, portfolio({ balanceMicro: reads * 10_000_000 }));
      }),
      prices([dataMarket()]),
    );
    renderApp({ user: traderOidc(), path: "/portfolio" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your portfolio could not be loaded");
    expect(alert).toHaveTextContent("Trading is starting");
    expect(alert).toHaveTextContent("Your account is being set up.");
    expect(alert).toHaveTextContent("Try again in about 6 seconds.");
    const user = typing();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("20.00 credits")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("30.00 credits")).toBeInTheDocument();
  });

  it("says when only the newest 50 trades and payouts are shown", async () => {
    const trades = Array.from({ length: 50 }, (_, index) => ({
      tradeId: `0192f3a4-5b6c-7d8e-9f01-2345678a${String(index).padStart(4, "0")}`,
      marketId: MARKET_ID,
      kind: "buy" as const,
      side: "YES" as const,
      sharesMicro: 1_000_000,
      costMicro: 500_000,
      proceedsMicro: null,
      averagePriceMicro: 500_000,
      tradeSequence: index + 1,
      executedAt: NOW,
    }));
    withPortfolio({ recentTrades: trades });
    server.use(prices([dataMarket()]));
    renderApp({ user: traderOidc(), path: "/portfolio" });
    expect(await screen.findByText("Only the newest 50 trades and payouts are shown.")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Your recent trades, newest first" })).getAllByRole("row")).toHaveLength(51);
  });
});

describe("the portfolio of a tenant admin", () => {
  it("also shows the markets they funded and what came back", async () => {
    withPortfolio({
      positions: [],
      recentTrades: [],
      fundedMarkets: [
        { marketId: MARKET_ID, question: QUESTION, status: "resolved", fundingMicro: 1_000_000_000, returnedMicro: 640_000_000, settledAt: "2026-12-31T13:00:00Z" },
        { marketId: MARKET_2, question: SECOND, status: "open", fundingMicro: 500_000_000, returnedMicro: null, settledAt: null },
        { marketId: MARKET_3, question: null, status: "funded", fundingMicro: null, returnedMicro: null, settledAt: null },
      ],
    });
    renderApp({ user: tenantAdminOidc(), path: "/portfolio" });
    const funded = await screen.findByRole("table", { name: "Markets funded by you and what came back" });
    expect(screen.getByRole("heading", { name: "Markets you funded" })).toBeInTheDocument();
    const rows = within(funded);
    expect(cellsOf(rows.getByRole("link", { name: QUESTION }).closest("tr") as HTMLElement).slice(0, 3)).toEqual(["Resolved", "1,000.00 credits", "640.00 credits"]);
    expect(cellsOf(rows.getByRole("link", { name: SECOND }).closest("tr") as HTMLElement)).toEqual(["Open", "500.00 credits", "Not yet", "-"]);
    expect(cellsOf(rows.getByRole("link", { name: "Market 0192f3a4" }).closest("tr") as HTMLElement)).toEqual(["Opening", "-", "Not yet", "-"]);
    // A funded market is a link to its page, and an admin has no positions to price.
    expect(rows.getByRole("link", { name: SECOND })).toHaveAttribute("href", `/markets/${MARKET_2}`);
    expect(screen.getByText("You hold no shares in any market yet. Open a market and buy some.")).toBeInTheDocument();
  });

  it("says so when the admin has funded nothing", async () => {
    withPortfolio({ positions: [], recentTrades: [], fundedMarkets: [] });
    renderApp({ user: tenantAdminOidc(), path: "/portfolio" });
    expect(await screen.findByText("You have not funded a market yet.")).toBeInTheDocument();
  });
});

describe("who may open the portfolio", () => {
  it("shows a platform admin nothing of a tenant and reads nothing", async () => {
    let reads = 0;
    server.use(
      contractHandler("getPortfolio", () => {
        reads += 1;
        return reply(200, portfolio());
      }),
      contractHandler("listTenants", () => reply(200, { items: [], nextCursor: null })),
    );
    renderApp({ user: platformAdminOidc(), path: "/portfolio" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
    expect(reads).toBe(0);
  });
});
