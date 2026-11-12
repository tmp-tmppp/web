import { readFileSync } from "node:fs";
import { buildSchema, isObjectType, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import { createApiClient } from "../src/api/client";
import { bucketsIn, getMarketOverviewPage, historiesQuery, historyPageSize, KNOWN_GRAPHQL_CODES, MARKETS_QUERY, OVERVIEW_PAGE_SIZE, OVERVIEW_WINDOWS, problemOfGraphqlError, windowStart } from "../src/api/market-data-graphql";
import type { OverviewWindow, WindowHistory } from "../src/api/market-data-graphql";
import { formatPriceChange } from "../src/lib/units";
import { sparklinePath, trendOf, trendText } from "../src/pages/markets/overview-trend";
import { GRAPHQL_CONTRACT_FILE } from "./support/contract";
import { marketDataSchema, MAX_COMPLEXITY, MAX_DEPTH, queryCost, queryDepth } from "./support/graphql";

// The documents of the market overview are checked against contracts/market-data.graphql, the copy of the schema the service
// keeps (tests/contract-validator.test.ts keeps the copy equal to the original): they must validate, stay under the limits
// of the service, and name no tenant. The rest is the arithmetic of the change and the drawing of the sparkline.

const SDL = readFileSync(GRAPHQL_CONTRACT_FILE, "utf8");
const errorsOf = (document: string, schema = marketDataSchema) => validate(schema, parse(document)).map((error) => error.message);

/** The variables a window sends with the histories of `count` markets. */
function historyVariables(window: OverviewWindow, count: number): Record<string, unknown> {
  const variables: Record<string, unknown> = { interval: window.interval, from: "2026-11-10T10:00:00.000Z", first: historyPageSize(window) };
  for (let index = 0; index < count; index += 1) variables[`id${index}`] = `market-${index}`;
  return variables;
}

describe("the query documents against the schema", () => {
  it.each([
    ["the markets of a page", MARKETS_QUERY],
    ["the history of one market", historiesQuery(1)],
    ["the histories of a whole page", historiesQuery(OVERVIEW_PAGE_SIZE)],
  ])("%s is valid", (_name, document) => {
    expect(errorsOf(document)).toEqual([]);
  });

  it("is not satisfied by anything: a field the schema does not have, a variable of the wrong type and a missing argument are reported", () => {
    expect(errorsOf("{ markets { items { marketIdd } } }")).toEqual([expect.stringContaining('Cannot query field "marketIdd"')]);
    expect(errorsOf("query($n: String) { markets(first: $n) { items { marketId } } }").join()).toContain("$n");
    expect(errorsOf("{ history(interval: ONE_HOUR) { from } }").join()).toContain("marketId");
    expect(errorsOf("{ history(marketId: \"x\", interval: EVERY_HOUR) { from } }").join()).toContain("EVERY_HOUR");
  });

  it("fails against a schema that has lost a field the page reads, so a drifted copy cannot pass quietly", () => {
    const drifted = buildSchema(SDL.replace("  previousCloseYesMicro: Int\n", ""));
    expect(errorsOf(historiesQuery(1), drifted).join()).toContain("previousCloseYesMicro");
    expect(errorsOf(MARKETS_QUERY, buildSchema(SDL.replace("  lastTradeAt: DateTime\n", ""))).join()).toContain("lastTradeAt");
  });

  it("uses no tenant, in its text or in the schema: the tenant comes from the token", () => {
    expect([MARKETS_QUERY, historiesQuery(OVERVIEW_PAGE_SIZE)].join("\n")).not.toMatch(/tenant/i);
    const names = Object.values(marketDataSchema.getTypeMap())
      .filter(isObjectType)
      .flatMap((type) => Object.values(type.getFields()).flatMap((field) => [field.name, ...field.args.map((argument) => argument.name)]));
    expect(names.filter((name) => /tenant/i.test(name))).toEqual([]);
  });

  it("builds one aliased history per market, each with its own variable, and nothing for no market", () => {
    const document = historiesQuery(3);
    expect(document).toContain("query MarketSparklines($interval: HistoryInterval!, $from: DateTime!, $first: Int!, $id0: ID!, $id1: ID!, $id2: ID!)");
    for (const index of [0, 1, 2]) expect(document).toContain(`h${index}: history(marketId: $id${index}, interval: $interval, from: $from, first: $first)`);
    expect(document).not.toContain("h3:");
  });
});

describe("the limits of the service", () => {
  it("measures the cost like the service: a full page of 500 buckets is 4029 and a full page of 100 markets 1824 (README 'GraphQL')", () => {
    const buckets = "history(marketId: \"x\", first: 500) { marketId interval from to previousCloseYesMicro buckets { start openYesMicro highYesMicro lowYesMicro closeYesMicro volumeMicro trades } pageInfo { hasNextPage endCursor } }";
    expect(queryCost(parse(`{ ${buckets} }`))).toBe(4029);
    const markets =
      "markets(first: 100) { items { marketId question status closeTime openedAt closedAt resolvedAt outcome startingPriceYesMicro lastPriceYesMicro currentPriceYesMicro volumeMicro tradeCount lastTradeSequence lastTradeAt version updatedAt } pageInfo { hasNextPage endCursor } }";
    expect(queryCost(parse(`{ ${markets} }`))).toBe(1824);
    expect(queryDepth(parse(`{ ${markets} }`))).toBe(3);
  });

  it.each(OVERVIEW_WINDOWS.map((window) => [window.label, window] as const))("keeps a page of %s histories under 60 % of the complexity limit, within the depth limit and the query length", (_label, window) => {
    const document = historiesQuery(OVERVIEW_PAGE_SIZE);
    const cost = queryCost(parse(document), historyVariables(window, OVERVIEW_PAGE_SIZE));
    expect(cost).toBeLessThanOrEqual(MAX_COMPLEXITY * 0.6);
    expect(queryDepth(parse(document))).toBeLessThanOrEqual(MAX_DEPTH);
    expect(document.length).toBeLessThan(10_000);
    expect(queryCost(parse(MARKETS_QUERY), { first: OVERVIEW_PAGE_SIZE, after: null })).toBeLessThan(200);
  });

  it("would be refused for a page of 20 markets over 7 days: the page size is what keeps the query under the limit", () => {
    const week = OVERVIEW_WINDOWS.find((window) => window.id === "7d") as OverviewWindow;
    expect(queryCost(parse(historiesQuery(20)), historyVariables(week, 20))).toBeGreaterThan(MAX_COMPLEXITY);
  });

  it("holds every bucket of a window in one page: one per interval, and one more for the partial first bucket", () => {
    expect(OVERVIEW_WINDOWS.map(bucketsIn)).toEqual([25, 43]);
  });

  it("asks for one bucket more than a window holds, for a browser clock up to one interval behind the server's", () => {
    expect(OVERVIEW_WINDOWS.map(historyPageSize)).toEqual([26, 44]);
  });
});

describe("the start of a window", () => {
  const [day, week] = OVERVIEW_WINDOWS as [OverviewWindow, OverviewWindow];
  it.each([
    ["24 hours at half past ten", day, "2026-11-11T10:30:00.000Z", "2026-11-10T11:00:00.000Z"],
    ["24 hours on the hour", day, "2026-11-11T10:00:00.000Z", "2026-11-10T10:00:00.000Z"],
    ["7 days at ten, buckets of four hours from midnight UTC", week, "2026-11-03T10:00:00.000Z", "2026-10-27T12:00:00.000Z"],
  ] as const)("is a bucket start inside the window: %s", (_name, window, now, start) => {
    expect(new Date(windowStart(window, Date.parse(now))).toISOString()).toBe(start);
  });
});

describe("a refusal of the whole request", () => {
  // As market-data sends it: an HTTP error status and { errors: [{ message, extensions: { code, status } }] }, no problem.
  const refusing = (status: number, code: string, headers: Record<string, string> = {}) =>
    createApiClient({
      baseUrl: "https://app.example",
      getAccessToken: () => Promise.resolve("token"),
      fetchImpl: () =>
        Promise.resolve(new Response(JSON.stringify({ errors: [{ message: "an internal sentence", extensions: { code, status } }] }), { status, headers: { "Content-Type": "application/json", ...headers } })),
    });
  const refusalOf = async (status: number, code: string, headers?: Record<string, string>): Promise<ApiError> => {
    const failure: unknown = await getMarketOverviewPage(refusing(status, code, headers), null, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    return failure as ApiError;
  };

  it.each([
    [400, "complexity_limit_exceeded", "This page and market data do not agree"],
    [400, "graphql_validation_failed", "This page and market data do not agree"],
    [401, "unauthorized", "You are not signed in"],
    [403, "forbidden", "Not allowed"],
    [503, "identity_provider_unavailable", "Sign-in is not available right now"],
  ] as const)("words HTTP %i %s by its code", async (status, code, title) => {
    const error = await refusalOf(status, code);
    expect(error).toMatchObject({ status, code, title });
    expect(error.message).not.toContain("an internal sentence");
  });

  it("keeps the wait of the Retry-After header", async () => {
    expect((await refusalOf(503, "identity_provider_unavailable", { "Retry-After": "9" })).retryAfterSeconds).toBe(9);
  });
});

describe("the words of the error codes", () => {
  const entry = (code: string | undefined, status: number | undefined, more: Record<string, unknown> = {}) => ({ message: "an internal sentence", extensions: { ...(code ? { code } : {}), ...(status ? { status } : {}), ...more } });

  it.each([
    "validation_failed",
    "not_found",
    "updating",
    "history_paused",
    "tenant_not_ready",
    "forbidden",
    "unauthorized",
    "identity_provider_unavailable",
    "bad_request",
    "internal_error",
    "graphql_syntax_error",
    "graphql_validation_failed",
    "depth_limit_exceeded",
    "complexity_limit_exceeded",
    "introspection_disabled",
    "method_not_allowed",
  ])("has words for %s, takes its status and shows no message of the service", (code) => {
    expect(KNOWN_GRAPHQL_CODES).toContain(code);
    const problem = problemOfGraphqlError(entry(code, 409));
    expect(problem).toBeInstanceOf(ApiError);
    expect([problem.code, problem.status]).toEqual([code, 409]);
    expect(problem.title).not.toBe("");
    expect(`${problem.title} ${problem.detail}`).not.toContain("internal sentence");
  });

  it("gives a code it does not know the general words of its status, and an error without extensions those of a server failure", () => {
    expect(problemOfGraphqlError(entry("new_code", 404)).title).toBe("The request was not accepted");
    expect(problemOfGraphqlError(entry("new_code", 502)).title).toBe("Something went wrong on the server");
    expect(problemOfGraphqlError({ message: "x" })).toMatchObject({ status: 500, code: null, title: "Something went wrong on the server" });
  });

  it("carries how long to wait and the invalid fields, and drops what is not a number or a field", () => {
    const waiting = problemOfGraphqlError(entry("tenant_not_ready", 503, { retryAfterSeconds: 12 }), "corr-1");
    expect([waiting.retryAfterSeconds, waiting.correlationId]).toEqual([12, "corr-1"]);
    expect(problemOfGraphqlError(entry("tenant_not_ready", 503, { retryAfterSeconds: "soon" })).retryAfterSeconds).toBeNull();
    const invalid = problemOfGraphqlError(entry("validation_failed", 400, { fields: [{ field: "first", message: "too big" }, { field: "after" }, "nope", null] }));
    expect(invalid.fieldErrors).toEqual([{ field: "first", message: "too big" }]);
    expect(problemOfGraphqlError(entry("not_found", 404, { fields: [{ field: "first", message: "too big" }] })).fieldErrors).toEqual([]);
  });
});

const history =(overrides: Partial<WindowHistory> = {}): WindowHistory => ({
  from: "2026-11-10T10:00:00Z",
  to: "2026-11-11T10:00:00Z",
  previousCloseYesMicro: 500_000,
  buckets: [{ start: "2026-11-11T07:00:00Z", openYesMicro: 500_000, highYesMicro: 520_000, lowYesMicro: 480_000, closeYesMicro: 520_000 }],
  ...overrides,
});

describe("the change over a window", () => {
  it("is the difference of two integers, from the price before the window when there is one", () => {
    const trend = trendOf(history(), 550_000);
    expect(trend).toMatchObject({ baselineMicro: 500_000, currentMicro: 550_000, changeMicro: 50_000, lowMicro: 480_000, highMicro: 550_000 });
    expect(formatPriceChange(trend?.changeMicro ?? 0)).toBe("+0.05");
  });

  it("starts at the opening price of the first bucket when the market opened inside the window", () => {
    const trend = trendOf(history({ previousCloseYesMicro: null }), 450_000);
    expect(trend).toMatchObject({ baselineMicro: 500_000, changeMicro: -50_000 });
    expect(formatPriceChange(trend?.changeMicro ?? 0)).toBe("-0.05");
  });

  it("is exact where floating point is not: 0.7 - 0.6 is 0.09999999999999998, and a move of one microcredit is 0.00", () => {
    expect(0.7 - 0.6).not.toBe(0.1);
    const trend = trendOf(history({ previousCloseYesMicro: 600_000, buckets: [] }), 700_000);
    expect(trend?.changeMicro).toBe(100_000);
    expect(formatPriceChange(100_000)).toBe("+0.10");
    expect(trendOf(history({ previousCloseYesMicro: 333_333, buckets: [] }), 333_334)?.changeMicro).toBe(1);
  });

  it.each([
    [0, "0.00"],
    [1, "0.00"],
    [-1, "0.00"],
    [4_999, "0.00"],
    [5_000, "+0.01"],
    [-5_000, "-0.01"],
    [10_000, "+0.01"],
    [-120_000, "-0.12"],
    [1_000_000, "+1.00"],
    [-1_000_000, "-1.00"],
    [Number.NaN, "-"],
    [0.5, "-"],
  ])("writes %s microcredits as %s, with the sign in the text", (delta, text) => {
    expect(formatPriceChange(delta)).toBe(text);
  });

  it("says nothing about a market whose history holds no point before the window and no bucket in it", () => {
    expect(trendOf(history({ previousCloseYesMicro: null, buckets: [] }), 550_000)).toBeNull();
  });

  it("carries the price in, goes to every closing price and ends at the current price", () => {
    const trend = trendOf(history(), 550_000);
    expect(trend?.points).toEqual([
      { t: Date.parse("2026-11-10T10:00:00Z"), v: 500_000, real: false },
      { t: Date.parse("2026-11-11T07:00:00Z"), v: 520_000, real: true },
      { t: Date.parse("2026-11-11T10:00:00Z"), v: 550_000, real: false },
    ]);
    // The opening price of a market opened in the window is a point of its own when the first bucket moved.
    expect(trendOf(history({ previousCloseYesMicro: null }), 520_000)?.points[0]).toEqual({ t: Date.parse("2026-11-11T07:00:00Z"), v: 500_000, real: true });
  });

  it("says in words where the price went, or that it did not move", () => {
    expect(trendText(trendOf(history(), 550_000) as NonNullable<ReturnType<typeof trendOf>>, "the last 24 hours")).toBe("YES price over the last 24 hours: from 0.50 to 0.55, lowest 0.48, highest 0.55.");
    const flat = trendOf(history({ previousCloseYesMicro: 550_000, buckets: [{ start: "2026-11-11T07:00:00Z", openYesMicro: 550_000, highYesMicro: 550_000, lowYesMicro: 550_000, closeYesMicro: 550_000 }] }), 550_000);
    expect(trendText(flat as NonNullable<ReturnType<typeof trendOf>>, "the last 7 days")).toBe("YES price over the last 7 days: unchanged at 0.55.");
  });
});

describe("the sparkline path", () => {
  const point = (t: number, v: number) => ({ t, v, real: true });

  it("is empty without points", () => {
    expect(sparklinePath([])).toBe("");
  });

  it("puts a higher price higher up, inside the frame", () => {
    expect(sparklinePath([point(0, 400_000), point(10, 600_000)])).toBe("M2.0 30.0 H118.0 V2.0");
    expect(sparklinePath([point(0, 600_000), point(10, 400_000)])).toBe("M2.0 2.0 H118.0 V30.0");
  });

  it("draws a line that did not move in the middle of the frame", () => {
    expect(sparklinePath([point(0, 550_000), point(10, 550_000)])).toBe("M2.0 16.0 H118.0 V16.0");
  });

  it("draws a move of one cent on a scale of ten cents, so it does not look like a crash", () => {
    expect(sparklinePath([point(0, 540_000), point(10, 550_000)])).toBe("M2.0 17.4 H118.0 V14.6");
  });

  it("keeps a scale of ten cents inside 0.00 to 1.00 at the ends of the range", () => {
    expect(sparklinePath([point(0, 1_000_000), point(10, 1_000_000)])).toBe("M2.0 2.0 H118.0 V2.0");
    expect(sparklinePath([point(0, 0), point(10, 0)])).toBe("M2.0 30.0 H118.0 V30.0");
  });

  it("puts a single point at the left edge", () => {
    expect(sparklinePath([point(5, 500_000)])).toBe("M2.0 16.0");
  });
});
