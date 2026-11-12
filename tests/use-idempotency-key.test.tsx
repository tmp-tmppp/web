import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import { AuthContext } from "../src/auth/AuthContext";
import type { AuthContextValue } from "../src/auth/AuthContext";
import { useIdempotencyKey } from "../src/lib/use-idempotency-key";

// The pending key survives a reload: it is kept in sessionStorage under "chance.pending-key.<scope>" while an attempt has
// no definitive answer. Unmounting the hook and mounting it again, with the storage kept, is what a reload does to it.

const PREFIX = "chance.pending-key.";
const failed = (status: number, code: string | null = null) => new ApiError({ status, type: "about:blank", title: "Title", code });
const lost = () => failed(0);

/** One mount of the hook, as one page load. */
function mount(scope: string) {
  const view = renderHook(() => useIdempotencyKey(scope));
  return { keys: view.result.current, unmount: view.unmount };
}

const entries = () => Object.keys(window.sessionStorage).filter((name) => name.startsWith(PREFIX));

afterEach(() => vi.restoreAllMocks());

describe("useIdempotencyKey", () => {
  it("gives the same key to the same signature while no definitive answer came, also across an unmount and a mount (a reload)", () => {
    const first = mount("buy");
    const key = first.keys.keyFor("order:10");
    first.keys.done(lost());
    first.unmount();
    const second = mount("buy");
    expect(second.keys.keyFor("order:10")).toBe(key);
  });

  it("writes the key when it is made, so a reload while the request is still in flight finds it", () => {
    const first = mount("withdraw");
    const key = first.keys.keyFor("withdrawal:500");
    // No done() call: the request never came back.
    first.unmount();
    expect(JSON.parse(window.sessionStorage.getItem(`${PREFIX}withdraw`) ?? "null")).toEqual({ attempts: [{ signature: "withdrawal:500", key, at: expect.any(Number) }] });
    expect(mount("withdraw").keys.keyFor("withdrawal:500")).toBe(key);
  });

  it.each([
    ["a success", undefined],
    ["a refusal (409)", failed(409, "insufficient_credits")],
    ["a bad request (400)", failed(400)],
    ["a 5xx with a code of ours (502 funding_rejected)", failed(502, "funding_rejected")],
  ])("removes the entry when the attempt ended with %s, so the next attempt is a new one", (_name, outcome) => {
    const first = mount("buy");
    const key = first.keys.keyFor("order:10");
    expect(entries()).toEqual([`${PREFIX}buy`]);
    first.keys.done(outcome);
    expect(entries()).toEqual([]);
    first.unmount();
    expect(mount("buy").keys.keyFor("order:10")).not.toBe(key);
  });

  it.each([
    ["no answer", lost()],
    ["a 500 without a code", failed(500)],
    ["a 500 internal_error", failed(500, "internal_error")],
    ["a gateway timeout (504)", failed(504)],
    ["a 503", failed(503, "tenant_not_ready")],
    ["a 429", failed(429)],
  ])("keeps the entry after %s, as the answer may not settle the attempt", (_name, outcome) => {
    const first = mount("sell");
    const key = first.keys.keyFor("sale:5");
    first.keys.done(outcome);
    expect(entries()).toEqual([`${PREFIX}sell`]);
    first.unmount();
    expect(mount("sell").keys.keyFor("sale:5")).toBe(key);
  });

  it("makes a new key for a different signature and keeps the first request too, which has no settling answer yet", () => {
    const first = mount("buy");
    const key = first.keys.keyFor("order:10");
    first.keys.done(lost());
    first.unmount();
    const second = mount("buy");
    const other = second.keys.keyFor("order:20");
    expect(other).not.toBe(key);
    expect(JSON.parse(window.sessionStorage.getItem(`${PREFIX}buy`) ?? "null")).toEqual({
      attempts: [
        { signature: "order:10", key, at: expect.any(Number) },
        { signature: "order:20", key: other, at: expect.any(Number) },
      ],
    });
    second.unmount();
    expect(mount("buy").keys.keyFor("order:10")).toBe(key);
  });

  it("does not forget a request whose answer was lost when another request is tried and refused in between (changed amount, changed back)", () => {
    const first = mount("withdraw");
    const key100 = first.keys.keyFor("withdrawal:100");
    first.keys.done(lost());
    // Another amount: a new key, and a refusal that settles only that request.
    const key200 = first.keys.keyFor("withdrawal:200");
    expect(key200).not.toBe(key100);
    first.keys.done(failed(409, "insufficient_credits"));
    expect(first.keys.keyFor("withdrawal:100")).toBe(key100);
    // The same after a reload.
    first.unmount();
    expect(mount("withdraw").keys.keyFor("withdrawal:100")).toBe(key100);
  });

  it("settles only the request of the last keyFor: a success of one amount leaves the lost request of another pending", () => {
    const first = mount("deposit");
    const key100 = first.keys.keyFor("deposit:100");
    first.keys.done(lost());
    first.keys.keyFor("deposit:200");
    first.keys.done();
    expect(entries()).toEqual([`${PREFIX}deposit`]);
    first.unmount();
    expect(mount("deposit").keys.keyFor("deposit:100")).toBe(key100);
  });

  it("keeps at most five requests without a settling answer and forgets the oldest first", () => {
    const first = mount("buy");
    const keys = ["a", "b", "c", "d", "e", "f"].map((name) => {
      const key = first.keys.keyFor(`order:${name}`);
      first.keys.done(lost());
      return key;
    });
    first.unmount();
    const second = mount("buy");
    expect(second.keys.keyFor("order:f")).toBe(keys[5]);
    expect(second.keys.keyFor("order:b")).toBe(keys[1]);
    expect(second.keys.keyFor("order:a")).not.toBe(keys[0]);
  });

  it("does not share keys between scopes", () => {
    const buy = mount("buy");
    const sell = mount("sell");
    const buyKey = buy.keys.keyFor("same-signature");
    const sellKey = sell.keys.keyFor("same-signature");
    expect(sellKey).not.toBe(buyKey);
    expect(entries().sort()).toEqual([`${PREFIX}buy`, `${PREFIX}sell`]);
    // Settling one scope leaves the other one pending.
    buy.keys.done();
    expect(entries()).toEqual([`${PREFIX}sell`]);
    sell.unmount();
    expect(mount("sell").keys.keyFor("same-signature")).toBe(sellKey);
  });

  it("follows a scope that changes between renders, each scope with its own entry", () => {
    const view = renderHook(({ scope }) => useIdempotencyKey(scope), { initialProps: { scope: "buy:market-a" } });
    const keyA = view.result.current.keyFor("order:10");
    view.rerender({ scope: "buy:market-b" });
    const keyB = view.result.current.keyFor("order:10");
    expect(keyB).not.toBe(keyA);
    view.rerender({ scope: "buy:market-a" });
    expect(view.result.current.keyFor("order:10")).toBe(keyA);
  });

  it("stores the signature, the key and the time of an attempt and nothing else (and the payload when the form passes one)", () => {
    const { keys } = mount("deposit");
    const key = keys.keyFor("deposit:1250");
    expect(entries()).toEqual([`${PREFIX}deposit`]);
    const stored = JSON.parse(window.sessionStorage.getItem(`${PREFIX}deposit`) ?? "{}") as { attempts: Record<string, unknown>[] };
    expect(Object.keys(stored)).toEqual(["attempts"]);
    expect(Object.keys(stored.attempts[0] ?? {}).sort()).toEqual(["at", "key", "signature"]);
    keys.keyFor("deposit:5", { amount: 5 });
    const withPayload = JSON.parse(window.sessionStorage.getItem(`${PREFIX}deposit`) ?? "{}") as { attempts: Record<string, unknown>[] };
    expect(Object.keys(withPayload.attempts[1] ?? {}).sort()).toEqual(["at", "key", "payload", "signature"]);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.length).toBe(0);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ignores a stored entry that is not a list of attempts with a signature, a key and a time", () => {
    const attempt = { signature: "order:10", key: "k-pending-key-x", at: Date.now() };
    for (const text of [
      "not json",
      "null",
      "[]",
      "{}",
      JSON.stringify({ attempts: "order:10" }),
      JSON.stringify({ signature: "order:10", key: "k-pending-key-x" }),
      JSON.stringify({ attempts: [{ signature: "order:10" }] }),
      JSON.stringify({ attempts: [{ signature: 5, key: "k", at: Date.now() }] }),
      JSON.stringify({ attempts: [{ signature: "order:10", key: "", at: Date.now() }] }),
      JSON.stringify({ attempts: [{ signature: "order:10", key: "k-pending-key-x" }] }),
      JSON.stringify({ attempts: [{ ...attempt, at: "yesterday" }] }),
    ]) {
      window.sessionStorage.setItem(`${PREFIX}buy`, text);
      const key = mount("buy").keys.keyFor("order:10");
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      window.sessionStorage.clear();
    }
  });

  it("still works with the key in memory when the storage throws (private mode, quota, disabled storage)", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { keys } = mount("buy");
    const key = keys.keyFor("order:10");
    // The storage was tried and its failure did not reach the caller.
    expect(write).toHaveBeenCalled();
    keys.done(lost());
    expect(keys.keyFor("order:10")).toBe(key);
    expect(keys.keyFor("order:20")).not.toBe(key);
    // Settles order:20; order:10 still has no settling answer, so the list is written, not removed.
    expect(() => keys.done()).not.toThrow();
    expect(read).toHaveBeenCalled();
    // Settling the last one empties the list: the removal is tried, and its failure does not reach the caller either.
    expect(keys.keyFor("order:10")).toBe(key);
    expect(() => keys.done()).not.toThrow();
    expect(remove).toHaveBeenCalled();
    expect(keys.keyFor("order:20")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("works when the storage object itself cannot be reached", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { keys } = mount("buy");
    const key = keys.keyFor("order:10");
    keys.done(lost());
    expect(keys.keyFor("order:10")).toBe(key);
    keys.done();
    expect(keys.keyFor("order:10")).not.toBe(key);
  });

  it("keeps the key after an error that is not an answer of the service (nothing says the request did not pass)", () => {
    const first = mount("buy");
    const key = first.keys.keyFor("order:10");
    first.keys.done(new TypeError("terminated"));
    first.unmount();
    expect(mount("buy").keys.keyFor("order:10")).toBe(key);
  });
});

describe("useIdempotencyKey with a storage that fails halfway", () => {
  it("does not find the key of a settled attempt after a reload when the entry could not be removed (it is overwritten with an empty list)", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const first = mount("deposit");
    const key = first.keys.keyFor("deposit:100");
    first.keys.done();
    first.unmount();
    expect(mount("deposit").keys.keyFor("deposit:100")).not.toBe(key);
  });

  it("keeps the older attempt that is still pending when a later write fails", () => {
    const first = mount("deposit");
    const key100 = first.keys.keyFor("deposit:100");
    first.keys.done(lost());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    // In memory the newer attempt has its key; the storage still holds the older one, which keeps its protection.
    const key200 = first.keys.keyFor("deposit:200");
    expect(first.keys.keyFor("deposit:200")).toBe(key200);
    first.unmount();
    vi.restoreAllMocks();
    expect(mount("deposit").keys.keyFor("deposit:100")).toBe(key100);
  });
});

describe("useIdempotencyKey for the signed-in user", () => {
  const auth = (id: string, tenantId: string | null): AuthContextValue => ({
    status: "authenticated",
    user: { id, username: "name", name: "Name", email: null, roles: ["trader"], tenantId },
    error: null,
    notice: null,
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    getAccessToken: () => Promise.resolve("token"),
    refreshSession: () => Promise.resolve(true),
    expireSession: () => Promise.resolve(),
  });
  const mountAs = (value: AuthContextValue, scope: string) => {
    const view = renderHook(() => useIdempotencyKey(scope), { wrapper: ({ children }) => <AuthContext value={value}>{children}</AuthContext> });
    return { keys: view.result.current, unmount: view.unmount };
  };

  it("names the entry after the user and the tenant, so that another person who signs in in the same tab never sends the key", () => {
    const user = auth("user-a", "tenant-1");
    const first = mountAs(user, "buy:m1");
    const key = first.keys.keyFor("order:10");
    first.keys.done(lost());
    first.unmount();
    expect(entries()).toEqual([`${PREFIX}user-a.tenant-1.buy:m1`]);
    expect(mountAs(auth("user-b", "tenant-1"), "buy:m1").keys.keyFor("order:10")).not.toBe(key);
    expect(mountAs(auth("user-a", "tenant-2"), "buy:m1").keys.keyFor("order:10")).not.toBe(key);
    // The same user in the same tenant finds it again.
    expect(mountAs(user, "buy:m1").keys.keyFor("order:10")).toBe(key);
  });

  it("does not offer the pending request of one user to another", () => {
    const first = mountAs(auth("user-a", null), "buy:m1");
    first.keys.keyFor("order:10", { amount: 10 });
    first.unmount();
    const other = renderHook(() => useIdempotencyKey("buy:m1"), { wrapper: ({ children }) => <AuthContext value={auth("user-b", null)}>{children}</AuthContext> });
    expect(other.result.current.pending).toBeNull();
    const same = renderHook(() => useIdempotencyKey("buy:m1"), { wrapper: ({ children }) => <AuthContext value={auth("user-a", null)}>{children}</AuthContext> });
    expect(same.result.current.pending?.payload).toEqual({ amount: 10 });
  });
});

describe("useIdempotencyKey age limit", () => {
  const HOUR = 3_600_000;

  it("finds an attempt again within a day of the moment its key was made, and makes a new key after that", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T08:00:00Z"));
    const first = mount("deposit");
    const key = first.keys.keyFor("deposit:100");
    first.keys.done(lost());
    first.unmount();
    vi.setSystemTime(Date.now() + 23 * HOUR);
    const within = mount("deposit");
    expect(within.keys.keyFor("deposit:100")).toBe(key);
    within.unmount();
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const after = mount("deposit");
    expect(after.keys.pending).toBeNull();
    expect(after.keys.keyFor("deposit:100")).not.toBe(key);
  });
});

describe("useIdempotencyKey pending request", () => {
  const body = { marketId: "m1", side: "YES", amount: 10, maxAveragePriceMicro: 555_500 };

  it("hands back the newest request without a settling answer with the payload it was made with, also after a reload", () => {
    const first = renderHook(() => useIdempotencyKey("buy:m1"));
    expect(first.result.current.pending).toBeNull();
    const key = first.result.current.keyFor("buy:m1:YES:10:555500", body);
    first.result.current.done(lost());
    first.rerender();
    expect(first.result.current.pending).toEqual({ signature: "buy:m1:YES:10:555500", key, payload: body, at: expect.any(Number) });
    first.unmount();
    const second = renderHook(() => useIdempotencyKey("buy:m1"));
    expect(second.result.current.pending?.payload).toEqual(body);
    // Sending exactly that request again finds its key, whatever quote the page has now.
    expect(second.result.current.keyFor("buy:m1:YES:10:555500", body)).toBe(key);
  });

  it("has no pending request after a settling answer, and discard() forgets the newest one", () => {
    const view = renderHook(() => useIdempotencyKey("buy:m1"));
    view.result.current.keyFor("order:1", body);
    view.result.current.done();
    view.rerender();
    expect(view.result.current.pending).toBeNull();
    const first = view.result.current.keyFor("order:1", body);
    view.result.current.done(lost());
    const second = view.result.current.keyFor("order:2", body);
    view.result.current.done(lost());
    view.rerender();
    expect(view.result.current.pending?.key).toBe(second);
    view.result.current.discard();
    view.rerender();
    expect(view.result.current.pending?.key).toBe(first);
    view.result.current.discard();
    view.rerender();
    expect(view.result.current.pending).toBeNull();
    expect(entries()).toEqual([]);
    expect(view.result.current.keyFor("order:2", body)).not.toBe(second);
  });
});
