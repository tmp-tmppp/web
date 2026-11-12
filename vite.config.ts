import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// "npm run dev" serves the app on port 5173 (the identity realm and the payments return addresses expect it) and
// forwards the API and the mock payment page to a running gateway, so the browser sees one origin, as in the cluster.
// Keycloak is reached directly at the issuer of public/config.json.
const gateway = process.env["GATEWAY_URL"] ?? "http://localhost:8000";
const proxy = { "/v1": gateway, "/checkout": gateway };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: { target: "es2023", sourcemap: false },
});
