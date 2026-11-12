import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { createUserManager } from "./auth/oidc";
import type { OidcClient } from "./auth/oidc";
import { PublicFrame } from "./components/PublicFrame";
import { StatusMessage } from "./components/StatusMessage";
import { loadConfig } from "./config/runtime-config";
import type { AppConfig } from "./config/types";

type Startup = { phase: "loading" } | { phase: "ready"; config: AppConfig; manager: OidcClient } | { phase: "failed"; message: string };

interface BootstrapProps {
  load?: () => Promise<AppConfig>;
  createManager?: (config: AppConfig) => OidcClient;
}

// Module-level, so the effect below does not run again on every render.
const defaultLoad = () => loadConfig();
const defaultCreateManager = (config: AppConfig): OidcClient => createUserManager(config);

/** Loads /config.json, builds the OIDC client from it, then starts the app. A bad configuration stops here with a message. */
export function Bootstrap({ load = defaultLoad, createManager = defaultCreateManager }: BootstrapProps) {
  const [startup, setStartup] = useState<Startup>({ phase: "loading" });

  useEffect(() => {
    let active = true;
    load().then(
      (config) => {
        if (active) setStartup({ phase: "ready", config, manager: createManager(config) });
      },
      (error: unknown) => {
        if (active) setStartup({ phase: "failed", message: error instanceof Error ? error.message : "The configuration could not be read." });
      },
    );
    return () => {
      active = false;
    };
  }, [load, createManager]);

  if (startup.phase === "loading") {
    return (
      <PublicFrame>
        <StatusMessage>Loading...</StatusMessage>
      </PublicFrame>
    );
  }
  if (startup.phase === "failed") {
    return (
      <PublicFrame>
        <section className="card">
          <h1>The app cannot start</h1>
          <div className="problem" role="alert">
            <p className="problem-title">The configuration is missing or wrong.</p>
            <p>{startup.message}</p>
          </div>
        </section>
      </PublicFrame>
    );
  }
  return (
    <BrowserRouter>
      <App config={startup.config} manager={startup.manager} />
    </BrowserRouter>
  );
}
