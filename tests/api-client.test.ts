import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client";
import { ApiError, fallbackProblem, parseRetryAfter, problemFromBody } from "../src/api/errors";
import { server } from "./support/server";

const BASE = "http://gateway.test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function client(overrides: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  return createApiClient({ baseUrl: BASE, getAccessToken: () => Promise.resolve("token-1"), ...overrides });
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("requests", () => {
  it("sends the bearer token, a correlation id and no cookies", async () => {
    let seen: Headers | undefined;
    server.use(
      http.get(`${BASE}/v1/me`, ({ request }) => {
        seen = request.headers;
        return HttpResponse.json({ userId: "u1" });
      }),
    );
    const data = await client().get<{ userId: string }>("/v1/me");
    expect(data).toEqual({ userId: "u1" });
    expect(seen?.get("authorization")).toBe("Bearer token-1");
    expect(seen?.get("x-correlation-id")).toMatch(UUID);
    expect(seen?.get("accept")).toContain("application/problem+json");
  });

  it("asks the browser to send no cookies and to keep no copy of the answer", async () => {
    const fake = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({})));
    await createApiClient({ baseUrl: BASE, getAccessToken: () => Promise.resolve("t"), fetchImpl: fake }).get("/v1/me");
    expect(fake.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", cache: "no-store" });
  });

  it("makes a new correlation id for every request", async () => {
    const ids: string[] = [];
    server.use(
      http.get(`${BASE}/v1/me`, ({ request }) => {
        ids.push(request.headers.get("x-correlation-id") ?? "");
        return HttpResponse.json({});
      }),
    );
    const api = client();
    await api.get("/v1/me");
    await api.get("/v1/me");
    expect(new Set(ids).size).toBe(2);
  });

  it("sends no Authorization header without a session", async () => {
    let authorization: string | null = "unset";
    server.use(
      http.get(`${BASE}/v1/me`, ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json({});
      }),
    );
    await client({ getAccessToken: () => Promise.resolve(null) }).get("/v1/me");
    expect(authorization).toBeNull();
  });

  it("adds the query, leaving out empty values", async () => {
    let search = "";
    server.use(
      http.get(`${BASE}/v1/audit/events`, ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({ items: [] });
      }),
    );
    await client().get("/v1/audit/events", { type: "TenantCreated", from: "", actor: undefined, subject: null, limit: 50, flag: false });
    expect(search).toBe("?type=TenantCreated&limit=50&flag=false");
  });

  it("sends a JSON body with the idempotency key and returns the answer", async () => {
    let received: { headers: Headers; body: unknown } | undefined;
    server.use(
      http.post(`${BASE}/v1/deposits`, async ({ request }) => {
        received = { headers: request.headers, body: await request.json() };
        return HttpResponse.json({ id: "d1", checkoutUrl: "/checkout/1" }, { status: 201 });
      }),
    );
    const data = await client().post<{ id: string }>("/v1/deposits", { amount: 500 }, { idempotencyKey: "key-1" });
    expect(data.id).toBe("d1");
    expect(received?.body).toEqual({ amount: 500 });
    expect(received?.headers.get("idempotency-key")).toBe("key-1");
    expect(received?.headers.get("content-type")).toBe("application/json");
  });

  it("supports PUT and a POST without a body", async () => {
    let putBody: unknown;
    let postContentType: string | null = "unset";
    server.use(
      http.put(`${BASE}/v1/tenants/t1/members/u1/role`, async ({ request }) => {
        putBody = await request.json();
        return HttpResponse.json({ role: "trader" });
      }),
      http.post(`${BASE}/v1/things`, ({ request }) => {
        postContentType = request.headers.get("content-type");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const api = client();
    await expect(api.put("/v1/tenants/t1/members/u1/role", { role: "trader" })).resolves.toEqual({ role: "trader" });
    expect(putBody).toEqual({ role: "trader" });
    await expect(api.post("/v1/things")).resolves.toBeUndefined();
    expect(postContentType).toBeNull();
  });

  it("gives the status and headers of an answer without a body (a 202 with a status link)", async () => {
    server.use(http.post(`${BASE}/v1/withdrawals`, () => new HttpResponse(null, { status: 202, headers: { Location: "/v1/withdrawals/w1" } })));
    const response = await client().request("/v1/withdrawals", { method: "POST", body: { amount: 100 } });
    expect(response.status).toBe(202);
    expect(response.data).toBeUndefined();
    expect(response.headers.get("location")).toBe("/v1/withdrawals/w1");
  });

  it("uses the correlation id the server echoed", async () => {
    server.use(http.get(`${BASE}/v1/me`, () => HttpResponse.json({}, { headers: { "X-Correlation-Id": "echoed-1" } })));
    expect((await client().request("/v1/me")).correlationId).toBe("echoed-1");
  });

  it("works with a base address that ends in a slash and with a relative base", async () => {
    server.use(http.get(`${BASE}/v1/me`, () => HttpResponse.json({ ok: true })));
    await expect(client({ baseUrl: `${BASE}/` }).get("/v1/me")).resolves.toEqual({ ok: true });

    const fake = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({ ok: true })));
    await createApiClient({ baseUrl: "", getAccessToken: () => Promise.resolve(null), fetchImpl: fake }).get("/v1/me", { a: 1 });
    expect(fake.mock.calls[0]).toEqual(["/v1/me?a=1", expect.objectContaining({ method: "GET" })]);
  });

  it("appends to a path that already has a query", async () => {
    const fake = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({})));
    await createApiClient({ baseUrl: "", getAccessToken: () => Promise.resolve(null), fetchImpl: fake }).get("/v1/x?a=1", { b: 2 });
    expect(fake.mock.calls[0]?.[0]).toBe("/v1/x?a=1&b=2");
  });

  it("uses the global fetch when none is injected", async () => {
    server.use(http.get(`${BASE}/v1/me`, () => HttpResponse.json({ ok: true })));
    await expect(createApiClient({ baseUrl: BASE, getAccessToken: () => Promise.resolve(null) }).get("/v1/me")).resolves.toEqual({ ok: true });
  });
});

describe("errors", () => {
  it("turns a problem answer into a typed error", async () => {
    server.use(
      http.post(`${BASE}/v1/tenants`, () =>
        HttpResponse.json(
          {
            type: "urn:chance:problem:validation",
            title: "The request is invalid",
            status: 400,
            detail: "Two fields are wrong",
            code: "invalid_request",
            instance: "/v1/tenants",
            errors: [
              { field: "name", message: "is required" },
              { field: "slug", message: "is too long" },
              { broken: true },
            ],
          },
          { status: 400, headers: { "Content-Type": "application/problem+json", "X-Correlation-Id": "c-9" } },
        ),
      ),
    );
    const error = await failure(client().post("/v1/tenants", {}));
    expect(error).toMatchObject({
      status: 400,
      type: "urn:chance:problem:validation",
      title: "The request is invalid",
      detail: "Two fields are wrong",
      code: "invalid_request",
      instance: "/v1/tenants",
      correlationId: "c-9",
      retryAfterSeconds: null,
      isNetworkError: false,
      isRetryable: false,
    });
    expect(error.fieldErrors).toEqual([
      { field: "name", message: "is required" },
      { field: "slug", message: "is too long" },
    ]);
    expect(error.message).toBe("The request is invalid: Two fields are wrong");
  });

  it("reads Retry-After in seconds and as a date", async () => {
    server.use(
      http.get(`${BASE}/v1/audit/verify`, () =>
        HttpResponse.json({ type: "t", title: "Verification is busy", status: 503, code: "verify_busy" }, { status: 503, headers: { "Content-Type": "application/problem+json", "Retry-After": "7" } }),
      ),
      http.get(`${BASE}/v1/other`, () =>
        HttpResponse.json({ title: "Busy", status: 503 }, { status: 503, headers: { "Content-Type": "application/problem+json", "Retry-After": new Date(Date.now() + 30_000).toUTCString() } }),
      ),
    );
    const busy = await failure(client().get("/v1/audit/verify"));
    expect(busy).toMatchObject({ code: "verify_busy", retryAfterSeconds: 7, isRetryable: true });
    const dated = await failure(client().get("/v1/other"));
    expect(dated.retryAfterSeconds).toBeGreaterThan(20);
    expect(dated.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("never passes a body that is not a problem on", async () => {
    server.use(http.get(`${BASE}/v1/me`, () => new HttpResponse("<html><body>Bad gateway at proxy-7</body></html>", { status: 502, headers: { "Content-Type": "text/html" } })));
    const error = await failure(client().get("/v1/me"));
    expect(error.status).toBe(502);
    expect(error.title).toBe("The service is not available");
    expect(error.message).not.toContain("proxy-7");
    expect(error.fieldErrors).toEqual([]);
  });

  it("keeps a problem without a detail free of the generic detail", async () => {
    server.use(http.get(`${BASE}/v1/me`, () => HttpResponse.json({ type: "t", title: "Not found", status: 404 }, { status: 404, headers: { "Content-Type": "application/problem+json" } })));
    expect((await failure(client().get("/v1/me"))).detail).toBeNull();
  });

  it("describes a network failure", async () => {
    server.use(http.get(`${BASE}/v1/me`, () => HttpResponse.error()));
    const error = await failure(client().get("/v1/me"));
    expect(error).toMatchObject({ status: 0, isNetworkError: true, title: "The server cannot be reached" });
    expect(error.correlationId).toMatch(UUID);
  });

  it("lets an aborted request through as an abort", async () => {
    server.use(http.get(`${BASE}/v1/me`, () => HttpResponse.json({})));
    await expect(client().get("/v1/me", undefined, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a success answer that is not JSON", async () => {
    server.use(
      http.get(`${BASE}/v1/html`, () => new HttpResponse("<html>", { status: 200, headers: { "Content-Type": "text/html" } })),
      http.get(`${BASE}/v1/broken`, () => new HttpResponse("{", { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    expect((await failure(client().get("/v1/html"))).title).toBe("The server sent an answer the app cannot read");
    // A success status whose body cannot be read is an answer the service gave: the request may have been made.
    expect((await failure(client().get("/v1/html"))).outcomeUnknown).toBe(true);
    expect((await failure(client().get("/v1/broken"))).title).toBe("The server sent an answer the app cannot read");
  });

  it("turns a success answer whose body breaks off into the same error, not into a raw TypeError", async () => {
    const broken = () => new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError("terminated")) }), { status: 201, headers: { "Content-Type": "application/json" } });
    const error = await failure(client({ fetchImpl: () => Promise.resolve(broken()) }).post("/v1/trading/orders", { amount: 10 }, { idempotencyKey: "key-pending-key-x" }));
    expect(error.status).toBe(201);
    expect(error.title).toBe("The server sent an answer the app cannot read");
    expect(error.outcomeUnknown).toBe(true);
  });
});

describe("401 handling", () => {
  function twoTokens() {
    server.use(
      http.get(`${BASE}/v1/me`, ({ request }) =>
        request.headers.get("authorization") === "Bearer new"
          ? HttpResponse.json({ userId: "u1" })
          : HttpResponse.json({ type: "t", title: "Token expired", status: 401 }, { status: 401, headers: { "Content-Type": "application/problem+json" } }),
      ),
    );
  }

  it("renews the session once and repeats the request with the new token", async () => {
    twoTokens();
    const getAccessToken = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const refreshSession = vi.fn().mockResolvedValue(true);
    const onUnauthorized = vi.fn();
    await expect(client({ getAccessToken, refreshSession, onUnauthorized }).get("/v1/me")).resolves.toEqual({ userId: "u1" });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("ends the session when the renewal fails", async () => {
    twoTokens();
    const onUnauthorized = vi.fn();
    const error = await failure(client({ getAccessToken: () => Promise.resolve("old"), refreshSession: () => Promise.resolve(false), onUnauthorized }).get("/v1/me"));
    expect(error.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("ends the session when the repeated request is refused again", async () => {
    twoTokens();
    const onUnauthorized = vi.fn();
    await failure(client({ getAccessToken: () => Promise.resolve("old"), refreshSession: () => Promise.resolve(true), onUnauthorized }).get("/v1/me"));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("reports a 401 without a renewal function", async () => {
    twoTokens();
    const onUnauthorized = vi.fn();
    await failure(client({ getAccessToken: () => Promise.resolve("old"), onUnauthorized }).get("/v1/me"));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not need an onUnauthorized callback", async () => {
    twoTokens();
    await failure(client({ getAccessToken: () => Promise.resolve("old") }).get("/v1/me"));
  });
});

describe("error helpers", () => {
  it("parses Retry-After", () => {
    const now = Date.parse("2026-11-11T10:00:00Z");
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(" 12 ")).toBe(12);
    expect(parseRetryAfter("Wed, 11 Nov 2026 10:00:45 GMT", now)).toBe(45);
    expect(parseRetryAfter("Wed, 11 Nov 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("recognizes only a body with a title as a problem", () => {
    expect(problemFromBody(null)).toBeNull();
    expect(problemFromBody([])).toBeNull();
    expect(problemFromBody({ detail: "x" })).toBeNull();
    expect(problemFromBody({ title: "T" })).toEqual({ type: "about:blank", title: "T", status: 0 });
    expect(problemFromBody({ title: "T", errors: "x" })).toEqual({ type: "about:blank", title: "T", status: 0 });
    expect(problemFromBody({ title: "T", errors: [null, 3] })).toEqual({ type: "about:blank", title: "T", status: 0 });
  });

  it("has words for every status", () => {
    for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504, 418]) {
      const { title, detail } = fallbackProblem(status);
      expect(title).not.toBe("");
      expect(detail).not.toBe("");
    }
    expect(fallbackProblem(418).detail).toContain("418");
    expect(fallbackProblem(500).title).toContain("server");
  });
});
