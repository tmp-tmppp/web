import { APP_ROLES } from "./roles";
import type { Role } from "./roles";
import type { AuthUser } from "./types";

type Claims = Record<string, unknown>;

/** The token cannot be read, or it does not describe one user in one tenant. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/**
 * Reads the payload of a JWT. The signature is not checked here: the browser only displays what the token says
 * (menu entries, the user's name); every service verifies the token against the identity provider's keys.
 */
export function decodeJwtPayload(token: string): Claims {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) throw new TokenError("The access token is not a JWT");
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Claims;
  } catch {
    // Falls through to the error below.
  }
  throw new TokenError("The access token cannot be read");
}

/** The groups of an organization that carry a tenant role (token contract v2, ADR-059). */
const TENANT_GROUPS = new Map<string, Role>([
  ["/trader", "trader"],
  ["/tenant-admin", "tenant-admin"],
]);

/** The entry of the one organization in the claim, or null when the claim names none or several. */
function organizationEntry(claims: Claims): Claims | null {
  const value = claims["organization"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Claims).filter(([alias]) => alias !== "");
  const entry = entries.length === 1 ? entries[0]?.[1] : undefined;
  return typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Claims) : null;
}

/**
 * The app roles of the token, in the order of APP_ROLES (token contract v2): platform-admin is a realm role
 * (realm_access.roles); the tenant role is the group of the one organization (organization.<alias>.groups holds
 * exactly one of "/trader" and "/tenant-admin"). A realm role trader or tenant-admin counts for nothing.
 */
export function rolesFromClaims(claims: Claims): Role[] {
  const present = new Set<Role>();
  const access = claims["realm_access"];
  const realm = typeof access === "object" && access !== null ? (access as Claims)["roles"] : undefined;
  if (Array.isArray(realm) && realm.includes("platform-admin")) present.add("platform-admin");
  const groups = organizationEntry(claims)?.["groups"];
  if (Array.isArray(groups)) {
    const tenantRoles = new Set<Role>();
    for (const group of groups) {
      const role = typeof group === "string" ? TENANT_GROUPS.get(group) : undefined;
      if (role) tenantRoles.add(role);
    }
    if (tenantRoles.size === 1) for (const role of tenantRoles) present.add(role);
  }
  return APP_ROLES.filter((role) => present.has(role));
}

/** The organization claim is a string, an array of aliases or an object keyed by alias. At most one tenant is allowed. */
export function tenantFromClaims(claims: Claims): string | null {
  const value = claims["organization"];
  let aliases: string[] = [];
  if (typeof value === "string") aliases = [value];
  else if (Array.isArray(value)) aliases = value.filter((alias): alias is string => typeof alias === "string");
  else if (typeof value === "object" && value !== null) aliases = Object.keys(value);
  aliases = aliases.filter((alias) => alias !== "");
  if (aliases.length > 1) throw new TokenError("The token belongs to more than one organization");
  return aliases[0] ?? null;
}

function text(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

/** The user the interface shows, from the access token (roles, tenant) and the ID token claims (name, e-mail). */
export function userFromTokens(accessToken: string, idClaims: Claims = {}): AuthUser {
  const claims = decodeJwtPayload(accessToken);
  const id = text(claims["sub"], idClaims["sub"]);
  if (!id) throw new TokenError("The access token has no subject");
  const username = text(idClaims["preferred_username"], claims["preferred_username"]) ?? id;
  return {
    id,
    username,
    name: text(idClaims["name"], claims["name"]) ?? username,
    email: text(idClaims["email"], claims["email"]),
    roles: rolesFromClaims(claims),
    tenantId: tenantFromClaims(claims),
  };
}
