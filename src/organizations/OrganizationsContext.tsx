import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "../api/ApiContext";
import { listMyOrganizations } from "../api/tenants";
import type { Organization } from "../api/tenants";

export interface OrganizationsValue {
  /** Every organization the user belongs to, oldest membership first (GET /v1/me/organizations). */
  organizations: Organization[];
  /** True while the identity provider may not hold every membership yet: a sign-in to a new organization can fail until it is false. */
  identityPending: boolean;
  loading: boolean;
  /** Why the list could not be read; the rest of the app keeps working without it. */
  error: unknown;
  /** Reads the list again, for example after the user joined another organization. */
  reload: () => void;
}

/** What the hook answers outside the provider (a page rendered alone): no organizations, nothing to wait for. */
const NONE: OrganizationsValue = { organizations: [], identityPending: false, loading: false, error: null, reload: () => undefined };

const OrganizationsContext = createContext<OrganizationsValue>(NONE);

/** The organizations of the signed-in user. Outside OrganizationsProvider it is an empty list. */
export function useOrganizations(): OrganizationsValue {
  return useContext(OrganizationsContext);
}

/** The most pages read in one go: a page holds up to 100 organizations, which is far more than a person belongs to. */
const MAX_PAGES = 10;

interface Snapshot {
  organizations: Organization[];
  identityPending: boolean;
  loading: boolean;
  error: unknown;
}

const START: Snapshot = { organizations: [], identityPending: false, loading: true, error: null };

/** Reads all pages of the user's organizations once and again on reload(). It sits in the layout, so every signed-in page can use the list. */
export function OrganizationsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [snapshot, setSnapshot] = useState<Snapshot>(START);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function readAll() {
      const items: Organization[] = [];
      let pending = false;
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await listMyOrganizations(api, cursor, controller.signal);
        items.push(...result.items);
        pending = result.identityPending;
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return { items, pending };
    }
    readAll().then(
      ({ items, pending }) => setSnapshot({ organizations: items, identityPending: pending, loading: false, error: null }),
      (error: unknown) => {
        if (!controller.signal.aborted) setSnapshot({ organizations: [], identityPending: false, loading: false, error });
      },
    );
    return () => controller.abort();
  }, [api, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  const value = useMemo<OrganizationsValue>(() => ({ ...snapshot, reload }), [snapshot, reload]);
  return <OrganizationsContext value={value}>{children}</OrganizationsContext>;
}
