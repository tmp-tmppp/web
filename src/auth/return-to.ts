import { CALLBACK_PATH } from "./oidc";

/**
 * The page to go back to after the login. Only a path of this app is accepted, so a crafted login state cannot
 * send the browser to another site.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (value === CALLBACK_PATH || value.startsWith(`${CALLBACK_PATH}?`)) return "/";
  return value;
}
