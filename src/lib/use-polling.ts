import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/errors";

interface PollOptions<T> {
  /** Reads the resource once. Must be stable (useCallback): a new function restarts the polling. */
  load: (signal: AbortSignal) => Promise<T>;
  /** True when the resource reached a state that no longer changes; polling stops. */
  isDone: (value: T) => boolean;
  /** Pause between two reads, in milliseconds. */
  intervalMs: number;
  /** Reads before the page gives up waiting and offers a button instead. */
  maxAttempts: number;
  /** False: nothing is read. */
  enabled?: boolean;
}

export interface PollState<T> {
  /** The last answer. */
  data: T | null;
  /** The last read failed; polling goes on after a failure that may pass (no answer, 429, 502, 503, 504), and stops after any other. */
  error: unknown;
  /** A failure that does not pass ended the polling; checkNow starts it again. */
  stopped: boolean;
  /** The resource reached its final state. */
  done: boolean;
  /** maxAttempts reads went by without a final state. */
  timedOut: boolean;
}

const START: PollState<never> = { data: null, error: null, done: false, timedOut: false, stopped: false };

/**
 * Reads a resource again and again until it is final: the deposit after the buyer returned from the payment page, and
 * a withdrawal under way. A failed read that may pass (the server cannot be reached, a gateway's 502 or 504, 503 with
 * Retry-After) is shown and tried again after the wait the server asked for; any other failure stops the polling (state
 * `stopped`). checkNow starts over after the page gave up or the polling stopped.
 */
export function usePolling<T>({ load, isDone, intervalMs, maxAttempts, enabled = true }: PollOptions<T>): PollState<T> & { checkNow: () => void } {
  const [state, setState] = useState<PollState<T>>(START);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const later = (attempt: number, waitMs: number, partial: Partial<PollState<T>>) => {
      if (attempt >= maxAttempts) {
        setState((previous) => ({ ...previous, ...partial, timedOut: true }));
        return;
      }
      setState((previous) => ({ ...previous, ...partial }));
      timer = setTimeout(() => void read(attempt + 1), waitMs);
    };

    async function read(attempt: number): Promise<void> {
      try {
        const value = await load(controller.signal);
        if (cancelled) return;
        if (isDone(value)) {
          setState({ data: value, error: null, done: true, timedOut: false, stopped: false });
          return;
        }
        later(attempt, intervalMs, { data: value, error: null });
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof ApiError) || !error.isTemporary) {
          setState((previous) => ({ ...previous, error, stopped: true }));
          return;
        }
        const wait = Math.max(intervalMs, (error.retryAfterSeconds ?? 0) * 1000);
        later(attempt, wait, { error });
      }
    }

    void read(1);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, isDone, intervalMs, maxAttempts, enabled, round]);

  const checkNow = useCallback(() => {
    setState((previous) => ({ ...previous, error: null, timedOut: false, stopped: false }));
    setRound((value) => value + 1);
  }, []);

  return { ...state, checkNow };
}
