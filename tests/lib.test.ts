import { describe, expect, it } from "vitest";
import { isFinalDeposit, isFinalWithdrawal, recallDeposit, rememberDeposit } from "../src/api/payments";
import { formatAmount, formatCredits, formatDateTime, formatEuro } from "../src/lib/format";
import { isSafeCheckoutUrl } from "../src/lib/navigation";
import { wholeNumberInRange } from "../src/lib/numbers";
import { deposit, withdrawal } from "./support/fixtures";

describe("whole numbers of a form field", () => {
  it.each([
    ["5", 1, 10, 5],
    [" 10 ", 1, 10, 10],
    ["1", 1, 10, 1],
    ["0", 1, 10, null],
    ["11", 1, 10, null],
    ["", 1, 10, null],
    ["1.5", 1, 10, null],
    ["1e3", 1, 10, null],
    ["-2", 1, 10, null],
    ["12abc", 1, 10, null],
    ["99999999999999999999", 1, 1e30, null],
  ])("reads %j between %i and %i as %j", (text, min, max, expected) => {
    expect(wholeNumberInRange(text, min, max)).toBe(expected);
  });
});

describe("amounts and moments", () => {
  it("shows credits and the same amount in euros (1 credit = 1 EUR cent)", () => {
    expect(formatCredits(1)).toBe("1 credit");
    expect(formatCredits(1250)).toBe("1,250 credits");
    expect(formatEuro(1250)).toBe("EUR 12.50");
    expect(formatEuro(5)).toBe("EUR 0.05");
    expect(formatEuro(1_000_000)).toBe("EUR 10,000.00");
    expect(formatAmount(1250)).toBe("1,250 credits (EUR 12.50)");
  });

  it("formats a moment and leaves an unreadable one as it is", () => {
    expect(formatDateTime("2026-11-11T10:00:00Z")).toMatch(/2026/);
    expect(formatDateTime("not a date")).toBe("not a date");
  });
});

describe("payment page addresses", () => {
  it.each([
    ["https://pay.example.test/checkout/cs_1", true],
    ["http://localhost:8082/checkout/cs_1", true],
    ["javascript:alert(1)", false],
    ["data:text/html,<p>x</p>", false],
    ["/relative", false],
    ["", false],
  ])("%s is safe: %s", (url, safe) => {
    expect(isSafeCheckoutUrl(url)).toBe(safe);
  });
});

describe("deposits and withdrawals", () => {
  it("knows which states are final: a failed payout is not, its refund is", () => {
    expect(isFinalDeposit(deposit())).toBe(false);
    expect(isFinalDeposit(deposit({ status: "succeeded" }))).toBe(true);
    expect(isFinalDeposit(deposit({ status: "failed" }))).toBe(true);
    for (const status of ["requested", "debited", "failed"] as const) expect(isFinalWithdrawal(withdrawal({ status }))).toBe(false);
    for (const status of ["paid_out", "rejected", "refunded"] as const) expect(isFinalWithdrawal(withdrawal({ status }))).toBe(true);
  });

  it("keeps the deposit id in sessionStorage only", () => {
    expect(recallDeposit()).toBeNull();
    rememberDeposit("abc");
    expect(window.sessionStorage.getItem("chance.deposit-id")).toBe("abc");
    expect(recallDeposit()).toBe("abc");
  });
});
