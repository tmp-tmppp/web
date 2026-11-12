/** True for an address the browser may be sent to for payment: http or https, nothing else (no javascript: or data: address). */
export function isSafeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Leaves the app for another site (the provider's payment page). A function of its own so a test can replace it. */
export function goToExternal(url: string): void {
  window.location.assign(url);
}
