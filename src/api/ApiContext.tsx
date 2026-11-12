import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { useConfig } from "../config/ConfigContext";
import { createApiClient } from "./client";
import type { ApiClient } from "./types";

export const ApiContext = createContext<ApiClient | null>(null);

/** The API client of the signed-in user: it gets the token from the auth context and ends the session on a hard 401. */
export function ApiProvider({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }) {
  const config = useConfig();
  const { getAccessToken, refreshSession, expireSession } = useAuth();
  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: config.apiBase,
        getAccessToken,
        refreshSession,
        onUnauthorized: () => void expireSession(),
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    [config.apiBase, getAccessToken, refreshSession, expireSession, fetchImpl],
  );
  return <ApiContext value={client}>{children}</ApiContext>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi must be used inside <ApiProvider>");
  return client;
}
