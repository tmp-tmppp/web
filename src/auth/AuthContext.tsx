import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { User } from "oidc-client-ts";
import { useLocation, useNavigate } from "react-router";
import { CALLBACK_PATH, scopeFor } from "./oidc";
import type { OidcClient } from "./oidc";
import { safeReturnTo } from "./return-to";
import { userFromTokens } from "./token";
import type { AuthStatus, AuthUser } from "./types";

export interface AuthContextValue {
  status: AuthStatus;
  /** The signed-in user, only while status is "authenticated". */
  user: AuthUser | null;
  /** Why the login failed, only while status is "error". */
  error: Error | null;
  /** A short message for the sign-in page, for example after the session ended. */
  notice: string | null;
  /**
   * Sends the browser to the identity provider; it comes back to returnTo (a path of this app, a fragment is kept).
   * With options.organization the new token is for that organization (a switch: the single sign-on session of the
   * identity provider usually answers at once, without a login form); without it Keycloak lets a member of several pick.
   */
  login: (returnTo?: string, options?: { organization?: string | null }) => Promise<void>;
  /** Ends the session at the identity provider and returns to the start page. */
  logout: () => Promise<void>;
  /** A valid access token for the API, renewed first when it has expired; null without a session. */
  getAccessToken: () => Promise<string | null>;
  /** Renews the tokens with the refresh token, so new roles or a new tenant reach the token. True when it worked. */
  refreshSession: () => Promise<boolean>;
  /** Called when the API refuses the token for good: drops the session and shows the sign-in page. */
  expireSession: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

interface Snapshot {
  status: AuthStatus;
  user: AuthUser | null;
  error: Error | null;
  notice: string | null;
}

const LOADING: Snapshot = { status: "loading", user: null, error: null, notice: null };
const SESSION_ENDED = "Your session has ended. Sign in again to continue.";

function signedOut(notice: string | null): Snapshot {
  return { status: "unauthenticated", user: null, error: null, notice };
}

function failed(error: unknown): Snapshot {
  return { status: "error", user: null, error: error instanceof Error ? error : new Error(String(error)), notice: null };
}

function fromOidcUser(oidcUser: User | null | undefined): Snapshot {
  if (!oidcUser || oidcUser.expired) return signedOut(null);
  try {
    return { status: "authenticated", user: userFromTokens(oidcUser.access_token, oidcUser.profile), error: null, notice: null };
  } catch (error) {
    return failed(error);
  }
}

interface AuthProviderProps {
  manager: OidcClient;
  children: ReactNode;
}

/**
 * Holds the login state. On the first render it either completes a login (the browser came back from the identity
 * provider to CALLBACK_PATH) or restores the session kept in sessionStorage, renewing it first when it has expired.
 * It must sit inside the router.
 */
export function AuthProvider({ manager, children }: AuthProviderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [initial] = useState(() => ({ pathname: location.pathname, search: location.search }));
  const [snapshot, setSnapshot] = useState<Snapshot>(LOADING);
  const started = useRef<Promise<void> | null>(null);
  const renewing = useRef<Promise<User | null> | null>(null);

  /**
   * The one place that renews the tokens. The realm rotates refresh tokens and allows no reuse, so two renewals at once
   * would send the same refresh token twice and the second would be refused: while one runs, every caller (start-up,
   * a token request, a session refresh, the expiring-token event) waits for it and gets its answer.
   */
  const renew = useCallback((): Promise<User | null> => {
    renewing.current ??= manager.signinSilent().finally(() => {
      renewing.current = null;
    });
    return renewing.current;
  }, [manager]);

  useEffect(() => {
    // Strict mode runs effects twice; a login callback can be consumed only once.
    started.current ??= (async () => {
      try {
        if (initial.pathname === CALLBACK_PATH) {
          const user = await manager.signinCallback(`${window.location.origin}${initial.pathname}${initial.search}`);
          setSnapshot(fromOidcUser(user));
          const state = user?.state as { returnTo?: unknown } | undefined;
          void navigate(safeReturnTo(state?.returnTo), { replace: true });
          return;
        }
        let user = await manager.getUser();
        if (user?.expired) {
          try {
            user = await renew();
          } catch {
            await manager.removeUser();
            user = null;
          }
        }
        setSnapshot(fromOidcUser(user));
      } catch (error) {
        setSnapshot(failed(error));
      }
    })();
  }, [manager, navigate, initial, renew]);

  useEffect(() => {
    const onLoaded = (user: User) => setSnapshot(fromOidcUser(user));
    const onUnloaded = () => setSnapshot(signedOut(null));
    const onExpired = () => setSnapshot(signedOut(SESSION_ENDED));
    // Renew before the token runs out. A failed renewal changes nothing here: the expired event ends the session.
    const onExpiring = () => void renew().catch(() => undefined);
    manager.events.addUserLoaded(onLoaded);
    manager.events.addUserUnloaded(onUnloaded);
    manager.events.addAccessTokenExpired(onExpired);
    manager.events.addAccessTokenExpiring(onExpiring);
    return () => {
      manager.events.removeUserLoaded(onLoaded);
      manager.events.removeUserUnloaded(onUnloaded);
      manager.events.removeAccessTokenExpired(onExpired);
      manager.events.removeAccessTokenExpiring(onExpiring);
    };
  }, [manager, renew]);

  const login = useCallback(
    async (returnTo = "/", options: { organization?: string | null } = {}) => {
      await manager.signinRedirect({
        state: { returnTo: safeReturnTo(returnTo) },
        ...(options.organization ? { scope: scopeFor(options.organization) } : {}),
      });
    },
    [manager],
  );

  const logout = useCallback(async () => {
    try {
      await manager.signoutRedirect();
    } catch {
      // The end-session request could not start; the local session still ends.
      await manager.removeUser();
      setSnapshot(signedOut(null));
    }
  }, [manager]);

  const getAccessToken = useCallback(async () => {
    let user = await manager.getUser();
    if (user?.expired) {
      try {
        user = await renew();
      } catch {
        return null;
      }
    }
    return user?.access_token ?? null;
  }, [manager, renew]);

  const refreshSession = useCallback(async () => {
    try {
      const user = await renew();
      if (!user) return false;
      setSnapshot(fromOidcUser(user));
      return true;
    } catch {
      return false;
    }
  }, [renew]);

  const expireSession = useCallback(async () => {
    await manager.removeUser();
    setSnapshot(signedOut(SESSION_ENDED));
  }, [manager]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...snapshot, login, logout, getAccessToken, refreshSession, expireSession }),
    [snapshot, login, logout, getAccessToken, refreshSession, expireSession],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
