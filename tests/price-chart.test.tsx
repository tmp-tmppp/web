import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BATCH_MAX, getDataMarkets, getHistory, getHistoryPage, HISTORY_PAGE_MAX, HISTORY_PAGES_MAX, listDataMarkets } from "../src/api/market-data";
import { getMarket, listMarkets, openMarket, resolveMarket } from "../src/api/markets";
import { getPortfolio, getQuote, getSaleQuote, placeOrder, sellShares } from "../src/api/trading";
import type { ApiClient } from "../src/api/types";
import { chartPoints, PriceChart, stairPath } from "../src/pages/markets/PriceChart";
import { bucket, dataMarket, history, MARKET_ID } from "./support/fixtures";

const T09 = "2026-11-11T09:00:00Z";
const T10 = "2026-11-11T10:00:00Z";
const T11 = "2026-11-11T11:00:00Z";

describe("chartPoints", () => {
  it("carries the price from before the first bucket in, then one point per bucket, and the last price on to the end", () => {
    const points = chartPoints(history({ previousCloseYesMicro: 400_000, from: T09, to: T11, buckets: [bucket({ start: T10, closeYesMicro: 600_000 })] }));
    expect(points).toEqual([
      { t: Date.parse(T09), v: 400_000, real: false },
      { t: Date.parse(T10), v: 600_000, real: true },
      { t: Date.parse(T11), v: 600_000, real: false },
    ]);
  });

  it("starts at the opening price of the first bucket when nothing came before it and the bucket moved", () => {
    const points = chartPoints(history({ to: T10, buckets: [bucket({ start: T09, openYesMicro: 500_000, closeYesMicro: 550_000 })] }));
    expect(points.map((point) => [point.v, point.real])).toEqual([
      [500_000, true],
      [550_000, true],
      [550_000, false],
    ]);
  });

  it("makes one point of a bucket that did not move, and no carried point when the range ends where the last bucket starts", () => {
    const points = chartPoints(history({ to: T09, buckets: [bucket({ start: T09, openYesMicro: 500_000, closeYesMicro: 500_000 })] }));
    expect(points).toEqual([{ t: Date.parse(T09), v: 500_000, real: true }]);
  });

  it("has no point without a bucket and without an earlier price, and drops a bucket whose time is not a date", () => {
    expect(chartPoints(history({ buckets: [] }))).toEqual([]);
    expect(chartPoints(history({ to: T10, buckets: [bucket({ start: "not a date", openYesMicro: 500_000, closeYesMicro: 500_000 })] }))).toEqual([]);
  });
});

describe("stairPath", () => {
  it("goes right to the next time, then up or down to its price", () => {
    const points = [
      { t: 0, v: 500_000, real: true },
      { t: 10, v: 600_000, real: true },
      { t: 20, v: 400_000, real: false },
    ];
    expect(stairPath(points, (t) => t, (v) => v / 1000)).toBe("M0.0 500.0 H10.0 V600.0 H20.0 V400.0");
    expect(stairPath([], (t) => t, (v) => v)).toBe("");
  });
});

describe("PriceChart", () => {
  it("draws the chart as a named picture with a description, the price scale, and the numbers on request", async () => {
    render(<PriceChart history={history({ interval: "1h", buckets: [bucket({ openYesMicro: 500_000, closeYesMicro: 500_000, lowYesMicro: 500_000, highYesMicro: 500_000, trades: 1 })] })} />);
    const picture = screen.getByRole("img", { name: "YES price over time" });
    expect(picture).toHaveAccessibleDescription(/YES price from 0\.50 to 0\.50, lowest 0\.50, highest 0\.50, 1 point, from /);
    expect(within(picture).getAllByText(/^[01]\.\d\d$/).map((label) => label.textContent)).toEqual(["0.00", "0.25", "0.50", "0.75", "1.00"]);
    expect(picture.querySelector("path.chart-line")?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+ H[\d.]+ V[\d.]+/);
    expect(picture.querySelectorAll("circle.chart-dot")).toHaveLength(1);
    await userEvent.setup({ delay: null }).click(screen.getByText("Show the numbers"));
    expect(screen.getByRole("table", { name: "Price history in buckets of 1h" })).toBeInTheDocument();
  });

  it("says there is nothing to draw without a point", () => {
    render(<PriceChart history={history({ buckets: [] })} />);
    expect(screen.getByText("There are no price points yet.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("lists only the newest 50 buckets in the table and says so", async () => {
    const buckets = Array.from({ length: 60 }, (_, index) => bucket({ start: new Date(Date.parse(T09) + index * 3_600_000).toISOString(), closeYesMicro: 400_000 + index * 1000 }));
    render(<PriceChart history={history({ interval: "1h", to: new Date(Date.parse(T09) + 61 * 3_600_000).toISOString(), buckets })} />);
    await userEvent.setup({ delay: null }).click(screen.getByText("Show the numbers"));
    const table = screen.getByRole("table", { name: "Price history in buckets of 1h, the newest 50 of 60" });
    expect(within(table).getAllByRole("row")).toHaveLength(51);
  });

  it("shows a market whose price is still the previous one as a flat line over the whole range", () => {
    render(<PriceChart history={history({ previousCloseYesMicro: 430_000, from: T09, to: T11, buckets: [] })} />);
    expect(screen.getByRole("img", { name: "YES price over time" })).toHaveAccessibleDescription(/YES price from 0\.43 to 0\.43, lowest 0\.43, highest 0\.43, 0 points/);
  });
});

/** A client that answers from a script and remembers what it was asked. */
function scripted(answer: (path: string, query: Record<string, unknown> | undefined, call: number) => unknown) {
  const calls: { path: string; query: Record<string, unknown> | undefined }[] = [];
  const get = vi.fn((path: string, query?: Record<string, unknown>) => {
    calls.push({ path, query });
    return Promise.resolve(answer(path, query, calls.length));
  });
  const request = vi.fn((path: string, options?: Record<string, unknown>) => {
    calls.push({ path, query: options });
    return Promise.resolve({ status: 200, data: answer(path, options, calls.length), headers: new Headers(), correlationId: "c" });
  });
  const post = vi.fn((path: string, body?: unknown) => {
    calls.push({ path, query: { body } });
    return Promise.resolve(answer(path, { body }, calls.length));
  });
  return { api: { get, request, post, put: vi.fn() } as unknown as ApiClient, calls };
}

describe("the market-data requests", () => {
  it("asks for the prices of many markets in batches of at most 100 ids, each id once", async () => {
    const ids = Array.from({ length: 230 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const { api, calls } = scripted((_path, query) => ({ items: String(query?.["ids"]).split(",").map((id) => dataMarket({ marketId: id })), nextCursor: null }));
    const found = await getDataMarkets(api, [...ids, ...ids.slice(0, 10)]);
    expect(calls.map((call) => String(call.query?.["ids"]).split(",").length)).toEqual([BATCH_MAX, BATCH_MAX, 30]);
    expect(found).toHaveLength(230);
    expect(new Set(found.map((market) => market.marketId)).size).toBe(230);
    expect(await getDataMarkets(api, [])).toEqual([]);
  });

  it("reads a history that spans pages as one list, oldest first, and keeps the first page's range start", async () => {
    const { api, calls } = scripted((_path, query) => {
      const page = query?.["cursor"] ? 2 : 1;
      return history({ from: page === 1 ? T09 : T10, to: page === 1 ? T10 : T11, buckets: [bucket({ start: page === 1 ? T09 : T10 })], nextCursor: page === 1 ? "next" : null });
    });
    const whole = await getHistory(api, MARKET_ID, "1h", 7);
    expect(whole.buckets.map((entry) => entry.start)).toEqual([T09, T10]);
    expect(whole.from).toBe(T09);
    expect(whole.to).toBe(T11);
    expect(whole.nextCursor).toBeNull();
    expect(calls.map((call) => call.query)).toEqual([
      { interval: "1h", cursor: null, limit: HISTORY_PAGE_MAX, afterSequence: 7 },
      { interval: "1h", cursor: "next", limit: HISTORY_PAGE_MAX, afterSequence: 7 },
    ]);
    expect(calls[0]?.path).toBe(`/v1/market-data/markets/${MARKET_ID}/history`);
  });

  it("stops after a fixed number of pages and says there is more", async () => {
    const { api, calls } = scripted(() => history({ buckets: [bucket()], nextCursor: "more" }));
    const whole = await getHistory(api, MARKET_ID, "1m");
    expect(calls).toHaveLength(HISTORY_PAGES_MAX);
    expect(whole.buckets).toHaveLength(HISTORY_PAGES_MAX);
    expect(whole.nextCursor).toBe("more");
  });

  it("passes the filters of a list and one page of history through", async () => {
    const { api, calls } = scripted(() => ({ items: [], nextCursor: null, buckets: [] }));
    await listDataMarkets(api, { status: "open", cursor: "c1", limit: 20 });
    await listDataMarkets(api);
    await getHistoryPage(api, MARKET_ID, { interval: "5m" });
    expect(calls[0]).toEqual({ path: "/v1/market-data/markets", query: { status: "open", cursor: "c1", limit: 20 } });
    expect(calls[1]?.query).toEqual({ status: undefined, cursor: undefined, limit: undefined });
    expect(calls[2]?.query).toMatchObject({ interval: "5m" });
  });
});

describe("the markets and trading requests", () => {
  it("builds the addresses of a market from its id, escaped", async () => {
    const { api, calls } = scripted(() => ({}));
    await getMarket(api, "a/b");
    await listMarkets(api, { status: "draft" });
    await openMarket(api, "a/b");
    await resolveMarket(api, "a/b", "INVALID");
    expect(calls.map((call) => call.path)).toEqual(["/v1/markets/a%2Fb", "/v1/markets", "/v1/markets/a%2Fb/open", "/v1/markets/a%2Fb/resolve"]);
    expect(calls[1]?.query).toEqual({ status: "draft", cursor: undefined, limit: undefined });
    expect(calls[3]?.query).toEqual({ body: { outcome: "INVALID" } });
  });

  it("sends quotes as queries, orders and sales as bodies with the key, and the portfolio with its limit", async () => {
    const { api, calls } = scripted(() => ({}));
    await getQuote(api, MARKET_ID, "NO", 25);
    await getSaleQuote(api, MARKET_ID, "YES", 2_500_000);
    await placeOrder(api, { marketId: MARKET_ID, side: "NO", amount: 25, maxAveragePriceMicro: 500_000 }, "key-1");
    await sellShares(api, { marketId: MARKET_ID, side: "YES", sharesMicro: 2_500_000 }, "key-2");
    await getPortfolio(api);
    await getPortfolio(api, 5);
    expect(calls).toEqual([
      { path: "/v1/trading/quote", query: { marketId: MARKET_ID, side: "NO", amount: 25 } },
      { path: "/v1/trading/sale-quote", query: { marketId: MARKET_ID, side: "YES", sharesMicro: 2_500_000 } },
      { path: "/v1/trading/orders", query: { method: "POST", body: { marketId: MARKET_ID, side: "NO", amount: 25, maxAveragePriceMicro: 500_000 }, idempotencyKey: "key-1" } },
      { path: "/v1/trading/sales", query: { method: "POST", body: { marketId: MARKET_ID, side: "YES", sharesMicro: 2_500_000 }, idempotencyKey: "key-2" } },
      { path: "/v1/trading/portfolio", query: { limit: 50 } },
      { path: "/v1/trading/portfolio", query: { limit: 5 } },
    ]);
  });
});
