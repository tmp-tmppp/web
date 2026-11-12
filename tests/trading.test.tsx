import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import { UPDATE_ATTEMPTS, UPDATE_WAIT_MS } from "../src/pages/markets/MarketDataPanel";
import { tradeAdvice } from "../src/pages/markets/trade-parts";
import { useFakeClock } from "./support/clock";
import { contractHandler, problem, reply, unavailable } from "./support/contract";
import { dataMarket, market, MARKET_ID, order, portfolio, quietHandlers, quote, sale, saleQuote, TRADE_ID, traderOidc } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const typing = () => userEvent.setup({ delay: null });
type User = ReturnType<typeof typing>;
const path = `/markets/${MARKET_ID}`;

beforeEach(() => server.use(...quietHandlers()));

const account = (overrides: Parameters<typeof portfolio>[0] = {}) =>
  server.use(contractHandler("getPortfolio", () => reply(200, portfolio({ balanceMicro: 100_000_000, withdrawableCredits: 100, ...overrides }))));
const termValue = (scope: HTMLElement, term: string): string | null | undefined => within(scope).getByText(term, { selector: "dt" }).nextElementSibling?.textContent;
const tradeRegion = () => screen.getByRole("region", { name: "Trade" });
const buyForm = async () => within(await screen.findByRole("form", { name: "Buy shares" }));
const sellForm = async () => within(await screen.findByRole("form", { name: "Sell shares" }));
const created = { headers: { Location: `/v1/trading/orders/${TRADE_ID}` } };

async function getBuyQuote(user: User, amount = "10") {
  const form = await buyForm();
  await user.type(form.getByLabelText("Amount to spend, in credits"), amount);
  await user.click(form.getByRole("button", { name: "Get a quote" }));
  return form;
}

async function getSaleQuote(user: User, shares = "10") {
  const form = await sellForm();
  await user.type(form.getByLabelText("Shares to sell"), shares);
  await user.click(form.getByRole("button", { name: "Get a sale quote" }));
  return form;
}

describe("buying", () => {
  it("asks for a quote, then places the order with a price limit and an Idempotency-Key, and shows the new balance and position", async () => {
    account({ positions: [] });
    const seen: { quote: string[]; order: unknown; key: string | null; data: (string | null)[]; history: (string | null)[] } = { quote: [], order: null, key: null, data: [], history: [] };
    server.use(
      contractHandler("getQuote", ({ query }) => {
        seen.quote.push(query.toString());
        return reply(200, quote());
      }),
      contractHandler("placeOrder", ({ body, request }) => {
        seen.order = body;
        seen.key = request.headers.get("Idempotency-Key");
        return reply(201, order(), created);
      }),
      contractHandler("market-data:getMarket", ({ query }) => {
        seen.data.push(query.get("afterSequence"));
        return reply(200, dataMarket(query.get("afterSequence") ? { currentPriceYesMicro: 560_000, lastPriceYesMicro: 560_000, lastTradeSequence: 4, tradeCount: 4 } : {}));
      }),
      contractHandler("getMarketHistory", ({ query }) => {
        seen.history.push(query.get("afterSequence"));
        return reply(200, { marketId: MARKET_ID, interval: "1h", from: "2026-11-11T09:00:00Z", to: "2026-11-11T10:00:00Z", previousCloseYesMicro: null, buckets: [], nextCursor: null });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await buyForm();
    expect(await screen.findByText("100.00 credits")).toBeInTheDocument();

    await user.type(form.getByLabelText("Amount to spend, in credits"), "10");
    expect(form.getByLabelText("Amount to spend, in credits")).toHaveAccessibleDescription("That is 10 credits (EUR 0.10).");
    await user.click(form.getByRole("button", { name: "Get a quote" }));
    expect(await form.findByText(/you get about/)).toBeInTheDocument();
    expect(seen.quote).toEqual([`marketId=${MARKET_ID}&side=YES&amount=10`]);
    const quoted = form.getByText(/you get about/).closest(".quote");
    expect(quoted).toHaveTextContent("For 10 credits (EUR 0.10) you get about 18.18 YES shares at an average price of 0.55 per share (the last share costs 0.55).");
    expect(quoted).toHaveTextContent("The order is refused if the average price would go above 0.56.");
    expect(seen.order).toBeNull();

    await user.click(form.getByRole("button", { name: "Buy YES shares for 10 credits" }));
    expect(await form.findByText(/Bought/)).toHaveTextContent("Bought 18.18 YES shares for 10.00 credits at an average price of 0.55. Your balance is now 90.00 credits.");
    // 0.55 plus 1 %, rounded up to the next microcredit: 555 500.
    expect(seen.order).toEqual({ marketId: MARKET_ID, side: "YES", amount: 10, maxAveragePriceMicro: 555_500 });
    expect(seen.key).toMatch(/^[0-9a-f-]{36}$/);

    // The balance and the position come from the answer of the trade (DM-17), not from a new read of the portfolio.
    expect(termValue(tradeRegion(), "Your balance")).toBe("90.00 credits");
    expect(termValue(tradeRegion(), "YES shares you hold")).toBe("18.18");
    expect(form.getByLabelText("Amount to spend, in credits")).toHaveValue("");
    expect(form.queryByRole("button", { name: /^Buy YES shares/ })).not.toBeInTheDocument();
    // The chart asks for the sequence of the order: market-data answers once it has that trade.
    await waitFor(() => expect(seen.data).toEqual([null, "4"]));
    expect(seen.history).toEqual([null, "4"]);
    await waitFor(() => expect(termValue(screen.getByRole("region", { name: "Price" }), "YES price")).toBe("0.56"));
  });

  it("buys NO shares, and a quote is good only for the side and the amount it was made for", async () => {
    account({ positions: [] });
    let orders = 0;
    let body: unknown;
    server.use(
      contractHandler("getQuote", ({ query }) => reply(200, quote({ side: query.get("side") === "NO" ? "NO" : "YES", amount: Number(query.get("amount")), averagePriceMicro: 450_000, worstPriceMicro: 450_000 }))),
      contractHandler("placeOrder", ({ body: sent }) => {
        orders += 1;
        body = sent;
        return reply(201, order({ side: "NO", position: { marketId: MARKET_ID, yesMicro: 0, noMicro: 22_222_222 } }), created);
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    expect(await form.findByRole("button", { name: "Buy YES shares for 10 credits" })).toBeInTheDocument();

    await user.click(form.getByRole("radio", { name: /^NO: pays 1\.00 credit per share if the answer is NO/ }));
    expect(form.queryByRole("button", { name: /^Buy / })).not.toBeInTheDocument();
    await user.click(form.getByRole("button", { name: "Get a quote" }));
    expect(await form.findByRole("button", { name: "Buy NO shares for 10 credits" })).toBeInTheDocument();

    await user.type(form.getByLabelText("Amount to spend, in credits"), "5");
    expect(form.queryByRole("button", { name: /^Buy / })).not.toBeInTheDocument();
    await user.clear(form.getByLabelText("Amount to spend, in credits"));
    await user.type(form.getByLabelText("Amount to spend, in credits"), "10");
    await user.click(form.getByRole("button", { name: "Get a quote" }));
    await user.click(await form.findByRole("button", { name: "Buy NO shares for 10 credits" }));
    await form.findByText(/Bought/);
    expect(orders).toBe(1);
    expect(body).toEqual({ marketId: MARKET_ID, side: "NO", amount: 10, maxAveragePriceMicro: 454_500 });
    expect(termValue(tradeRegion(), "NO shares you hold")).toBe("22.22");
  });

  it.each(["", "0", "12.5", "1e3", "-5", "abc", "1000001"])("refuses the amount %j in words, before any request", async (amount) => {
    account({ positions: [] });
    let quotes = 0;
    server.use(
      contractHandler("getQuote", () => {
        quotes += 1;
        return reply(200, quote());
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await buyForm();
    if (amount !== "") await user.type(form.getByLabelText("Amount to spend, in credits"), amount);
    await user.click(form.getByRole("button", { name: "Get a quote" }));
    expect(await form.findByText("Enter a whole number of credits from 1 to 1,000,000.", { selector: "p.field-error" })).toBeInTheDocument();
    expect(form.getByLabelText("Amount to spend, in credits")).toBeInvalid();
    expect(quotes).toBe(0);
  });

  it("shows a market that cannot take the amount as the problem it is, with advice, and keeps the form usable", async () => {
    account({ positions: [] });
    server.use(contractHandler("getQuote", () => reply(409, problem(409, "Not enough offers", { code: "insufficient_liquidity", detail: "The market can take at most 40 credits.", maxAmount: 40 }))));
    renderApp({ user: traderOidc(), path });
    const form = await getBuyQuote(typing(), "500");
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was bought");
    expect(alert).toHaveTextContent("Not enough offers");
    expect(alert).toHaveTextContent("The market can take at most 40 credits.");
    expect(form.getByText(/The market cannot take that much right now\. Try a smaller amount/)).toBeInTheDocument();
    expect(form.getByRole("button", { name: "Get a quote" })).toBeEnabled();
  });

  it("shows the new quote when the price moved after the quote and buys nothing, then buys under a new key", async () => {
    account({ positions: [] });
    const keys: (string | null)[] = [];
    const bodies: unknown[] = [];
    let quotes = 0;
    server.use(
      contractHandler("getQuote", () => {
        quotes += 1;
        return reply(200, quotes === 1 ? quote() : quote({ averagePriceMicro: 600_000, worstPriceMicro: 620_000, sharesMicro: 16_666_666 }));
      }),
      contractHandler("placeOrder", ({ request, body }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        bodies.push(body);
        if (keys.length === 1) return reply(409, problem(409, "Price limit exceeded", { code: "price_limit_exceeded", detail: "The average price would be 0.60." }));
        return reply(201, order({ averagePriceMicro: 600_000, sharesMicro: 16_666_666 }), created);
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Buy YES shares for 10 credits" }));
    expect(await form.findByText(/The price moved while you were deciding, so nothing was bought/)).toBeInTheDocument();
    expect(form.getByText(/you get about/).closest(".quote")).toHaveTextContent("about 16.66 YES shares at an average price of 0.60");
    expect(form.getByText(/you get about/).closest(".quote")).toHaveTextContent("above 0.61");
    // Nothing changed in the account: the old balance is still shown.
    expect(termValue(tradeRegion(), "Your balance")).toBe("100.00 credits");

    await user.click(form.getByRole("button", { name: "Buy YES shares for 10 credits" }));
    await form.findByText(/Bought/);
    expect(bodies).toEqual([
      { marketId: MARKET_ID, side: "YES", amount: 10, maxAveragePriceMicro: 555_500 },
      { marketId: MARKET_ID, side: "YES", amount: 10, maxAveragePriceMicro: 606_000 },
    ]);
    // A definitive answer ends the attempt: the next order is a new one.
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("repeats the same order under the same key after an outage, so the service finishes the first try instead of buying twice", async () => {
    account({ positions: [] });
    const keys: (string | null)[] = [];
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("placeOrder", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return keys.length === 1 ? unavailable("orders_paused", 5) : reply(200, order());
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Buy YES shares for 10 credits" }));
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was bought");
    expect(alert).toHaveTextContent("Try again in about 5 seconds.");
    expect(form.getByText(/New orders and sales are paused for a moment/)).toBeInTheDocument();
    await user.click(form.getByRole("button", { name: "Buy YES shares for 10 credits" }));
    await form.findByText(/Bought/);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    // A repeat that the service answers with 200 (the same order) is shown like the first try.
    expect(termValue(tradeRegion(), "Your balance")).toBe("90.00 credits");
  });

  it("says there are not enough credits and links to the wallet", async () => {
    account({ positions: [] });
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("placeOrder", () => reply(409, problem(409, "Not enough credits", { code: "insufficient_credits", detail: "You have 5 credits.", withdrawableCredits: 5 }))),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Buy YES shares for 10 credits" }));
    expect(await form.findByText(/You do not have enough credits for this\. Nothing was bought\./)).toBeInTheDocument();
    expect(form.getByRole("link", { name: "Go to the wallet" })).toHaveAttribute("href", "/wallet");
    expect(termValue(tradeRegion(), "Your balance")).toBe("100.00 credits");
  });

  it("reads the market again when the service says it is not open any more, so the forms go away", async () => {
    account({ positions: [] });
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => reply(200, market(reads++ === 0 ? {} : { status: "closed", closedAt: "2026-11-11T10:00:00Z", closedBy: "system:auto-close" }))),
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("placeOrder", () => reply(409, problem(409, "Market not open", { code: "market_not_open", detail: "The market closed." }))),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Buy YES shares for 10 credits" }));
    expect(await screen.findByText("Trading in this market has stopped.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Buy shares" })).not.toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it("reads the market again also when the quote says it is not open", async () => {
    account({ positions: [] });
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => reply(200, market(reads++ === 0 ? {} : { status: "closed" }))),
      contractHandler("getQuote", () => reply(409, problem(409, "Market not open", { code: "market_not_open" }))),
    );
    renderApp({ user: traderOidc(), path });
    await getBuyQuote(typing(), "10");
    expect(await screen.findByText("Trading in this market has stopped.")).toBeInTheDocument();
  });

  it("shows why the new quote could not be had when the price moved and the quote cannot be read again", async () => {
    account({ positions: [] });
    let quotes = 0;
    server.use(
      contractHandler("getQuote", () => {
        quotes += 1;
        return quotes === 1 ? reply(200, quote()) : unavailable("tenant_not_ready", 3);
      }),
      contractHandler("placeOrder", () => reply(409, problem(409, "Price limit exceeded", { code: "price_limit_exceeded" }))),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Buy YES shares for 10 credits" }));
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was bought");
    expect(alert).toHaveTextContent("Try again in about 3 seconds.");
    // There is no quote to buy on any more: the person asks for a new one.
    expect(form.queryByRole("button", { name: /^Buy YES/ })).not.toBeInTheDocument();
    expect(form.queryByText(/The price moved/)).not.toBeInTheDocument();
  });
});

describe("selling", () => {
  it("asks for a sale quote, then sells with a lowest acceptable return and an Idempotency-Key, and shows the new balance and position", async () => {
    account({ balanceMicro: 90_000_000 });
    const seen: { quote: string[]; sale: unknown; key: string | null } = { quote: [], sale: null, key: null };
    server.use(
      contractHandler("getSaleQuote", ({ query }) => {
        seen.quote.push(query.toString());
        return reply(200, saleQuote());
      }),
      contractHandler("sellShares", ({ body, request }) => {
        seen.sale = body;
        seen.key = request.headers.get("Idempotency-Key");
        return reply(201, sale(), created);
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await sellForm();
    expect(form.getByLabelText("Shares to sell")).toHaveAccessibleDescription("You hold 18.18 YES shares.");
    expect(form.getByRole("radio", { name: "YES (you hold 18.18)" })).toBeChecked();
    expect(form.getByRole("radio", { name: "NO (you hold 0.00)" })).not.toBeChecked();

    await user.type(form.getByLabelText("Shares to sell"), "10");
    await user.click(form.getByRole("button", { name: "Get a sale quote" }));
    expect(await form.findByText(/returns about/)).toBeInTheDocument();
    expect(seen.quote).toEqual([`marketId=${MARKET_ID}&side=YES&sharesMicro=10000000`]);
    const quoted = form.getByText(/returns about/).closest(".quote");
    expect(quoted).toHaveTextContent("Selling 10.00 YES shares returns about 5.50 credits, on average 0.55 per share.");
    expect(quoted).toHaveTextContent("The sale is refused if it would return less than 5.45 credits.");

    await user.click(form.getByRole("button", { name: "Sell 10.00 YES shares" }));
    expect(await form.findByText(/Sold/)).toHaveTextContent("Sold 10.00 YES shares and received 5.50 credits. Your balance is now 95.50 credits.");
    // 5.5 credits less 1 %: 5 445 000 microcredits.
    expect(seen.sale).toEqual({ marketId: MARKET_ID, side: "YES", sharesMicro: 10_000_000, minProceedsMicro: 5_445_000 });
    expect(seen.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(termValue(tradeRegion(), "Your balance")).toBe("95.50 credits");
    expect(termValue(tradeRegion(), "YES shares you hold")).toBe("8.18");
    expect(form.getByLabelText("Shares to sell")).toHaveValue("");
  });

  it("fills in every share held, with the exact decimal, for 'Sell all'", async () => {
    account({ positions: [{ marketId: MARKET_ID, yesMicro: 18_181_818, noMicro: 2_500_000, question: null, status: "open", closeTime: null }] });
    const asked: string[] = [];
    server.use(
      contractHandler("getSaleQuote", ({ query }) => {
        asked.push(`${query.get("side")}:${query.get("sharesMicro")}`);
        return reply(200, saleQuote({ side: query.get("side") === "NO" ? "NO" : "YES", sharesMicro: Number(query.get("sharesMicro")) }));
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await sellForm();
    await user.click(form.getByRole("button", { name: "Sell all YES shares" }));
    expect(form.getByLabelText("Shares to sell")).toHaveValue("18.181818");
    await user.click(form.getByRole("button", { name: "Get a sale quote" }));
    await form.findByText(/returns about/);

    await user.click(form.getByRole("radio", { name: "NO (you hold 2.50)" }));
    expect(form.getByLabelText("Shares to sell")).toHaveAccessibleDescription("You hold 2.50 NO shares.");
    await user.click(form.getByRole("button", { name: "Sell all NO shares" }));
    expect(form.getByLabelText("Shares to sell")).toHaveValue("2.5");
    await user.click(form.getByRole("button", { name: "Get a sale quote" }));
    await waitFor(() => expect(asked).toEqual(["YES:18181818", "NO:2500000"]));
  });

  it.each([
    ["", "Enter a number of shares, for example 12 or 12.5 (at most six decimals)."],
    ["abc", "Enter a number of shares, for example 12 or 12.5 (at most six decimals)."],
    ["1.1234567", "Enter a number of shares, for example 12 or 12.5 (at most six decimals)."],
    ["0", "Enter a number of shares, for example 12 or 12.5 (at most six decimals)."],
    ["18.181819", "You hold 18.18 YES shares in this market."],
    ["1000", "You hold 18.18 YES shares in this market."],
  ])("refuses %j before any request", async (text, message) => {
    account();
    let quotes = 0;
    server.use(
      contractHandler("getSaleQuote", () => {
        quotes += 1;
        return reply(200, saleQuote());
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await sellForm();
    if (text !== "") await user.type(form.getByLabelText("Shares to sell"), text);
    await user.click(form.getByRole("button", { name: "Get a sale quote" }));
    expect(await form.findByText(message, { selector: "p.field-error" })).toBeInTheDocument();
    expect(quotes).toBe(0);
  });

  it("cannot sell what is not held: 'Sell all' of an empty side is off, and the shares of that side are refused", async () => {
    account();
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await sellForm();
    await user.click(form.getByRole("radio", { name: "NO (you hold 0.00)" }));
    expect(form.getByRole("button", { name: "Sell all NO shares" })).toBeDisabled();
    await user.type(form.getByLabelText("Shares to sell"), "1");
    await user.click(form.getByRole("button", { name: "Get a sale quote" }));
    expect(await form.findByText("You hold 0.00 NO shares in this market.", { selector: "p.field-error" })).toBeInTheDocument();
  });

  it("says that shares which would return nothing cannot be sold, and offers no sale", async () => {
    account();
    server.use(contractHandler("getSaleQuote", () => reply(200, saleQuote({ proceedsMicro: 0, averagePriceMicro: 0, costMicro: 10_000_000 }))));
    renderApp({ user: traderOidc(), path });
    const form = await getSaleQuote(typing(), "10");
    expect(await form.findByText("These shares would return nothing at the current prices, so they cannot be sold now.")).toBeInTheDocument();
    expect(form.queryByRole("button", { name: /^Sell 10/ })).not.toBeInTheDocument();
  });

  it("shows the new quote when the return fell below the minimum, and sells nothing", async () => {
    account();
    let quotes = 0;
    const bodies: unknown[] = [];
    server.use(
      contractHandler("getSaleQuote", () => {
        quotes += 1;
        return reply(200, quotes === 1 ? saleQuote() : saleQuote({ proceedsMicro: 5_000_000, averagePriceMicro: 500_000, costMicro: 5_000_000 }));
      }),
      contractHandler("sellShares", ({ body }) => {
        bodies.push(body);
        return reply(409, problem(409, "Proceeds below the minimum", { code: "proceeds_below_minimum", detail: "The sale would return 5.00 credits." }));
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getSaleQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Sell 10.00 YES shares" }));
    expect(await form.findByText(/The price moved while you were deciding, so nothing was sold/)).toBeInTheDocument();
    expect(form.getByText(/returns about/).closest(".quote")).toHaveTextContent("returns about 5.00 credits");
    expect(form.getByText(/returns about/).closest(".quote")).toHaveTextContent("less than 4.95 credits");
    expect(termValue(tradeRegion(), "YES shares you hold")).toBe("18.18");
    expect(bodies).toHaveLength(1);
  });

  it("repeats the same sale under the same key after an outage", async () => {
    account();
    const keys: (string | null)[] = [];
    server.use(
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      contractHandler("sellShares", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return keys.length === 1 ? unavailable("concurrent_update", 2) : reply(201, sale(), created);
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getSaleQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Sell 10.00 YES shares" }));
    expect(await form.findByRole("alert")).toHaveTextContent("Nothing was sold");
    await user.click(form.getByRole("button", { name: "Sell 10.00 YES shares" }));
    await form.findByText(/Sold/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("explains that the shares are not held, and reads the market again when it is not open", async () => {
    account();
    let reads = 0;
    let sales = 0;
    server.use(
      contractHandler("getMarket", () => reply(200, market(reads++ === 0 ? {} : { status: "closed" }))),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      contractHandler("sellShares", () => {
        sales += 1;
        return sales === 1
          ? reply(409, problem(409, "Not enough shares", { code: "insufficient_shares", detail: "You hold 4 shares.", heldMicro: 4_000_000 }))
          : reply(409, problem(409, "Market not open", { code: "market_not_open" }));
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getSaleQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Sell 10.00 YES shares" }));
    expect(await form.findByText(/You hold fewer shares of that side than you tried to sell\. Nothing was sold\./)).toBeInTheDocument();
    expect(reads).toBe(1);
    await user.click(form.getByRole("button", { name: "Sell 10.00 YES shares" }));
    expect(await screen.findByText("Trading in this market has stopped.")).toBeInTheDocument();
  });

  it("keeps the confirmation of a sale of everything in view even though no shares are held any more", async () => {
    account({ positions: [{ marketId: MARKET_ID, yesMicro: 10_000_000, noMicro: 0, question: null, status: "open", closeTime: null }] });
    server.use(
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      contractHandler("sellShares", () => reply(201, sale({ position: { marketId: MARKET_ID, yesMicro: 0, noMicro: 0 } }), created)),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await sellForm();
    await user.click(form.getByRole("button", { name: "Sell all YES shares" }));
    await user.click(form.getByRole("button", { name: "Get a sale quote" }));
    await user.click(await form.findByRole("button", { name: "Sell 10.00 YES shares" }));
    expect(await form.findByText(/Sold/)).toBeInTheDocument();
    expect(termValue(tradeRegion(), "YES shares you hold")).toBe("0.00");
  });

  it("shows a failed sale quote as a problem with advice, and reads the market again when it is not open", async () => {
    account();
    let reads = 0;
    let quotes = 0;
    server.use(
      contractHandler("getMarket", () => reply(200, market(reads++ === 0 ? {} : { status: "closed" }))),
      contractHandler("getSaleQuote", () => {
        quotes += 1;
        return quotes === 1
          ? reply(409, problem(409, "Not enough offers", { code: "insufficient_liquidity", detail: "The offers hold 3 shares.", maxSharesMicro: 3_000_000 }))
          : reply(409, problem(409, "Market not open", { code: "market_not_open" }));
      }),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getSaleQuote(user, "10");
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was sold");
    expect(alert).toHaveTextContent("The offers hold 3 shares.");
    expect(form.getByText(/The market cannot take that much right now/)).toBeInTheDocument();
    await user.click(form.getByRole("button", { name: "Get a sale quote" }));
    expect(await screen.findByText("Trading in this market has stopped.")).toBeInTheDocument();
  });

  it("shows why the new quote could not be had when the return fell and the quote cannot be read again", async () => {
    account();
    let quotes = 0;
    server.use(
      contractHandler("getSaleQuote", () => {
        quotes += 1;
        return quotes === 1 ? reply(200, saleQuote()) : unavailable("tenant_not_ready", 4);
      }),
      contractHandler("sellShares", () => reply(409, problem(409, "Proceeds below the minimum", { code: "proceeds_below_minimum" }))),
    );
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getSaleQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Sell 10.00 YES shares" }));
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was sold");
    expect(alert).toHaveTextContent("Try again in about 4 seconds.");
    expect(form.queryByRole("button", { name: /^Sell 10/ })).not.toBeInTheDocument();
  });
});

describe("the price chart after a trade (DM-17)", () => {
  function tradeThenWatch(ready: () => boolean, reads: { calls: number }) {
    account({ positions: [] });
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("placeOrder", () => reply(201, order(), created)),
      contractHandler("market-data:getMarket", ({ query }) => {
        if (!query.get("afterSequence")) return reply(200, dataMarket());
        reads.calls += 1;
        return ready() ? reply(200, dataMarket({ currentPriceYesMicro: 570_000, lastPriceYesMicro: 570_000, lastTradeSequence: 4, tradeCount: 4 })) : reply(409, problem(409, "Market data is updating", { code: "updating", detail: "Not there yet.", lastTradeSequence: 3 }));
      }),
    );
  }

  it("waits for the trade to reach market-data and then shows the new price", async () => {
    useFakeClock();
    const reads = { calls: 0 };
    tradeThenWatch(() => reads.calls >= 3, reads);
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Buy YES shares for 10 credits" }));
    expect(await screen.findByText("Waiting for your trade to reach the price chart...")).toBeInTheDocument();
    // The fake clock moves on while Testing Library waits (50 ms a step): two pauses of 500 ms need a longer wait than its default.
    await waitFor(() => expect(termValue(screen.getByRole("region", { name: "Price" }), "YES price")).toBe("0.57"), { timeout: UPDATE_WAIT_MS * 20 });
    expect(reads.calls).toBe(3);
    expect(screen.queryByText("Updating.")).not.toBeInTheDocument();
  });

  it("says 'updating' after about two seconds, says the trade is made, and offers 'Check again'", async () => {
    useFakeClock();
    let ready = false;
    const reads = { calls: 0 };
    tradeThenWatch(() => ready, reads);
    renderApp({ user: traderOidc(), path });
    const user = typing();
    const form = await getBuyQuote(user, "10");
    await user.click(await form.findByRole("button", { name: "Buy YES shares for 10 credits" }));
    expect(await screen.findByText("Updating.", undefined, { timeout: UPDATE_WAIT_MS * UPDATE_ATTEMPTS * 10 })).toBeInTheDocument();
    expect(screen.getByText(/Your trade is made and your balance is right\./)).toBeInTheDocument();
    expect(reads.calls).toBe(UPDATE_ATTEMPTS);
    // The balance and the position are already the ones of the trade.
    expect(termValue(tradeRegion(), "Your balance")).toBe("90.00 credits");

    ready = true;
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(termValue(screen.getByRole("region", { name: "Price" }), "YES price")).toBe("0.57"), { timeout: UPDATE_WAIT_MS * 20 });
    expect(screen.queryByText("Updating.")).not.toBeInTheDocument();
  });
});

describe("the advice for a refused trade", () => {
  const problemOf = (status: number, code: string | null) => new ApiError({ status, type: "urn:chance:problem:x", title: "Refused", code });

  it("names what to do for each code of the service", () => {
    expect(tradeAdvice(problemOf(409, "insufficient_credits"))).toEqual({ text: expect.stringContaining("not have enough credits"), walletLink: true });
    expect(tradeAdvice(problemOf(409, "insufficient_liquidity"))?.text).toContain("smaller amount");
    expect(tradeAdvice(problemOf(409, "insufficient_shares"))?.text).toContain("fewer shares");
    expect(tradeAdvice(problemOf(409, "market_not_open"))?.text).toContain("not open");
    expect(tradeAdvice(problemOf(503, "orders_paused"))?.text).toContain("paused");
    expect(tradeAdvice(problemOf(403, "forbidden"))?.text).toContain("Tenant admins do not trade");
  });

  it("has no advice for the rest, for a forbidden that is not a 403, or for an error that is no problem", () => {
    expect(tradeAdvice(problemOf(409, "price_limit_exceeded"))).toBeNull();
    expect(tradeAdvice(problemOf(400, null))).toBeNull();
    expect(tradeAdvice(problemOf(500, "forbidden"))).toBeNull();
    expect(tradeAdvice(new Error("boom"))).toBeNull();
  });
});
