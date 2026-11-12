import { createContext, useContext } from "react";
import type { AppConfig } from "./types";

export const ConfigContext = createContext<AppConfig | null>(null);

export function useConfig(): AppConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig must be used inside the app's ConfigContext");
  return config;
}
