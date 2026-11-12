/** "about 30 seconds", "about 2 minutes": the wait a Retry-After header asks for, in words. */
export function describeWait(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 120) return `about ${whole} ${whole === 1 ? "second" : "seconds"}`;
  return `about ${Math.ceil(whole / 60)} minutes`;
}

/** "1,250 credits". */
export function formatCredits(amount: number): string {
  return `${amount.toLocaleString("en-US")} ${amount === 1 ? "credit" : "credits"}`;
}

/** The same amount in euros: 1 credit is 1 EUR cent, so 1,250 credits are "EUR 12.50". */
export function formatEuro(amount: number): string {
  // Whole credits are cents: split them as integers, so that no quotient of floating point decides a digit.
  if (!Number.isSafeInteger(amount)) return `EUR ${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cents = BigInt(Math.abs(amount));
  return `EUR ${amount < 0 ? "-" : ""}${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** "1,250 credits (EUR 12.50)": an amount is always shown as both. */
export function formatAmount(amount: number): string {
  return `${formatCredits(amount)} (${formatEuro(amount)})`;
}

/** A moment in the reader's own time zone and language, for example "11 Nov 2026, 14:05". */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
