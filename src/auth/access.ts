import type { Role } from "./roles";
import type { AuthUser } from "./types";

/** Who may open a route. Every condition that is set must hold; the API stays the real check. */
export interface RouteAccess {
  /** The user needs one of these roles. Without it any signed-in user may open the route. */
  roles?: readonly Role[];
  /** The user must not have any of these roles. */
  notRoles?: readonly Role[];
  /** "required": a member of a tenant. "none": a user who has not joined a tenant yet. */
  tenant?: "required" | "none";
}

export type Denial = "role" | "tenant-required" | "tenant-present";

export type AccessDecision = { allowed: true } | { allowed: false; reason: Denial };

export function hasAnyRole(user: AuthUser, roles: readonly Role[]): boolean {
  return roles.some((role) => user.roles.includes(role));
}

export function evaluateAccess(user: AuthUser, access: RouteAccess): AccessDecision {
  if (access.tenant === "required" && !user.tenantId) return { allowed: false, reason: "tenant-required" };
  if (access.tenant === "none" && user.tenantId) return { allowed: false, reason: "tenant-present" };
  if (access.roles && !hasAnyRole(user, access.roles)) return { allowed: false, reason: "role" };
  if (access.notRoles && hasAnyRole(user, access.notRoles)) return { allowed: false, reason: "role" };
  return { allowed: true };
}

/** The page a user lands on after the login. */
export function landingPath(user: AuthUser): string {
  if (user.roles.includes("platform-admin")) return "/platform/tenants";
  if (!user.tenantId) return "/join";
  return "/markets";
}
