import type { MarketStatus, Outcome } from "../../api/markets";

/** The status of a market in plain words. */
export const STATUS_LABELS: Record<MarketStatus, string> = {
  draft: "Draft",
  opening: "Opening",
  open: "Open",
  closed: "Closed",
  resolved: "Resolved",
};

export const STATUS_HINTS: Record<MarketStatus, string> = {
  draft: "Not open yet: only tenant admins see it, and nobody can trade.",
  opening: "Its funding is being confirmed: it opens as soon as that is done.",
  open: "Traders can buy and sell shares.",
  closed: "Trading has stopped; the tenant admin resolves it next.",
  resolved: "The question is answered and the payouts are made.",
};

/** What an outcome means for the people who traded. */
export const OUTCOME_TEXT: Record<Outcome, string> = {
  YES: "YES: shares of YES were paid 1.00 credit each, shares of NO nothing.",
  NO: "NO: shares of NO were paid 1.00 credit each, shares of YES nothing.",
  INVALID: "INVALID: the question could not be answered. Every stake was refunded and the rest of the funding went back to its creator.",
};

/** "Resolved: YES", "Open", for a table cell. */
export function statusWithOutcome(status: MarketStatus, outcome: Outcome | null): string {
  return status === "resolved" && outcome ? `${STATUS_LABELS[status]}: ${outcome}` : STATUS_LABELS[status];
}

/** A market that people can trade in or that has been traded in, so market-data knows it. */
export function hasMarketData(status: MarketStatus): boolean {
  return status === "open" || status === "closed" || status === "resolved";
}
