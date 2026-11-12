import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { takeViolations } from "./support/contract";
import { server } from "./support/server";

// Any request a test did not describe fails the test: no test reaches a real network.
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as { jest?: unknown }).jest;
  server.resetHandlers();
  window.sessionStorage.clear();
  document.title = "";
  // A request or an answer that does not follow the OpenAPI files of the services fails the test.
  const violations = takeViolations();
  if (violations.length > 0) throw new Error(`The mock API saw contract violations:\n${violations.join("\n")}`);
});

afterAll(() => server.close());
