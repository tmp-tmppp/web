import { describe, expect, it } from "vitest";
import { formatEuro } from "../src/lib/format";
import { formatPriceLimit, maxAveragePriceFor } from "../src/lib/units";

// Money is formatted from the integer, never from a floating-point quotient (ADR-055), and a price limit is shown at
// the precision the order really carries.

describe("formatEuro", () => {
  it.each([
    [0, "EUR 0.00"],
    [5, "EUR 0.05"],
    [1250, "EUR 12.50"],
    [1_000_000, "EUR 10,000.00"],
    [-1250, "EUR -12.50"],
    [Number.MAX_SAFE_INTEGER, "EUR 90,071,992,547,409.91"],
  ])("shows %i credits as %s", (amount, text) => {
    expect(formatEuro(amount)).toBe(text);
  });
});

describe("formatPriceLimit", () => {
  it("shows the limit of an order as a price, and never one above 0.99, which no open market has", () => {
    expect(formatPriceLimit(555_500)).toBe("0.56");
    expect(formatPriceLimit(606_000)).toBe("0.61");
    expect(formatPriceLimit(10_000)).toBe("0.01");
    expect(formatPriceLimit(990_000)).toBe("0.99");
    expect(formatPriceLimit(maxAveragePriceFor(990_000))).toBe("0.99");
    expect(formatPriceLimit(maxAveragePriceFor(995_000))).toBe("0.99");
    expect(formatPriceLimit(999_999)).toBe("0.99");
  });

  it("refuses what is no price", () => {
    expect(formatPriceLimit(-1)).toBe("-");
    expect(formatPriceLimit(1.5)).toBe("-");
    expect(formatPriceLimit(Number.NaN)).toBe("-");
  });
});
