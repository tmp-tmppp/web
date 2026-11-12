import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPENING_POLL_MS } from "../src/pages/markets/MarketPage";
import { useFakeClock } from "./support/clock";
import { contractHandler, problem, reply, unavailable } from "./support/contract";
import { oidcUser } from "./support/fake-oidc";
import { market, MARKET_ID, order, portfolio, quietHandlers, quote, sale, saleQuote, TENANT_ID, tenantAdminOidc, traderOidc, USER_ID } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

// What the markets pages do when an answer is lost or comes from the gateway instead of the service (REL-03): an order
// or a sale that may have gone through is repeated under the same Idempotency-Key and never called "not made", the
// opening poll goes on after a short outage and can be started again by hand, and the keyboard focus does not fall to the
// page body after an action. A gateway answer is not part of the service's contract, so those handlers are plain msw.

const GATEWAY = "http://gateway.test";
const path = `/markets/${MARKET_ID}`;
const typing = () => userEvent.setup({ delay: null });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const buyForm = async () => within(await screen.findByRole("form", { name: "Buy shares" }));
const sellForm = async () => within(await screen.findByRole("form", { name: "Sell shares" }));
const created = { headers: { Location: "/v1/trading/orders/x" } };

beforeEach(() => server.use(...quietHandlers()));

// A problem body without a code of ours: what a gateway or a failing service sends when it names no refusal.
const gatewayProblem = (status: number, title: string) => HttpResponse.json(problem(status, title), { status, headers: { "Content-Type": "application/problem+json" } });
const internalError = () => HttpResponse.json(problem(500, "Internal error", { code: "internal_error" }), { status: 500, headers: { "Content-Type": "application/problem+json" } });
const htmlPage = (status: number) => new HttpResponse("<html>Gateway error</html>", { status, headers: { "Content-Type": "text/html" } });

async function quoteToBuy(amount = "10") {
  const user = typing();
  const form = await buyForm();
  await user.type(form.getByLabelText("Amount to spend, in credits"), amount);
  await user.click(form.getByRole("button", { name: "Get a quote" }));
  await form.findByRole("button", { name: `Buy YES shares for ${amount} credits` });
  return { user, form, buy: () => user.click(form.getByRole("button", { name: `Buy YES shares for ${amount} credits` })) };
}

async function quoteToSell(shares = "10") {
  const user = typing();
  const form = await sellForm();
  await user.type(form.getByLabelText("Shares to sell"), shares);
  await user.click(form.getByRole("button", { name: "Get a sale quote" }));
  await form.findByRole("button", { name: `Sell ${shares}.00 YES shares` });
  return { user, form, sell: () => user.click(form.getByRole("button", { name: `Sell ${shares}.00 YES shares` })) };
}

describe("an order whose answer may be lost", () => {
  it.each([
    ["a lost answer", () => HttpResponse.error()],
    ["a gateway timeout (504)", () => gatewayProblem(504, "Gateway Timeout")],
    ["a bad gateway page (502)", () => htmlPage(502)],
    ["an unhandled failure (500)", () => gatewayProblem(500, "Internal Server Error")],
  ])("repeats the same order under the same key after %s", async (_name, firstAnswer) => {
    const keys: (string | null)[] = [];
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      http.post(`${GATEWAY}/v1/trading/orders`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return keys.length === 1 ? firstAnswer() : HttpResponse.json(order(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const { form, buy } = await quoteToBuy();
    await buy();
    await form.findByRole("alert");
    await buy();
    await form.findByText(/Bought/);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    ["a lost answer", () => HttpResponse.error()],
    ["a gateway timeout (504)", () => gatewayProblem(504, "Gateway Timeout")],
  ])("repeats the same sale under the same key after %s", async (_name, firstAnswer) => {
    const keys: (string | null)[] = [];
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      http.post(`${GATEWAY}/v1/trading/sales`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return keys.length === 1 ? firstAnswer() : HttpResponse.json(sale(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const { form, sell } = await quoteToSell();
    await sell();
    await form.findByRole("alert");
    await sell();
    await form.findByText(/Sold/);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    ["a lost answer", () => HttpResponse.error()],
    ["a 500 internal_error", () => internalError()],
  ])("sends the same key for the same order after a reload that followed %s", async (_name, firstAnswer) => {
    const keys: (string | null)[] = [];
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      http.post(`${GATEWAY}/v1/trading/orders`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return keys.length === 1 ? firstAnswer() : HttpResponse.json(order(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const first = await quoteToBuy();
    await first.buy();
    await first.form.findByRole("alert");
    // A reload: the page is gone, the tab's sessionStorage stays.
    cleanup();
    renderApp({ user: traderOidc(), path });
    const second = await quoteToBuy();
    await second.buy();
    await second.form.findByText(/Bought/);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    // The order went through: the entry is gone, so the next order is a new attempt.
    expect(Object.keys(window.sessionStorage).filter((name) => name.startsWith("chance.pending-key."))).toEqual([]);
  });

  it("sends a new key after a reload when the order changed, and the same key for the same sale", async () => {
    const orders: (string | null)[] = [];
    const sales: (string | null)[] = [];
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      // The quote is for the amount that was asked for.
      contractHandler("getQuote", ({ request }) => reply(200, quote({ amount: Number(new URL(request.url).searchParams.get("amount")) }))),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      http.post(`${GATEWAY}/v1/trading/orders`, ({ request }) => {
        orders.push(request.headers.get("Idempotency-Key"));
        return orders.length === 1 ? HttpResponse.error() : HttpResponse.json(order(), { status: 201, ...created });
      }),
      http.post(`${GATEWAY}/v1/trading/sales`, ({ request }) => {
        sales.push(request.headers.get("Idempotency-Key"));
        return sales.length === 1 ? HttpResponse.error() : HttpResponse.json(sale(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const buying = await quoteToBuy("10");
    await buying.buy();
    await buying.form.findByRole("alert");
    const selling = await quoteToSell();
    await selling.sell();
    await selling.form.findByRole("alert");
    cleanup();
    renderApp({ user: traderOidc(), path });
    // Another amount is another order; the same sale is the same request.
    const buyingMore = await quoteToBuy("20");
    await buyingMore.buy();
    await buyingMore.form.findByText(/Bought/);
    const sellingAgain = await quoteToSell();
    await sellingAgain.sell();
    await sellingAgain.form.findByText(/Sold/);
    expect(orders).toHaveLength(2);
    expect(orders[1]).not.toBe(orders[0]);
    expect(sales).toHaveLength(2);
    expect(sales[1]).toBe(sales[0]);
  });

  it("starts a new attempt after an answer that settles the order (a refusal), so the next order is a new one", async () => {
    const keys: (string | null)[] = [];
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      http.post(`${GATEWAY}/v1/trading/orders`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return keys.length === 1
          ? HttpResponse.json(problem(409, "Not enough credits", { code: "insufficient_credits", detail: "You have 5 credits.", withdrawableCredits: 5 }), { status: 409, headers: { "Content-Type": "application/problem+json" } })
          : HttpResponse.json(order(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const { form, buy } = await quoteToBuy();
    await buy();
    await form.findByRole("alert");
    await buy();
    await form.findByText(/Bought/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("does not say 'Nothing was bought' when the order may have gone through, and tells the person to press the same button again", async () => {
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      http.post(`${GATEWAY}/v1/trading/orders`, () => HttpResponse.error()),
    );
    renderApp({ user: traderOidc(), path });
    const { form, buy } = await quoteToBuy();
    await buy();
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("We do not know yet whether the order went through");
    expect(alert).not.toHaveTextContent("Nothing was bought");
    expect(form.getByText(/Press the same button again/)).toBeInTheDocument();
    // The quote stays, so that the same button is still there.
    expect(form.getByRole("button", { name: "Buy YES shares for 10 credits" })).toBeEnabled();
  });

  it("does not say 'Nothing was sold' when the sale may have gone through", async () => {
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      http.post(`${GATEWAY}/v1/trading/sales`, () => gatewayProblem(504, "Gateway Timeout")),
    );
    renderApp({ user: traderOidc(), path });
    const { form, sell } = await quoteToSell();
    await sell();
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("We do not know yet whether the sale went through");
    expect(alert).not.toHaveTextContent("Nothing was sold");
    expect(form.getByText(/Press the same button again/)).toBeInTheDocument();
  });

  it("still says nothing was bought when the service refused or was not asked (409, 503)", async () => {
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("placeOrder", () => reply(409, problem(409, "Market not open", { code: "market_not_open", detail: "The market closed." }))),
    );
    renderApp({ user: traderOidc(), path });
    const { form, buy } = await quoteToBuy();
    await buy();
    expect(await form.findByRole("alert")).toHaveTextContent("Nothing was bought");
  });
});

describe("the price limit shown with a quote", () => {
  it("never reads as a price above 0.99, which no open market has", async () => {
    server.use(contractHandler("getQuote", () => reply(200, quote({ averagePriceMicro: 990_000, worstPriceMicro: 990_000 }))));
    renderApp({ user: traderOidc(), path });
    const { form } = await quoteToBuy();
    const quoted = form.getByText(/you get about/).closest(".quote");
    expect(quoted).toHaveTextContent("The order is refused if the average price would go above 0.99.");
  });
});

describe("a double click on the button that places the order", () => {
  it("sends one order for a double click and one sale for a double click", async () => {
    const orders: (string | null)[] = [];
    const sales: (string | null)[] = [];
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      contractHandler("placeOrder", ({ request }) => {
        orders.push(request.headers.get("Idempotency-Key"));
        return reply(201, order(), created);
      }),
      contractHandler("sellShares", ({ request }) => {
        sales.push(request.headers.get("Idempotency-Key"));
        return reply(201, sale(), created);
      }),
    );
    renderApp({ user: traderOidc(), path });
    const buying = await quoteToBuy();
    await buying.user.dblClick(buying.form.getByRole("button", { name: "Buy YES shares for 10 credits" }));
    await buying.form.findByText(/Bought/);
    const selling = await quoteToSell();
    await selling.user.dblClick(selling.form.getByRole("button", { name: "Sell 10.00 YES shares" }));
    await selling.form.findByText(/Sold/);
    expect(orders).toHaveLength(1);
    expect(sales).toHaveLength(1);
  });

  it("sends one order for two clicks that arrive before the page has rendered again", async () => {
    const keys: (string | null)[] = [];
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("placeOrder", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return reply(keys.length === 1 ? 201 : 200, order(), created);
      }),
    );
    renderApp({ user: traderOidc(), path });
    const { form } = await quoteToBuy();
    const button = form.getByRole("button", { name: "Buy YES shares for 10 credits" });
    fireEvent.click(button);
    fireEvent.click(button);
    await form.findByText(/Bought/);
    // Whatever reached the service, it was one order: every request carried the same key.
    expect(new Set(keys).size).toBe(1);
  });
});

describe("the opening poll", () => {
  const opening = { status: "opening" as const, openedAt: null, createdBy: USER_ID };
  const opened = { status: "open" as const, openedAt: "2026-11-11T10:00:00Z", createdBy: USER_ID };

  it("stops reading when the person leaves the page", async () => {
    useFakeClock();
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => {
        reads += 1;
        return reply(200, market(opening));
      }),
      contractHandler("listMarkets", () => reply(200, { items: [], nextCursor: null })),
    );
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByText(/This page follows it/)).toBeInTheDocument();
    await advance(OPENING_POLL_MS);
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    await typing().click(screen.getByRole("link", { name: "All markets" }));
    expect(await screen.findByRole("heading", { name: "Markets", level: 1 })).toBeInTheDocument();
    const atLeaving = reads;
    await advance(OPENING_POLL_MS * 20);
    expect(reads).toBe(atLeaving);
  });

  it("makes no read and no state update after the page is unmounted while a read is in flight", async () => {
    useFakeClock();
    let reads = 0;
    let release: (() => void) | null = null;
    const errors = vi.spyOn(console, "error");
    server.use(
      contractHandler("getMarket", async () => {
        reads += 1;
        if (reads === 2) await new Promise<void>((resolve) => (release = resolve));
        return reply(200, market(reads >= 2 ? opened : opening));
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByText(/This page follows it/)).toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    cleanup();
    (release as (() => void) | null)?.();
    await advance(OPENING_POLL_MS * 20);
    expect(reads).toBe(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ["502", () => htmlPage(502)],
    ["504", () => gatewayProblem(504, "Gateway Timeout")],
  ])("goes on following the market after one gateway %s", async (_status, failure) => {
    useFakeClock();
    let reads = 0;
    server.use(
      http.get(`${GATEWAY}/v1/markets/${MARKET_ID}`, () => {
        reads += 1;
        if (reads === 2) return failure();
        return HttpResponse.json(market(reads >= 3 ? opened : opening), { status: 200 });
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    expect(await screen.findByText("The status could not be read")).toBeInTheDocument();
    await advance(OPENING_POLL_MS * 3);
    expect(await screen.findByRole("button", { name: "Close the market" })).toBeInTheDocument();
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("offers 'Check again' when a failure that will not pass has stopped the polling, and follows the market again from there", async () => {
    useFakeClock();
    let reads = 0;
    server.use(
      http.get(`${GATEWAY}/v1/markets/${MARKET_ID}`, () => {
        reads += 1;
        if (reads === 2) return gatewayProblem(500, "Internal Server Error");
        return HttpResponse.json(market(reads >= 3 ? opened : opening), { status: 200 });
      }),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const again = await screen.findByRole("button", { name: "Check again" });
    expect(screen.getByText("The status could not be read")).toBeInTheDocument();
    // Stopped for good: no further read happens by itself.
    await advance(OPENING_POLL_MS * 10);
    expect(reads).toBe(2);
    expect(screen.queryByText(/updates by itself/)).not.toBeInTheDocument();
    await typing().click(again);
    expect(await screen.findByRole("button", { name: "Close the market" })).toBeInTheDocument();
  });
});

describe("the keyboard focus after an action", () => {
  it("moves to the message that says what happened after a buy and after a sale", async () => {
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getQuote", () => reply(200, quote())),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      contractHandler("placeOrder", () => reply(201, order(), created)),
      contractHandler("sellShares", () => reply(201, sale(), created)),
    );
    renderApp({ user: traderOidc(), path });
    const buying = await quoteToBuy();
    await buying.buy();
    const bought = await buying.form.findByText(/Bought/);
    await waitFor(() => expect(bought).toHaveFocus());
    const selling = await quoteToSell();
    await selling.sell();
    const sold = await selling.form.findByText(/Sold/);
    await waitFor(() => expect(sold).toHaveFocus());
  });

  it("moves to the message after the admin closes a market", async () => {
    server.use(contractHandler("closeMarket", () => reply(200, market({ status: "closed", closedAt: "2026-11-11T10:00:00Z", closedBy: USER_ID, version: 3 }))));
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Close the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, close the market" }));
    const done = await screen.findByText("The market is closed. Resolve it when the answer is known.");
    await waitFor(() => expect(done).toHaveFocus());
  });
});

describe("an admin action whose answer may be lost", () => {
  type MarketOverrides = Parameters<typeof market>[0];
  const SETTLED = "2026-11-11T10:00:00Z";
  interface Case {
    name: string;
    /** What the service did: the word in "We do not know yet whether the market was ...". */
    word: string;
    before: MarketOverrides;
    trigger: string;
    confirm: string;
    route: string;
    answer: () => Response;
    /** The market as the service has it when the page reads it again (the action had gone through). */
    after: MarketOverrides;
    shows: () => Promise<HTMLElement>;
  }
  // No answer at all, a gateway timeout and a server error with no problem body: the three ways an answer is lost.
  const cases: Case[] = [
    {
      name: "close",
      word: "closed",
      before: { status: "open" },
      trigger: "Close the market",
      confirm: "Yes, close the market",
      route: "close",
      answer: () => HttpResponse.error(),
      after: { status: "closed", closedAt: SETTLED, closedBy: USER_ID, version: 3 },
      shows: () => screen.findByRole("button", { name: "Resolve as YES" }),
    },
    {
      name: "resolve",
      word: "resolved",
      before: { status: "closed", closedAt: SETTLED, closedBy: USER_ID },
      trigger: "Resolve as YES",
      confirm: "Yes, resolve as YES",
      route: "resolve",
      answer: () => gatewayProblem(504, "Gateway Timeout"),
      after: { status: "resolved", outcome: "YES", resolvedAt: SETTLED },
      shows: () => screen.findByText("This market is resolved: there is nothing left to do."),
    },
    {
      name: "open",
      word: "opened",
      before: { status: "draft", openedAt: null },
      trigger: "Open the market",
      confirm: "Yes, open the market",
      route: "open",
      answer: () => htmlPage(500),
      after: { status: "open" },
      shows: () => screen.findByRole("button", { name: "Close the market" }),
    },
    {
      name: "open (a 500 internal_error)",
      word: "opened",
      before: { status: "draft", openedAt: null },
      trigger: "Open the market",
      confirm: "Yes, open the market",
      route: "open",
      answer: () => internalError(),
      after: { status: "open" },
      shows: () => screen.findByRole("button", { name: "Close the market" }),
    },
  ];

  it.each(cases)("does not say the action was not done when $name may have gone through: it says it does not know yet, and reads the market again", async (scenario) => {
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => reply(200, market(reads++ === 0 ? scenario.before : scenario.after))),
      http.post(`${GATEWAY}/v1/markets/${MARKET_ID}/${scenario.route}`, scenario.answer),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: scenario.trigger }));
    await user.click(screen.getByRole("button", { name: scenario.confirm }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`We do not know yet whether the market was ${scenario.word}`);
    expect(alert).not.toHaveTextContent("The action was not done");
    expect(screen.getByText("It may have been done. The page reads the market again: check its status above before you try again.")).toBeInTheDocument();
    // The market was read again, so the page shows what the service has now, and the message stays beside it.
    await scenario.shows();
    expect(reads).toBe(2);
    expect(screen.getByRole("alert")).toHaveTextContent(`whether the market was ${scenario.word}`);
  });

  it("still says the action was not done when the service answered that it did not take it on (503), and reads the market again", async () => {
    let reads = 0;
    server.use(
      contractHandler("getMarket", () => {
        reads += 1;
        return reply(200, market());
      }),
      http.post(`${GATEWAY}/v1/markets/${MARKET_ID}/close`, () => unavailable("market_busy")),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Close the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, close the market" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The action was not done");
    expect(alert).not.toHaveTextContent("We do not know yet");
    expect(screen.queryByText(/It may have been done/)).not.toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("clears the doubt when the same action is tried again and works", async () => {
    let attempts = 0;
    server.use(
      http.post(`${GATEWAY}/v1/markets/${MARKET_ID}/close`, () => (attempts++ === 0 ? HttpResponse.error() : HttpResponse.json(market({ status: "closed", closedAt: SETTLED, closedBy: USER_ID, version: 3 })))),
    );
    renderApp({ user: tenantAdminOidc(), path });
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Close the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, close the market" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We do not know yet whether the market was closed");
    await user.click(await screen.findByRole("button", { name: "Close the market" }));
    await user.click(screen.getByRole("button", { name: "Yes, close the market" }));
    expect(await screen.findByText("The market is closed. Resolve it when the answer is known.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// The price limit of a buy (and the least proceeds of a sale) is part of the request that the service checks with the
// Idempotency-Key, and a reload loses the quote it comes from. A person's own order moves the price, so after a lost answer
// the new quote has another limit: another request, which would be a second order. The form therefore offers the earlier
// request exactly as it was sent, under its own key.
const pendingEntries = () => Object.keys(window.sessionStorage).filter((name) => name.startsWith("chance.pending-key."));
const sentBody = async (request: Request) => ({ key: request.headers.get("Idempotency-Key"), body: (await request.clone().json()) as unknown });

describe("a reload after a lost answer, when the quote the request was made from is gone", () => {
  /** An order whose first answer is lost; its own effect moved the price, so the quote after the reload is dearer. */
  function lostOrder(answers: (() => Response)[] = [], priceMoved = true) {
    const sent: { key: string | null; body: unknown }[] = [];
    const counts = { quotes: 0 };
    server.use(
      contractHandler("getQuote", () => reply(200, ++counts.quotes === 1 || !priceMoved ? quote() : quote({ averagePriceMicro: 560_000, worstPriceMicro: 560_000 }))),
      http.post(`${GATEWAY}/v1/trading/orders`, async ({ request }) => {
        sent.push(await sentBody(request));
        const answer = answers[sent.length - 1];
        return answer ? answer() : sent.length === 1 ? HttpResponse.error() : HttpResponse.json(order(), { status: 201, ...created });
      }),
    );
    return { sent, counts };
  }

  async function lostFirstOrder() {
    renderApp({ user: traderOidc(), path });
    const first = await quoteToBuy();
    await first.buy();
    await first.form.findByRole("alert");
    // A reload: the page is gone, the tab's sessionStorage stays.
    cleanup();
    renderApp({ user: traderOidc(), path });
    return buyForm();
  }

  it("offers the earlier order exactly as it was sent and sends it again under the same key, without asking for a new quote", async () => {
    const { sent, counts } = lostOrder();
    const form = await lostFirstOrder();
    const earlier = await form.findByRole("group", { name: "Earlier order" });
    expect(earlier).toHaveTextContent("An order you sent earlier may have gone through");
    expect(earlier).toHaveTextContent("buy YES shares for 10 credits");
    await typing().click(within(earlier).getByRole("button", { name: "Send the same order again" }));
    await form.findByText(/Bought/);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toMatchObject({ amount: 10, maxAveragePriceMicro: 555_500 });
    // The same key and the same body, whatever the price is now.
    expect(sent[1]).toEqual(sent[0]);
    expect(counts.quotes).toBe(1);
    expect(form.queryByRole("group", { name: "Earlier order" })).not.toBeInTheDocument();
    expect(pendingEntries()).toEqual([]);
  });

  it("keeps offering it, and points at its button, when sending it again gets no answer either", async () => {
    const { sent } = lostOrder([() => HttpResponse.error(), () => HttpResponse.error()]);
    const form = await lostFirstOrder();
    const user = typing();
    await user.click(await form.findByRole("button", { name: "Send the same order again" }));
    expect(await form.findByRole("alert")).toHaveTextContent("We do not know yet whether the order went through");
    expect(form.getByText(/Use the button in the box above to send the same request again/)).toBeInTheDocument();
    await user.click(form.getByRole("button", { name: "Send the same order again" }));
    await form.findByText(/Bought/);
    expect(sent.map((entry) => entry.key)).toEqual([sent[0]?.key, sent[0]?.key, sent[0]?.key]);
  });

  it("forgets the earlier order on the person's decision, and the next order is a new request", async () => {
    const { sent } = lostOrder();
    const form = await lostFirstOrder();
    await typing().click(await form.findByRole("button", { name: "Forget this order" }));
    expect(form.queryByRole("group", { name: "Earlier order" })).not.toBeInTheDocument();
    expect(form.getByText(/The earlier order was forgotten/)).toBeInTheDocument();
    expect(pendingEntries()).toEqual([]);
    const next = await quoteToBuy();
    await next.buy();
    await form.findByText(/Bought/);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
    expect(sent[1]?.body).toMatchObject({ maxAveragePriceMicro: 565_600 });
  });

  it.each([
    ["of another market", { marketId: "another-market", side: "YES", amount: 10, maxAveragePriceMicro: 555_500 }],
    ["with a side that is neither YES nor NO", { marketId: MARKET_ID, side: "MAYBE", amount: 10, maxAveragePriceMicro: 555_500 }],
    ["with an amount that is not a whole number of credits", { marketId: MARKET_ID, side: "YES", amount: 0.5, maxAveragePriceMicro: 555_500 }],
    ["with a price limit that is not a number", { marketId: MARKET_ID, side: "YES", amount: 10, maxAveragePriceMicro: "555500" }],
    ["that is not an object", "buy YES"],
  ])("offers nothing when the storage holds an order %s (the storage is the person's to edit)", async (_name, payload) => {
    lostOrder();
    renderApp({ user: traderOidc(), path });
    const first = await quoteToBuy();
    await first.buy();
    await first.form.findByRole("alert");
    const [name] = pendingEntries();
    const stored = JSON.parse(window.sessionStorage.getItem(name ?? "") ?? "{}") as { attempts: { payload?: unknown }[] };
    stored.attempts = stored.attempts.map((attempt) => ({ ...attempt, payload }));
    window.sessionStorage.setItem(name ?? "", JSON.stringify(stored));
    cleanup();
    renderApp({ user: traderOidc(), path });
    const form = await buyForm();
    expect(form.getByRole("button", { name: "Get a quote" })).toBeEnabled();
    expect(form.queryByRole("group", { name: "Earlier order" })).not.toBeInTheDocument();
  });

  it("offers nothing when the storage holds a sale that is not one", async () => {
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      http.post(`${GATEWAY}/v1/trading/sales`, () => HttpResponse.error()),
    );
    renderApp({ user: traderOidc(), path });
    const first = await quoteToSell();
    await first.sell();
    await first.form.findByRole("alert");
    const [name] = pendingEntries();
    const stored = JSON.parse(window.sessionStorage.getItem(name ?? "") ?? "{}") as { attempts: { payload?: unknown }[] };
    stored.attempts = stored.attempts.map((attempt) => ({ ...attempt, payload: { marketId: MARKET_ID, side: "YES", sharesMicro: "10000000", minProceedsMicro: 5_445_000 } }));
    window.sessionStorage.setItem(name ?? "", JSON.stringify(stored));
    cleanup();
    renderApp({ user: traderOidc(), path });
    const form = await sellForm();
    expect(form.getByRole("button", { name: "Get a sale quote" })).toBeEnabled();
    expect(form.queryByRole("group", { name: "Earlier sale" })).not.toBeInTheDocument();
  });

  it("forgets the earlier sale on the person's decision", async () => {
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      http.post(`${GATEWAY}/v1/trading/sales`, () => HttpResponse.error()),
    );
    renderApp({ user: traderOidc(), path });
    const first = await quoteToSell();
    await first.sell();
    await first.form.findByRole("alert");
    cleanup();
    renderApp({ user: traderOidc(), path });
    const form = await sellForm();
    await typing().click(await form.findByRole("button", { name: "Forget this sale" }));
    expect(form.queryByRole("group", { name: "Earlier sale" })).not.toBeInTheDocument();
    expect(form.getByText(/The earlier sale was forgotten/)).toBeInTheDocument();
    expect(pendingEntries()).toEqual([]);
  });

  it("does not offer an order that has a settling answer", async () => {
    lostOrder([() => HttpResponse.json(problem(409, "Not enough credits", { code: "insufficient_credits" }), { status: 409, headers: { "Content-Type": "application/problem+json" } })]);
    const form = await lostFirstOrder();
    expect(form.queryByRole("group", { name: "Earlier order" })).not.toBeInTheDocument();
  });

  it("offers the earlier sale exactly as it was sent and sends it again under the same key, without asking for a new quote", async () => {
    const sent: { key: string | null; body: unknown }[] = [];
    const counts = { quotes: 0 };
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getSaleQuote", () => reply(200, ++counts.quotes === 1 ? saleQuote() : saleQuote({ proceedsMicro: 5_300_000, averagePriceMicro: 530_000 }))),
      http.post(`${GATEWAY}/v1/trading/sales`, async ({ request }) => {
        sent.push(await sentBody(request));
        return sent.length === 1 ? HttpResponse.error() : HttpResponse.json(sale(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const first = await quoteToSell();
    await first.sell();
    await first.form.findByRole("alert");
    cleanup();
    renderApp({ user: traderOidc(), path });
    const form = await sellForm();
    const earlier = await form.findByRole("group", { name: "Earlier sale" });
    expect(earlier).toHaveTextContent("A sale you sent earlier may have gone through");
    await typing().click(within(earlier).getByRole("button", { name: "Send the same sale again" }));
    await form.findByText(/Sold/);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toMatchObject({ sharesMicro: 10_000_000, minProceedsMicro: 5_445_000 });
    expect(sent[1]).toEqual(sent[0]);
    expect(counts.quotes).toBe(1);
    expect(pendingEntries()).toEqual([]);
  });

  it("does not offer an earlier order of another person who signs in in the same tab, and sends that person's order under a key of their own", async () => {
    // The price did not move, so the second person's order is the very request of the first: only the key can tell them apart.
    const { sent } = lostOrder([], false);
    renderApp({ user: traderOidc(), path });
    const first = await quoteToBuy();
    await first.buy();
    await first.form.findByRole("alert");
    cleanup();
    renderApp({ user: oidcUser({ sub: "b2c3d4e5-0000-4000-8000-000000000002", roles: ["trader"], organization: [TENANT_ID] }), path });
    const form = await buyForm();
    expect(form.queryByRole("group", { name: "Earlier order" })).not.toBeInTheDocument();
    const second = await quoteToBuy();
    await second.buy();
    await form.findByText(/Bought/);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
  });
});

describe("a success status whose body the app cannot read", () => {
  const proxyPage = () => new HttpResponse("<html>Welcome to the guest network</html>", { status: 201, headers: { "Content-Type": "text/html" } });

  it("does not say nothing was bought, and sends the same order again under the same key", async () => {
    const sent: (string | null)[] = [];
    server.use(
      contractHandler("getQuote", () => reply(200, quote())),
      http.post(`${GATEWAY}/v1/trading/orders`, ({ request }) => {
        sent.push(request.headers.get("Idempotency-Key"));
        return sent.length === 1 ? proxyPage() : HttpResponse.json(order(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const { form, buy } = await quoteToBuy();
    await buy();
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("We do not know yet whether the order went through");
    expect(alert).not.toHaveTextContent("Nothing was bought");
    await buy();
    await form.findByText(/Bought/);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("does not say nothing was sold, and sends the same sale again under the same key", async () => {
    const sent: (string | null)[] = [];
    server.use(
      contractHandler("getPortfolio", () => reply(200, portfolio())),
      contractHandler("getSaleQuote", () => reply(200, saleQuote())),
      http.post(`${GATEWAY}/v1/trading/sales`, ({ request }) => {
        sent.push(request.headers.get("Idempotency-Key"));
        return sent.length === 1 ? proxyPage() : HttpResponse.json(sale(), { status: 201, ...created });
      }),
    );
    renderApp({ user: traderOidc(), path });
    const { form, sell } = await quoteToSell();
    await sell();
    const alert = await form.findByRole("alert");
    expect(alert).toHaveTextContent("We do not know yet whether the sale went through");
    expect(alert).not.toHaveTextContent("Nothing was sold");
    await sell();
    await form.findByText(/Sold/);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });
});
