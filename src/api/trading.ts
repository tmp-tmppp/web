import type { ApiClient, ApiResponse } from "./types";
import type { Outcome } from "./markets";

/**
 * Requests and answers of the trading service: quotes, buy orders, sale quotes, sales and the portfolio. The OpenAPI file
 * of the service is the truth (contracts/trading.openapi.yaml). `amount` is whole credits; every other quantity is an
 * exact integer in micro-units (ADR-055): `...Micro` money is microcredits, shares are microshares, a price is
 * microcredits per share. Orders and sales are for traders only (a tenant admin gets 403).
 */

export type Side = "YES" | "NO";
export const SIDES: readonly Side[] = ["YES", "NO"];

/** Whole credits per order: the contract's limits (the service's ORDER_AMOUNT_MAX may set a lower one). */
export const ORDER_AMOUNT_MIN = 1;
export const ORDER_AMOUNT_MAX = 1_000_000;

export interface Fill {
  priceMicro: number;
  sharesMicro: number;
  costMicro: number;
}

export interface Quote {
  marketId: string;
  side: Side;
  /** Whole credits. */
  amount: number;
  sharesMicro: number;
  costMicro: number;
  /** ceil(cost x 10^6 / shares): what one share costs on average. */
  averagePriceMicro: number;
  worstPriceMicro: number;
  fills: Fill[];
  tradeSequence: number;
  quotedAt: string;
}

export interface OrderRequest {
  marketId: string;
  side: Side;
  amount: number;
  /** DM-18 price protection: fill only if the average price stays at or below it. */
  maxAveragePriceMicro?: number;
}

export interface Position {
  marketId: string;
  yesMicro: number;
  noMicro: number;
}

export interface Order {
  tradeId: string;
  marketId: string;
  side: Side;
  amount: number;
  sharesMicro: number;
  costMicro: number;
  averagePriceMicro: number;
  worstPriceMicro: number;
  fills: Fill[];
  /** DM-17: the market's trade sequence after this trade; market-data answers `afterSequence` with it. */
  tradeSequence: number;
  executedAt: string;
  balanceMicro: number;
  position: Position;
}

export interface SaleQuote {
  marketId: string;
  side: Side;
  sharesMicro: number;
  proceedsMicro: number;
  /** floor(proceeds x 10^6 / shares): what one share returns on average. */
  averagePriceMicro: number;
  costMicro: number;
  fills: Fill[];
  tradeSequence: number;
  quotedAt: string;
}

export interface SaleRequest {
  marketId: string;
  side: Side;
  sharesMicro: number;
  minProceedsMicro?: number;
}

export interface Sale {
  tradeId: string;
  marketId: string;
  side: Side;
  sharesMicro: number;
  proceedsMicro: number;
  averagePriceMicro: number;
  costMicro: number;
  fills: Fill[];
  tradeSequence: number;
  executedAt: string;
  balanceMicro: number;
  position: Position;
}

/** trading's copy of the market; `funded` means funded, MarketOpened not processed yet. */
export type TradingStatus = "funded" | "open" | "closed" | "resolved";

export interface PortfolioPosition extends Position {
  question: string | null;
  status: TradingStatus | null;
  closeTime: string | null;
}

export interface TradeEntry {
  tradeId: string;
  marketId: string;
  kind: "buy" | "sale";
  side: Side;
  sharesMicro: number;
  costMicro: number;
  /** A sale's proceeds; null for a buy. */
  proceedsMicro: number | null;
  averagePriceMicro: number;
  tradeSequence: number;
  executedAt: string;
}

export type PayoutKind = "winnings" | "refund" | "returned";

export interface PayoutEntry {
  marketId: string;
  kind: PayoutKind;
  amountMicro: number;
  outcome: Outcome | null;
  paidAt: string;
}

export interface FundedMarket {
  marketId: string;
  question: string | null;
  status: TradingStatus | null;
  fundingMicro: number | null;
  returnedMicro: number | null;
  settledAt: string | null;
}

export interface Portfolio {
  balanceMicro: number;
  /** Whole credits a withdrawal may take now. */
  withdrawableCredits: number;
  positions: PortfolioPosition[];
  recentTrades: TradeEntry[];
  payouts: PayoutEntry[];
  /** Tenant admins only; null for traders. */
  fundedMarkets: FundedMarket[] | null;
}

export const getQuote = (api: ApiClient, marketId: string, side: Side, amount: number, signal?: AbortSignal): Promise<Quote> =>
  api.get<Quote>("/v1/trading/quote", { marketId, side, amount }, signal);

/** 201 when bought now, 200 when the same Idempotency-Key already bought: the answer is the same order, nothing was bought again. */
export const placeOrder = (api: ApiClient, order: OrderRequest, idempotencyKey: string): Promise<ApiResponse<Order>> =>
  api.request<Order>("/v1/trading/orders", { method: "POST", body: order, idempotencyKey });

export const getSaleQuote = (api: ApiClient, marketId: string, side: Side, sharesMicro: number, signal?: AbortSignal): Promise<SaleQuote> =>
  api.get<SaleQuote>("/v1/trading/sale-quote", { marketId, side, sharesMicro }, signal);

export const sellShares = (api: ApiClient, sale: SaleRequest, idempotencyKey: string): Promise<ApiResponse<Sale>> =>
  api.request<Sale>("/v1/trading/sales", { method: "POST", body: sale, idempotencyKey });

export const PORTFOLIO_ENTRIES = 50;

export const getPortfolio = (api: ApiClient, limit: number = PORTFOLIO_ENTRIES, signal?: AbortSignal): Promise<Portfolio> =>
  api.get<Portfolio>("/v1/trading/portfolio", { limit }, signal);
