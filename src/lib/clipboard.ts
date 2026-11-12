/**
 * Puts a text on the clipboard. The asynchronous Clipboard API needs a secure context and a user gesture; where the
 * browser refuses (or has no such API), the text in the given input is selected and copied with the old command. The
 * answer is "failed" when both ways fail: the caller then tells the user to copy the selected text by hand.
 */
export async function copyText(text: string, fallbackInput?: HTMLInputElement | HTMLTextAreaElement | null): Promise<"copied" | "failed"> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    // Falls through to the fallback below.
  }
  if (fallbackInput) {
    fallbackInput.focus();
    fallbackInput.select();
    try {
      // execCommand is deprecated but is still the only way where the Clipboard API is not available.
      if (typeof document.execCommand === "function" && document.execCommand("copy")) return "copied";
    } catch {
      // The text stays selected, so the user can copy it by hand.
    }
  }
  return "failed";
}

/** The Web Share API, where the browser has it (phones mostly). */
export function canShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/** Opens the system share sheet. A sheet the user closes is not a failure: the answer is "cancelled". */
export async function shareLink(data: { title: string; text?: string; url: string }): Promise<"shared" | "cancelled" | "failed"> {
  try {
    await navigator.share(data);
    return "shared";
  } catch (error) {
    return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError" ? "cancelled" : "failed";
  }
}
