import type { ApiClient, ApiResponse } from "./types";

/** Requests and answers of the payments service. The OpenAPI file of the service is the truth (contracts/payments.openapi.yaml). */

/** 1 credit = 1 EUR cent; one integer everywhere, no conversion in the service. */
export const AMOUNT_MIN = 1;
export const AMOUNT_MAX = 1_000_000;

export type DepositStatus = "pending" | "succeeded" | "failed";
export type DepositFailureReason = "declined" | "expired" | "provider_unavailable";

export interface Deposit {
  id: string;
  userId: string;
  amount: number;
  status: DepositStatus;
  /** The provider's payment page; null only while the provider has not answered yet. */
  checkoutUrl: string | null;
  failureReason: DepositFailureReason | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type WithdrawalStatus = "requested" | "debited" | "paid_out" | "rejected" | "failed" | "refunded";
export type WithdrawalReason = "insufficient_credits" | "trading_unavailable" | "forced" | "declined" | "payout_lost";

export interface Withdrawal {
  id: string;
  userId: string;
  amount: number;
  status: WithdrawalStatus;
  reason: WithdrawalReason | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** A withdrawal that no longer changes. "failed" is not final: trading refunds the credits and the status becomes "refunded". */
export function isFinalWithdrawal(withdrawal: Withdrawal): boolean {
  return withdrawal.status === "paid_out" || withdrawal.status === "rejected" || withdrawal.status === "refunded";
}

export function isFinalDeposit(deposit: Deposit): boolean {
  return deposit.status !== "pending";
}

/** The answer carries the status code (201 or 200) and the deposit. */
export const createDeposit = (api: ApiClient, amount: number, idempotencyKey: string): Promise<ApiResponse<Deposit>> =>
  api.request<Deposit>("/v1/deposits", { method: "POST", body: { amount }, idempotencyKey });

export const getDeposit = (api: ApiClient, id: string, signal?: AbortSignal): Promise<Deposit> =>
  api.get<Deposit>(`/v1/deposits/${encodeURIComponent(id)}`, undefined, signal);

/** 202 while the withdrawal is under way, 200 when the same key already finished it. */
export const createWithdrawal = (api: ApiClient, amount: number, idempotencyKey: string): Promise<ApiResponse<Withdrawal>> =>
  api.request<Withdrawal>("/v1/withdrawals", { method: "POST", body: { amount }, idempotencyKey });

export const getWithdrawal = (api: ApiClient, id: string, signal?: AbortSignal): Promise<Withdrawal> =>
  api.get<Withdrawal>(`/v1/withdrawals/${encodeURIComponent(id)}`, undefined, signal);

const DEPOSIT_MEMORY_KEY = "chance.deposit-id";

/** The id of the deposit the buyer is paying for, kept across the redirect to the payment page (sessionStorage only). */
export function rememberDeposit(id: string): void {
  try {
    window.sessionStorage.setItem(DEPOSIT_MEMORY_KEY, id);
  } catch {
    // Storage is blocked: the return page then explains that it cannot tell which deposit it is.
  }
}

export function recallDeposit(): string | null {
  try {
    return window.sessionStorage.getItem(DEPOSIT_MEMORY_KEY);
  } catch {
    return null;
  }
}
