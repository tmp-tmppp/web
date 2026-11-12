import { describe, expect, it } from "vitest";
import {
  describePrices,
  formatMicro,
  formatMicroCredits,
  formatPrice,
  formatShares,
  maxAveragePriceFor,
  microToDecimalText,
  minProceedsFor,
  noPrice,
  parsePriceCents,
  parseSharesText,
  positionValueMicro,
} from "../src/lib/units";
import { chartPoints, stairPath } from "../src/pages/markets/PriceChart";
import { bucket, history } from "./support/fixtures";

// Trading answers exact integers in micro-units (ADR-055). Everything shown is formatted from the integer, and nothing
// money-like is computed with floating point.

describe("formatting credits, prices and shares from micro-units", () => {
  it.each([
    [0, "0.00"],
    [1_000_000, "1.00"],
    [550_000, "0.55"],
    [12_345_678, "12.35"],
    [12_344_999, "12.34"],
    [12_345_000, "12.35"],
    [1_234_567_890_000, "1,234,567.89"],
    [9_007_199_254_740_991, "9,007,199,254.74"],
  ])("shows %i microcredits as %s", (micro, text) => {
    expect(formatMicro(micro)).toBe(text);
  });

  it("refuses what is no amount instead of showing a wrong number", () => {
    expect(formatMicro(-1)).toBe("-");
    expect(formatMicro(1.5)).toBe("-");
    expect(formatMicro(Number.NaN)).toBe("-");
    expect(formatMicroCredits(Number.NaN)).toBe("-");
    expect(formatShares(-5)).toBe("-");
    expect(microToDecimalText(-5)).toBe("");
  });

  it("writes credits and prices with two decimals", () => {
    expect(formatMicroCredits(90_000_000)).toBe("90.00 credits");
    expect(formatMicroCredits(1_000_000)).toBe("1.00 credits");
    expect(formatPrice(10_000)).toBe("0.01");
    expect(formatPrice(990_000)).toBe("0.99");
    expect(formatPrice(0)).toBe("0.00");
    expect(formatPrice(1_000_000)).toBe("1.00");
    expect(noPrice(550_000)).toBe(450_000);
    expect(describePrices(550_000)).toBe("YES 0.55, NO 0.45");
  });

  it("rounds shares down so the number shown is never more than is held", () => {
    expect(formatShares(18_181_818)).toBe("18.18");
    expect(formatShares(999_999)).toBe("0.99");
    expect(formatShares(10_000_000)).toBe("10.00");
  });

  it("writes the exact decimal of microshares for a field", () => {
    expect(microToDecimalText(12_345_678)).toBe("12.345678");
    expect(microToDecimalText(12_500_000)).toBe("12.5");
    expect(microToDecimalText(12_000_000)).toBe("12");
    expect(microToDecimalText(1)).toBe("0.000001");
    expect(microToDecimalText(0)).toBe("0");
  });
});

describe("reading what a person types", () => {
  it.each([
    ["12", 12_000_000],
    ["12.5", 12_500_000],
    ["0.000001", 1],
    [" 3 ", 3_000_000],
    ["999999999", 999_999_999_000_000],
  ])("reads %j shares as %i microshares", (text, micro) => {
    expect(parseSharesText(text)).toBe(micro);
  });

  it.each(["", "0", "0.0000001", "abc", "1e3", "-1", "12.", ".5", "1,5", "1000000000", "12 5"])("refuses %j shares", (text) => {
    expect(parseSharesText(text)).toBeNull();
  });

  it.each([
    ["0.35", 35],
    [".35", 35],
    ["0,35", 35],
    ["0.3", 30],
    ["0.05", 5],
    ["0.99", 99],
    ["0.01", 1],
  ])("reads the starting price %j as %i cents", (text, cents) => {
    expect(parsePriceCents(text)).toBe(cents);
  });

  it.each(["", "0", "0.00", "1", "1.00", "0.355", "35", "0.100", "abc", "-0.5"])("refuses the starting price %j", (text) => {
    expect(parsePriceCents(text)).toBeNull();
  });
});

describe("money arithmetic on integers", () => {
  it("values a position at the current price without floating point", () => {
    expect(positionValueMicro(18_181_818, 0, 550_000)).toBe(9_999_999);
    expect(positionValueMicro(10_000_000, 10_000_000, 550_000)).toBe(10_000_000);
    expect(positionValueMicro(0, 5_000_000, 1_000_000)).toBe(0);
    // The product is far beyond 2^53; BigInt keeps every digit.
    expect(positionValueMicro(9_007_199_254_740_991, 0, 990_000)).toBe(8_917_127_262_193_581);
    expect(positionValueMicro(0, 9_007_199_254_740_991, 990_000)).toBe(90_071_992_547_409);
  });

  it("allows a quoted average price one percent more, never above the contract's limit", () => {
    expect(maxAveragePriceFor(550_000)).toBe(555_500);
    expect(maxAveragePriceFor(550_001)).toBe(555_502);
    expect(maxAveragePriceFor(10_000)).toBe(10_100);
    expect(maxAveragePriceFor(1)).toBe(2);
    expect(maxAveragePriceFor(999_999)).toBe(999_999);
    expect(maxAveragePriceFor(990_000)).toBe(999_900);
  });

  it("accepts quoted proceeds one percent less, never below one microcredit", () => {
    expect(minProceedsFor(5_500_000)).toBe(5_445_000);
    expect(minProceedsFor(150)).toBe(149);
    expect(minProceedsFor(99)).toBe(99);
    expect(minProceedsFor(1)).toBe(1);
  });
});

describe("the points of the price chart", () => {
  it("starts at the price carried in from before the range and extends the last price to the end", () => {
    const points = chartPoints(
      history({
        previousCloseYesMicro: 500_000,
        buckets: [bucket({ start: "2026-11-11T09:00:00Z", closeYesMicro: 550_000 }), bucket({ start: "2026-11-11T10:00:00Z", closeYesMicro: 600_000 })],
        to: "2026-11-11T12:00:00Z",
      }),
    );
    expect(points.map((point) => [new Date(point.t).toISOString(), point.v, point.real])).toEqual([
      ["2026-11-11T09:00:00.000Z", 500_000, false],
      ["2026-11-11T09:00:00.000Z", 550_000, true],
      ["2026-11-11T10:00:00.000Z", 600_000, true],
      ["2026-11-11T12:00:00.000Z", 600_000, false],
    ]);
  });

  it("begins with the opening price of the first bucket when nothing came before it", () => {
    const points = chartPoints(history({ previousCloseYesMicro: null, buckets: [bucket({ openYesMicro: 400_000, closeYesMicro: 450_000 })], to: "2026-11-11T09:00:00Z" }));
    expect(points.map((point) => point.v)).toEqual([400_000, 450_000]);
  });

  it("has no points for an empty history", () => {
    expect(chartPoints(history({ buckets: [], previousCloseYesMicro: null }))).toEqual([]);
  });

  it("draws a staircase: the price holds until the next point", () => {
    const x = (t: number) => t;
    const y = (v: number) => v / 1000;
    expect(
      stairPath(
        [
          { t: 0, v: 500_000, real: true },
          { t: 10, v: 600_000, real: true },
          { t: 20, v: 400_000, real: false },
        ],
        x,
        y,
      ),
    ).toBe("M0.0 500.0 H10.0 V600.0 H20.0 V400.0");
    expect(stairPath([], x, y)).toBe("");
  });
});
