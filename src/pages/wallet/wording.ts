import type { DepositFailureReason, Withdrawal } from "../../api/payments";
import { formatAmount } from "../../lib/format";

/** Why a deposit failed, in plain words. */
export function depositFailureText(reason: DepositFailureReason | null): string {
  switch (reason) {
    case "declined":
      return "The payment was declined. No money was taken. Try again with another payment method.";
    case "expired":
      return "The payment page expired before the payment was made. No money was taken. Start a new deposit.";
    case "provider_unavailable":
      return "The payment provider could not be reached in time. No money was taken. Try again later.";
    case null:
      return "The deposit failed. No money was taken.";
  }
}

/** Where a withdrawal stands, in plain words (a requested one may still be waiting for trading to confirm). */
export function withdrawalStatusText(withdrawal: Withdrawal): string {
  const amount = formatAmount(withdrawal.amount);
  switch (withdrawal.status) {
    case "requested":
      return `Requested: ${amount}. We are taking the credits from your balance.`;
    case "debited":
      return `Credits taken: ${amount}. The payout is on its way.`;
    case "paid_out":
      return `Paid out: ${amount} has been sent.`;
    case "rejected":
      return withdrawal.reason === "trading_unavailable"
        ? "Rejected because trading was not available. No credits were taken. Try again later."
        : "Rejected because you do not have enough credits. No credits were taken.";
    case "failed":
      return "The payout failed. Your credits are being returned to your balance.";
    case "refunded":
      return "The payout failed and your credits were returned to your balance.";
  }
}
