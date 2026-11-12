import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import type { AppConfig } from "../config/types";

/** Where the identity provider sends the browser back after the login. Allowed by the realm's redirect URI "<web url>/*". */
export const CALLBACK_PATH = "/auth/callback";

/** The scopes every sign-in asks for. */
export const BASE_SCOPE = "openid profile email";

/**
 * The client scope of the realm that puts the user's organization and its groups into the token (identity/realm).
 * Plain, Keycloak lets a member of several organizations pick one; "chance-organization:<alias>" names exactly that
 * organization and is refused when the user is no member (token contract v2: exactly one organization per token).
 */
export const ORGANIZATION_SCOPE = "chance-organization";

/** The scope of a sign-in: with an alias the token is for that organization, without one Keycloak asks the user. */
export function scopeFor(alias?: string | null): string {
  if (alias && !/^[A-Za-z0-9._-]+$/.test(alias)) throw new Error("The organization alias is not valid");
  return `${BASE_SCOPE} ${alias ? `${ORGANIZATION_SCOPE}:${alias}` : ORGANIZATION_SCOPE}`;
}

/** The part of oidc-client-ts the app uses, so tests can replace it with a fake. */
export type OidcClient = Pick<UserManager, "getUser" | "signinRedirect" | "signinCallback" | "signinSilent" | "signoutRedirect" | "removeUser"> & {
  events: Pick<
    UserManager["events"],
    | "addUserLoaded"
    | "removeUserLoaded"
    | "addUserUnloaded"
    | "removeUserUnloaded"
    | "addAccessTokenExpired"
    | "removeAccessTokenExpired"
    | "addAccessTokenExpiring"
    | "removeAccessTokenExpiring"
  >;
};

/**
 * The OIDC client of the web app: authorization code flow with PKCE (S256 is added to the request whenever the library
 * creates a code verifier, which it does for "code"), refresh tokens for the silent renewal, and sessionStorage for both
 * the tokens and the short-lived login state, so nothing reaches localStorage (ADR-024). The user info endpoint is not
 * called: the ID token carries the name and the access token the roles and the tenant.
 *
 * The library's own renewal timer is off (automaticSilentRenew false): the realm rotates refresh tokens and allows no
 * reuse, so two renewals at once would send the same refresh token twice and the second would be refused. AuthProvider
 * renews on the library's "access token expiring" event through the one renewal it also uses for every other caller.
 */
export function createUserManager(config: AppConfig, origin: string = window.location.origin): UserManager {
  const store = window.sessionStorage;
  return new UserManager({
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: "code",
    scope: scopeFor(),
    loadUserInfo: false,
    automaticSilentRenew: false,
    userStore: new WebStorageStateStore({ store }),
    stateStore: new WebStorageStateStore({ store }),
  });
}
