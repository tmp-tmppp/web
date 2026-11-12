import { useCallback, useContext, useState } from "react";
import { ApiError } from "../api/errors";
import { AuthContext } from "../auth/AuthContext";
import { newIdempotencyKey } from "./ids";

/** Prefix of the sessionStorage names that hold the pending attempts of one form: `chance.pending-key.<user>.<tenant>.<scope>`. */
const STORAGE_PREFIX = "chance.pending-key.";

/**
 * How long an attempt without a settling answer is kept: a day, well below the 7 days trading keeps an order's key, so a
 * key that is reused is one the service still knows (and an old one is never found again by a later, new request).
 */
export const PENDING_MAX_AGE_MS = 24 * 3_600_000;

/** How many unsettled attempts of one form are kept; the oldest is forgotten first. */
const MAX_ATTEMPTS = 5;

/** One request that has no settling answer yet. `payload` is what the form needs to send exactly this request again (JSON only, never a token). */
export interface PendingAttempt {
  signature: string;
  key: string;
  payload?: unknown;
  /** When the key was made, in ms since the epoch. */
  at: number;
}

const isFresh = (attempt: PendingAttempt, now: number): boolean => now - attempt.at <= PENDING_MAX_AGE_MS;

/**
 * The attempts kept in sessionStorage under `name`, oldest first, or an empty list when there are none or the storage
 * cannot be used (private mode, disabled storage) or holds something else than a list of attempts. Every access is
 * guarded: the hook then works from memory alone.
 */
function readAttempts(name: string, now: number): PendingAttempt[] {
  try {
    const text = window.sessionStorage.getItem(name);
    if (text === null) return [];
    const value: unknown = JSON.parse(text);
    const list = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)["attempts"] : null;
    if (!Array.isArray(list)) return [];
    const attempts: PendingAttempt[] = [];
    for (const item of list as unknown[]) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const { signature, key, payload, at } = item as Record<string, unknown>;
      if (typeof signature !== "string" || typeof key !== "string" || key === "" || typeof at !== "number" || !Number.isFinite(at)) continue;
      if (attempts.some((known) => known.signature === signature)) continue;
      const attempt: PendingAttempt = payload === undefined ? { signature, key, at } : { signature, key, payload, at };
      if (isFresh(attempt, now)) attempts.push(attempt);
    }
    return attempts.slice(-MAX_ATTEMPTS);
  } catch {
    return [];
  }
}

function writeAttempts(name: string, attempts: PendingAttempt[]): void {
  try {
    if (attempts.length === 0) window.sessionStorage.removeItem(name);
    else window.sessionStorage.setItem(name, JSON.stringify({ attempts }));
  } catch {
    // Storage full or not allowed: the attempts stay in memory only, and what the storage still holds stays as it was
    // (an older attempt that is still unsettled keeps its protection).
    if (attempts.length > 0) return;
    // The entry could not be removed although nothing is pending any more: overwrite it with an empty list, so that the
    // key of an attempt that ended is not found again after a reload.
    try {
      window.sessionStorage.setItem(name, JSON.stringify({ attempts: [] }));
    } catch {
      // Nothing more can be done: the storage cannot be written at all.
    }
  }
}

/**
 * One Idempotency-Key per attempt. The key stays the same while the same request is repeated after an answer that may
 * pass or that says nothing about the outcome (no answer, 429, 503, a success status whose body could not be read, or a
 * server failure that names none of our services' refusals: see ApiError.outcomeUnknown), so the service finishes the first
 * try instead of making a second one; it changes after a success, a refusal (any other 4xx, a 5xx with a refusal code of
 * ours) or when the request itself changes. Call keyFor(signature) when the user submits, then done(error?) when the
 * request ended.
 *
 * The attempts that have no settling answer are kept per form: up to five, each with its signature, key, the moment the key
 * was made and, when the form passes one, the whole request (`payload`). done() settles only the attempt of the last
 * keyFor, so a refusal of another request in between does not forget a request whose answer was lost. The attempts are also
 * kept in sessionStorage under `chance.pending-key.<user>.<tenant>.<scope>`, so that they survive a reload of the page: a lost
 * answer followed by a reload would otherwise make the next submit a new request that can be a second order, deposit or
 * withdrawal. They are written when the key is made or reused, removed when the attempt ended with an answer that settles
 * it (or a day after the key was made), and read back when the form mounts. The user and the tenant are part of the name, so
 * a person who signs in in the same tab never finds or sends the key of another. Nothing else is stored (the signature and
 * the payload hold what the request holds, never a token). A storage that throws leaves the hook working from memory.
 *
 * `pending` is the newest unsettled attempt, for a form that offers to send exactly that request again after a reload (a
 * buy or a sale whose signature holds the price limit of a quote that a reload loses). `discard()` forgets it on the person's
 * explicit decision.
 *
 * `scope` names the form, one short stable string per form (and per target where one form serves several, for example
 * `buy:<marketId>`), so that two forms never share a key. A signature is reused only for the same scope.
 */
export function useIdempotencyKey(scope: string) {
  const user = useContext(AuthContext)?.user ?? null;
  const owner = user ? `${encodeURIComponent(user.id)}.${encodeURIComponent(user.tenantId ?? "-")}.` : "";
  const name = `${STORAGE_PREFIX}${owner}${scope}`;
  // The unsettled attempts of every storage name this hook has used (the name changes with the scope), read back from the
  // storage the first time; and the signature of the last keyFor of each, which done() settles.
  const [memory] = useState(() => ({ attempts: new Map<string, PendingAttempt[]>(), last: new Map<string, string>() }));

  const attemptsOf = useCallback(
    (entry: string): PendingAttempt[] => {
      const known = memory.attempts.get(entry);
      if (known) return known;
      const read = readAttempts(entry, Date.now());
      memory.attempts.set(entry, read);
      return read;
    },
    [memory],
  );

  const keyFor = useCallback(
    (signature: string, payload?: unknown): string => {
      const now = Date.now();
      const fresh = attemptsOf(name).filter((attempt) => isFresh(attempt, now));
      const existing = fresh.find((attempt) => attempt.signature === signature);
      const attempt: PendingAttempt = existing ?? { signature, key: newIdempotencyKey(), at: now, ...(payload === undefined ? {} : { payload }) };
      const next = existing ? fresh : [...fresh, attempt].slice(-MAX_ATTEMPTS);
      memory.attempts.set(name, next);
      memory.last.set(name, signature);
      // Written also when reused, so that an entry that was cleared meanwhile is back.
      writeAttempts(name, next);
      return attempt.key;
    },
    [attemptsOf, memory, name],
  );

  const done = useCallback(
    (error?: unknown) => {
      const signature = memory.last.get(name);
      if (signature === undefined) return;
      // An error that is not an ApiError carries no answer of the service: keeping the key is always safe (a service that
      // never saw it takes the request as new), dropping it is not.
      const mayPass = error !== undefined && (!(error instanceof ApiError) || error.outcomeUnknown || error.isRetryable);
      if (mayPass) return;
      const next = attemptsOf(name).filter((attempt) => attempt.signature !== signature);
      memory.attempts.set(name, next);
      writeAttempts(name, next);
    },
    [attemptsOf, memory, name],
  );

  const discard = useCallback(() => {
    const next = attemptsOf(name).slice(0, -1);
    memory.attempts.set(name, next);
    memory.last.delete(name);
    writeAttempts(name, next);
  }, [attemptsOf, memory, name]);

  // Read at every render: the forms render again after each answer, so this follows done() and discard(). The attempts in
  // memory were fresh when they were read or made (a page that stays open for a day is not a case worth a timer).
  const pending = attemptsOf(name).at(-1) ?? null;

  return { keyFor, done, discard, pending };
}
