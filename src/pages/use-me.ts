import { useCallback, useEffect, useState } from "react";
import { useApi } from "../api/ApiContext";
import { getMe } from "../api/tenants";
import type { Me } from "../api/tenants";
import { useAuth } from "../auth/AuthContext";

/** Where the user's tenant and role stand between the database and the token (GET /v1/me). */
export type SyncPhase =
  /** Nothing to wait for: the token matches the database. */
  | "in-sync"
  /** identityPending: the identity provider does not hold the change yet; refreshing the token cannot help. */
  | "waiting"
  /** The wait ran out; the user can ask again. */
  | "gave-up"
  /** tokenNeedsRefresh: the token is being renewed. */
  | "refreshing"
  /** The renewed token still differs, or the renewal failed; the user can try again or sign in again. */
  | "stale";

export interface MeState {
  me: Me | null;
  error: unknown;
  loading: boolean;
  phase: SyncPhase;
}

/** Seconds between two reads while the identity provider catches up, and how often to ask before giving up (about 2 minutes). */
export const PENDING_WAIT_MS = 5000;
export const PENDING_MAX_WAITS = 24;

const START: MeState = { me: null, error: null, loading: true, phase: "in-sync" };

/**
 * Reads GET /v1/me. While identityPending is true the page waits and asks again (refreshing the token cannot help
 * before it is false, and must not loop); when only tokenNeedsRefresh is true it renews the session once and reads
 * again, so the menu shows the new tenant and role.
 */
export function useMe(): MeState & { recheck: () => void; refreshNow: () => void } {
  const api = useApi();
  const { refreshSession } = useAuth();
  const [state, setState] = useState<MeState>(START);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let renewed = false;

    async function check(waits: number): Promise<void> {
      try {
        const me = await getMe(api, controller.signal);
        if (cancelled) return;
        if (me.identityPending) {
          const phase: SyncPhase = waits >= PENDING_MAX_WAITS ? "gave-up" : "waiting";
          setState({ me, error: null, loading: false, phase });
          if (phase === "waiting") timer = setTimeout(() => void check(waits + 1), PENDING_WAIT_MS);
          return;
        }
        if (me.tokenNeedsRefresh && !renewed) {
          renewed = true;
          setState({ me, error: null, loading: false, phase: "refreshing" });
          const worked = await refreshSession();
          if (cancelled) return;
          if (worked) return check(waits);
          setState({ me, error: null, loading: false, phase: "stale" });
          return;
        }
        setState({ me, error: null, loading: false, phase: me.tokenNeedsRefresh ? "stale" : "in-sync" });
      } catch (error) {
        if (!cancelled) setState((previous) => ({ ...previous, error, loading: false }));
      }
    }

    void check(0);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, refreshSession, round]);

  const recheck = useCallback(() => {
    setState((previous) => ({ ...previous, error: null, loading: true }));
    setRound((value) => value + 1);
  }, []);

  const refreshNow = useCallback(() => {
    setState((previous) => ({ ...previous, error: null, phase: "refreshing" }));
    void refreshSession().then(() => setRound((value) => value + 1));
  }, [refreshSession]);

  return { ...state, recheck, refreshNow };
}
