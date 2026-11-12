import type { Role } from "./roles";

/** What the app knows about the signed-in user, read from the tokens. The API stays the real check. */
export interface AuthUser {
  /** The subject of the token (the Keycloak user id). Same value as userId in GET /v1/me. */
  id: string;
  username: string;
  /** Display name. */
  name: string;
  email: string | null;
  /** The app roles in realm_access.roles. A new user has none until the first invite code is accepted. */
  roles: Role[];
  /** Alias of the user's organization (the tenant id), or null before the user joined a tenant. */
  tenantId: string | null;
}

export type AuthStatus = "loading" | "unauthenticated" | "authenticated" | "error";
