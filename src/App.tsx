import { ApiProvider } from "./api/ApiContext";
import { AuthProvider } from "./auth/AuthContext";
import type { OidcClient } from "./auth/oidc";
import { ConfigContext } from "./config/ConfigContext";
import type { AppConfig } from "./config/types";
import { AppRoutes } from "./routes/AppRoutes";

interface AppProps {
  config: AppConfig;
  manager: OidcClient;
  fetchImpl?: typeof fetch;
}

/** The app without its router: configuration, login, API client and routes. The caller supplies the router. */
export function App({ config, manager, fetchImpl }: AppProps) {
  return (
    <ConfigContext value={config}>
      <AuthProvider manager={manager}>
        <ApiProvider {...(fetchImpl ? { fetchImpl } : {})}>
          <AppRoutes />
        </ApiProvider>
      </AuthProvider>
    </ConfigContext>
  );
}
