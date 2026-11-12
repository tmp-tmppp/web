/**
 * A random version 4 UUID. crypto.randomUUID exists only in secure contexts; getRandomValues works everywhere, so
 * correlation ids and idempotency keys also work when the page is served over plain http during development.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One key per attempt: the page makes it once when the user starts an action, and reuses it for that attempt. */
export function newIdempotencyKey(): string {
  return randomId();
}
