/**
 * Units of trading and market-data (ADR-055): money, shares and prices travel as exact integers in micro-units
 * (1 credit = 1 share = 1 000 000), and a price is microcredits per share (550000 is 0.55). Nothing here uses floating
 * point to compute a quantity: sums and products go through BigInt, and every amount is formatted from the integer.
 */

export const MICRO = 1_000_000;
const MICRO_BIG = 1_000_000n;
/** One cent of a credit in micro-units: amounts are shown with two decimals, prices on the 0.01 grid. */
const CENT_MICRO_BIG = 10_000n;
const HALF_CENT_MICRO_BIG = 5_000n;

/** How far above a quoted average price an order may fill, and how far below a quoted proceeds a sale may fall (percent). */
export const PRICE_TOLERANCE_PERCENT = 1;

function isMicro(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function twoDecimals(cents: bigint): string {
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** "1,250.50": an amount of microcredits with two decimals (half a cent rounds up). */
export function formatMicro(micro: number): string {
  if (!isMicro(micro)) return "-";
  return twoDecimals((BigInt(micro) + HALF_CENT_MICRO_BIG) / CENT_MICRO_BIG);
}

/** "1,250.50 credits". */
export function formatMicroCredits(micro: number): string {
  return isMicro(micro) ? `${formatMicro(micro)} credits` : "-";
}

/** "0.55": a price in microcredits per share, as 0.xx (1.00 and 0.00 only for a resolved market). */
export function formatPrice(micro: number): string {
  return formatMicro(micro);
}

/**
 * "+0.05", "-0.12", "0.00": the change of a YES price between two moments, from the difference of two integers. The sign
 * is part of the text (a colour is never the only cue); a change that rounds to "0.00" has none.
 */
export function formatPriceChange(deltaMicro: number): string {
  if (!Number.isSafeInteger(deltaMicro)) return "-";
  const size = formatMicro(Math.abs(deltaMicro));
  if (size === "0.00") return size;
  return `${deltaMicro > 0 ? "+" : "-"}${size}`;
}

/** The price limit of an order as text: as formatPrice, but never above 0.99, where the price grid of an open market ends (a limit near 1 would read "1.00", a price no open market has). */
export function formatPriceLimit(micro: number): string {
  return isMicro(micro) ? formatPrice(Math.min(micro, 990_000)) : "-";
}

/** "12.50": shares with two decimals, rounded down so that the number shown never exceeds what is held. */
export function formatShares(micro: number): string {
  if (!isMicro(micro)) return "-";
  return twoDecimals(BigInt(micro) / CENT_MICRO_BIG);
}

/** "12.345678", "12.5", "12": the exact decimal of a number of microshares, for a field that must hold it as it is. */
export function microToDecimalText(micro: number): string {
  if (!isMicro(micro)) return "";
  const whole = Math.floor(micro / MICRO);
  const fraction = String(micro % MICRO)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

/** The microshares of a number typed as "12", "12.5" or "0.000001" (at most six decimals), or null when it is none or below one microshare. */
export function parseSharesText(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const micro = Number(match[1]) * MICRO + Number((match[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(micro) && micro >= 1 ? micro : null;
}

/** The price of NO when YES costs `yesMicro`: the two always add up to one credit. */
export function noPrice(yesMicro: number): number {
  return MICRO - yesMicro;
}

/** What a position is worth at the current YES price: its YES shares at that price plus its NO shares at the rest of the credit (rounded down). */
export function positionValueMicro(yesMicro: number, noMicro: number, yesPriceMicro: number): number {
  const total = BigInt(yesMicro) * BigInt(yesPriceMicro) + BigInt(noMicro) * BigInt(MICRO - yesPriceMicro);
  return Number(total / MICRO_BIG);
}

/** The highest average price an order accepts: the quoted one plus the tolerance (rounded up), never above the contract's 0.999999. */
export function maxAveragePriceFor(averagePriceMicro: number): number {
  const extra = Math.ceil((averagePriceMicro * PRICE_TOLERANCE_PERCENT) / 100);
  return Math.min(999_999, averagePriceMicro + extra);
}

/** The least a sale accepts: the quoted proceeds minus the tolerance (rounded down), at least one microcredit. */
export function minProceedsFor(proceedsMicro: number): number {
  const less = Math.floor((proceedsMicro * PRICE_TOLERANCE_PERCENT) / 100);
  return Math.max(1, proceedsMicro - less);
}

/** The price of a market as a YES price and the NO price beside it: "YES 0.55, NO 0.45". */
export function describePrices(yesMicro: number): string {
  return `YES ${formatPrice(yesMicro)}, NO ${formatPrice(noPrice(yesMicro))}`;
}

/** A starting price typed as "0.35", ".35", "0,35" or "0.3": the cents (1 to 99), or null when it is none or off the 0.01 grid. */
export function parsePriceCents(text: string): number | null {
  const match = /^0?[.,](\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const digits = match[1] ?? "";
  const cents = Number(digits.length === 1 ? `${digits}0` : digits);
  return cents >= 1 && cents <= 99 ? cents : null;
}
