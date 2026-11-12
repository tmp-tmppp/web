/** The whole number a form field holds when it is within min and max, otherwise null (also for "", "1.5", "1e3" and "12abc"). */
export function wholeNumberInRange(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
