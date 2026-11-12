import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit and component tests run in jsdom against a mocked API (MSW) and a fake OIDC manager: no network, no
// Keycloak, no Docker.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    css: false,
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Excluded: the entry file (it only mounts the app) and files that hold types only.
      exclude: ["src/main.tsx", "src/vite-env.d.ts", "src/**/types.ts"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});
