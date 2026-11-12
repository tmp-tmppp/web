import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkRequest, checkResponse, CONTRACT_FILES, GRAPHQL_CONTRACT_FILE } from "./support/contract";
import type { SpecName } from "./support/contract";

// The mock API of every page test is only worth something when its checker rejects what the contracts forbid.
// These tests feed it valid and invalid requests and answers of all three services.

const BASE = "http://gateway.test";
const UUID = "3f2c1d3e-8a7b-4c1d-9e2f-5a6b7c8d9e0f";
const TIME = "2026-11-11T10:00:00Z";

function request(id: string, init: { url?: string; params?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}): string[] {
  const headers = new Headers({ Authorization: "Bearer token", "X-Correlation-Id": "c-1", ...init.headers });
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return checkRequest(id, { params: init.params ?? {}, url: init.url ?? `${BASE}/x`, headers, bodyText: init.body === undefined ? "" : JSON.stringify(init.body) });
}

function response(id: string, status: number, body?: unknown, headers: Record<string, string> = {}, contentType?: string): string[] {
  const type = contentType ?? (status >= 400 ? "application/problem+json" : "application/json");
  return checkResponse(id, { status, headers: new Headers({ "Content-Type": type, ...headers }), bodyText: body === undefined ? "" : JSON.stringify(body) });
}

const deposit = { id: UUID, userId: "u", amount: 1250, status: "pending", checkoutUrl: "https://pay.example.test/c", failureReason: null, expiresAt: TIME, createdAt: TIME, updatedAt: TIME, completedAt: null };
const problem = { type: "urn:chance:problem:x", title: "Not found", status: 404 };

describe("requests the contracts allow", () => {
  it("accepts a deposit, a page of tenants, an audit query and a join", () => {
    expect(request("createDeposit", { body: { amount: 1250 }, headers: { "Idempotency-Key": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" } })).toEqual([]);
    expect(request("listTenants", { url: `${BASE}/v1/tenants?limit=20&cursor=abc` })).toEqual([]);
    expect(request("listAuditEntries", { url: `${BASE}/v1/audit?type=a.b.v1%2Cc.d.v1&from=2026-11-01T00%3A00%3A00.000Z&actor=u1` })).toEqual([]);
    expect(request("acceptInvite", { params: { code: "x".repeat(20) } })).toEqual([]);
    expect(request("changeMemberRole", { params: { id: UUID, userId: "user-1" }, body: { role: "trader" } })).toEqual([]);
  });
});

describe("requests the contracts forbid are reported", () => {
  const key = { "Idempotency-Key": "k-1" };
  it.each([
    ["an amount of 0", { body: { amount: 0 }, headers: key }, "/amount"],
    ["an amount above 1 000 000", { body: { amount: 1_000_001 }, headers: key }, "/amount"],
    ["an amount that is text", { body: { amount: "12" }, headers: key }, "/amount"],
    ["a return URL in the body", { body: { amount: 5, successUrl: "https://x.test" }, headers: key }, "successUrl"],
    ["no Idempotency-Key", { body: { amount: 5 } }, "Idempotency-Key is missing"],
    ["an Idempotency-Key with a space", { body: { amount: 5 }, headers: { "Idempotency-Key": "a b" } }, "Idempotency-Key"],
    ["no body", { headers: key }, "the request body is missing"],
  ])("createDeposit with %s", (_name, init, expected) => {
    expect(request("createDeposit", init).join("\n")).toContain(expected);
  });

  it("reports the other kinds of mistakes", () => {
    expect(request("createTenant", { body: { name: "A", slug: "Bad Slug" } }).join("\n")).toContain("/slug");
    expect(request("createTenant", { body: { name: "A", slug: "ok-slug", extra: 1 } }).join("\n")).toContain("extra");
    expect(request("listTenants", { url: `${BASE}/v1/tenants?limit=101` }).join("\n")).toContain("limit");
    expect(request("listTenants", { url: `${BASE}/v1/tenants?size=5` }).join("\n")).toContain("query parameter size is not in the contract");
    expect(request("listTenants", { url: `${BASE}/v1/tenants?limit=1&limit=2` }).join("\n")).toContain("repeated");
    expect(request("acceptInvite", { params: { code: "short" } }).join("\n")).toContain("path code");
    expect(request("createInvite", { params: { id: "not-a-uuid" }, body: { role: "trader" } }).join("\n")).toContain("path id");
    expect(request("createInvite", { params: { id: UUID }, body: { role: "platform-admin" } }).join("\n")).toContain("/role");
    expect(request("getMe", { body: { a: 1 } }).join("\n")).toContain("no request body");
    expect(request("getMe", { headers: { Authorization: "" } }).join("\n")).toContain("bearer token is missing");
    expect(request("getMe", { headers: { "X-Correlation-Id": "" } }).join("\n")).toContain("X-Correlation-Id is missing");
    expect(request("listAuditEntries", { url: `${BASE}/v1/audit?from=yesterday` }).join("\n")).toContain("from");
    expect(request("listAuditEntries", { url: `${BASE}/v1/audit?type=${Array.from({ length: 21 }, (_, i) => `t${i}`).join(",")}` }).join("\n")).toContain("type");
  });
});

describe("answers the contracts allow", () => {
  it("accepts the documented answers", () => {
    expect(response("createDeposit", 201, deposit, { Location: `/v1/deposits/${UUID}` })).toEqual([]);
    expect(response("getMe", 200, { userId: "u", tenantId: null, role: null, tokenTenantId: null, tokenNeedsRefresh: false, identityPending: true })).toEqual([]);
    expect(response("verifyAuditChain", 200, { valid: false, entries: 12, brokenAtSeq: 7 })).toEqual([]);
    expect(response("getDeposit", 404, problem)).toEqual([]);
    expect(response("listTenants", 503, { ...problem, status: 503 }, { "Retry-After": "5" })).toEqual([]);
    expect(response("getMe", 401, { ...problem, status: 401 }, { "WWW-Authenticate": "Bearer" })).toEqual([]);
    expect(response("createWithdrawal", 409, { ...problem, status: 409, code: "insufficient_credits", withdrawalId: UUID })).toEqual([]);
  });
});

describe("answers the contracts forbid are reported", () => {
  it("reports every kind of mistake", () => {
    expect(response("createDeposit", 201, { ...deposit, amount: 0 }, { Location: "/x" }).join("\n")).toContain("/amount");
    expect(response("createDeposit", 201, { ...deposit, status: "done" }, { Location: "/x" }).join("\n")).toContain("/status");
    expect(response("createDeposit", 201, { ...deposit, extra: 1, checkoutUrl: undefined }, { Location: "/x" }).join("\n")).toContain("checkoutUrl");
    expect(response("createDeposit", 201, deposit).join("\n")).toContain("Location is missing");
    expect(response("getMe", 404, problem).join("\n")).toContain("the status is not in the contract");
    expect(response("getMe", 503, { ...problem, status: 503 }).join("\n")).toContain("Retry-After");
    expect(response("getMe", 503, { ...problem, status: 503 }, { "Retry-After": "soon" }).join("\n")).toContain("Retry-After");
    expect(response("getMe", 401, { ...problem, status: 401 }).join("\n")).toContain("WWW-Authenticate");
    expect(response("listTenants", 400, problem, {}, "application/json")).toEqual(expect.arrayContaining([expect.stringContaining("content type application/json")]));
    expect(response("getDeposit", 404, undefined).join("\n")).toContain("the body is missing");
    expect(response("verifyAuditChain", 200, { valid: false, entries: 3, brokenAtSeq: "7" }).join("\n")).toContain("brokenAtSeq");
    expect(response("listAuditEntries", 200, { items: [{ seq: 0 }], nextCursor: null }).join("\n")).toContain("/items/0");
    expect(response("listTenants", 200, { items: [], nextCursor: null }, {}, "application/json")).toEqual([]);
    expect(checkResponse("getMe", { status: 200, headers: new Headers({ "Content-Type": "application/json" }), bodyText: "{not json" })).toEqual(expect.arrayContaining([expect.stringContaining("not JSON")]));
    expect(checkResponse("getMe", { status: 200, headers: new Headers(), bodyText: "{}" })).toEqual(expect.arrayContaining([expect.stringContaining("content type")]));
    expect(checkResponse("healthLive", { status: 200, headers: new Headers({ "Content-Type": "application/json" }), bodyText: '{"status":"up"}' })).toEqual([]);
    expect(checkResponse("getMe", { status: 401, headers: new Headers({ "WWW-Authenticate": "Bearer" }), bodyText: "" })).toEqual(expect.arrayContaining([expect.stringContaining("content type")]));
  });

  it("knows only the operations of the contracts", () => {
    expect(() => request("noSuchOperation")).toThrow("No operation");
  });
});

describe("the copies of the contracts", () => {
  const names: SpecName[] = ["tenants", "payments", "audit", "markets", "trading", "market-data"];
  it.each(names)("%s equals the file the service keeps, when that file is next to this repository", (name) => {
    const original = resolve(dirname(fileURLToPath(import.meta.url)), `../../${name}/contracts/openapi.yaml`);
    if (!existsSync(original)) return;
    expect(readFileSync(CONTRACT_FILES[name], "utf8")).toBe(readFileSync(original, "utf8"));
  });
});

describe("the copy of the GraphQL schema of market-data", () => {
  const original = resolve(dirname(fileURLToPath(import.meta.url)), "../../market-data/contracts/graphql/schema.graphql");

  it("equals the file the service keeps, byte for byte, when that file is next to this repository", () => {
    if (!existsSync(original)) return;
    expect(readFileSync(GRAPHQL_CONTRACT_FILE, "utf8")).toBe(readFileSync(original, "utf8"));
  });

  it("is a schema with the three queries of requirement 17 and no mutation", () => {
    const text = readFileSync(GRAPHQL_CONTRACT_FILE, "utf8");
    expect(text).toMatch(/type Query \{[\s\S]*markets\([\s\S]*market\(id[\s\S]*history\(/);
    expect(text).not.toMatch(/type Mutation|type Subscription/);
  });
});

describe("the contracts of markets, trading and market-data", () => {
  const MARKET = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
  const key = { "Idempotency-Key": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" };

  it("accepts a quote, an order with its price limit, a sale and a batch of market-data", () => {
    expect(request("getQuote", { url: `${BASE}/v1/trading/quote?marketId=${MARKET}&side=YES&amount=10` })).toEqual([]);
    expect(request("placeOrder", { body: { marketId: MARKET, side: "NO", amount: 10, maxAveragePriceMicro: 555_500 }, headers: key })).toEqual([]);
    expect(request("sellShares", { body: { marketId: MARKET, side: "YES", sharesMicro: 10_000_000, minProceedsMicro: 5_445_000 }, headers: key })).toEqual([]);
    expect(request("market-data:listMarkets", { url: `${BASE}/v1/market-data/markets?ids=${MARKET},${MARKET}` })).toEqual([]);
    expect(request("resolveMarket", { params: { id: MARKET }, body: { outcome: "INVALID" } })).toEqual([]);
    expect(request("createMarket", { body: { question: "Will the office open by March?", closeTime: TIME, startingPrice: 0.35, fundingAmount: 1000 } })).toEqual([]);
  });

  it("reports what the three contracts forbid", () => {
    expect(request("getQuote", { url: `${BASE}/v1/trading/quote?marketId=${MARKET}&side=MAYBE&amount=10` }).join("\n")).toContain("side");
    expect(request("getQuote", { url: `${BASE}/v1/trading/quote?marketId=${MARKET}&side=YES&amount=1.5` }).join("\n")).toContain("amount");
    expect(request("getQuote", { url: `${BASE}/v1/trading/quote?side=YES&amount=10` }).join("\n")).toContain("marketId is missing");
    expect(request("placeOrder", { body: { marketId: MARKET, side: "YES", amount: 10 } }).join("\n")).toContain("Idempotency-Key is missing");
    expect(request("placeOrder", { body: { marketId: MARKET, side: "YES", amount: 0 }, headers: key }).join("\n")).toContain("/amount");
    expect(request("placeOrder", { body: { marketId: MARKET, side: "YES", amount: 10, maxAveragePriceMicro: 1_000_000 }, headers: key }).join("\n")).toContain("/maxAveragePriceMicro");
    expect(request("placeOrder", { body: { marketId: MARKET, side: "YES", amount: 10, price: 0.5 }, headers: key }).join("\n")).toContain("price");
    expect(request("resolveMarket", { params: { id: MARKET }, body: { outcome: "MAYBE" } }).join("\n")).toContain("/outcome");
    expect(request("createMarket", { body: { question: "Too short", closeTime: TIME, startingPrice: 0.35, fundingAmount: 1000 } }).join("\n")).toContain("/question");
    expect(request("createMarket", { body: { question: "Will the office open by March?", closeTime: TIME, startingPrice: 1.5, fundingAmount: 1000 } }).join("\n")).toContain("/startingPrice");
    expect(request("createMarket", { body: { question: "Will the office open by March?", closeTime: TIME, startingPrice: 0.35, fundingAmount: 10.5 } }).join("\n")).toContain("/fundingAmount");
    expect(request("market-data:getMarket", { params: { marketId: MARKET }, url: `${BASE}/x?afterSequence=0` }).join("\n")).toContain("afterSequence");
    expect(request("listMarkets", { url: `${BASE}/v1/markets?status=archived` }).join("\n")).toContain("status");
  });

  it("reports an answer that breaks a contract: an unknown side, a missing field, a status the contract does not list, a 503 without Retry-After", () => {
    const quote = { marketId: MARKET, side: "YES", amount: 10, sharesMicro: 18_181_818, costMicro: 10_000_000, averagePriceMicro: 550_000, worstPriceMicro: 550_000, fills: [{ priceMicro: 550_000, sharesMicro: 18_181_818, costMicro: 10_000_000 }], tradeSequence: 3, quotedAt: TIME };
    expect(response("getQuote", 200, quote)).toEqual([]);
    expect(response("getQuote", 200, { ...quote, side: "MAYBE" }).join("\n")).toContain("/side");
    expect(response("getQuote", 200, { ...quote, tradeSequence: undefined }).join("\n")).toContain("tradeSequence");
    expect(response("getQuote", 418, problem).join("\n")).toContain("the status is not in the contract");
    expect(response("placeOrder", 409, { ...problem, status: 409, code: "price_limit_exceeded" })).toEqual([]);
    expect(response("placeOrder", 503, { ...problem, status: 503, code: "orders_paused" }).join("\n")).toContain("Retry-After");
    expect(response("placeOrder", 201, { tradeId: MARKET }, { Location: "/v1/trading/orders/x" }).join("\n")).toContain("body");
    expect(response("market-data:getMarket", 409, { ...problem, status: 409, code: "updating", lastTradeSequence: 3 })).toEqual([]);
  });
});
