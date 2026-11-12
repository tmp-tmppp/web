import { vi } from "vitest";

/**
 * Fakes setTimeout and clearTimeout only (promises, fetch and the mock API keep working) so a test can move the polling
 * clocks of the pages on with `await act(() => vi.advanceTimersByTimeAsync(ms))`.
 *
 * Testing Library waits with a setTimeout of its own and finds out that timers are fake only through a global named
 * "jest"; without it every findBy... and waitFor would hang under Vitest. tests/setup.ts removes the global again.
 */
export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  (globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
}
