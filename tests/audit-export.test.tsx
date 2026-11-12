import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FILTERS } from "../src/api/audit";
import { ApiError } from "../src/api/errors";
import { fileNameFrom, requestAuditExport } from "../src/api/auditExport";
import { ConfigError, parseConfig } from "../src/config/runtime-config";
import type { AppConfig } from "../src/config/types";
import { saveBlob } from "../src/lib/download";
import { contractHandler, reply } from "./support/contract";
import { tenantAdminOidc } from "./support/fixtures";
import { renderApp, TEST_CONFIG } from "./support/render";
import { server } from "./support/server";

const EXPORT_URL = "http://export.test/api/audit-export";
const CONFIG = { ...TEST_CONFIG, auditExportUrl: EXPORT_URL };
const CSV = "seq,eventId\r\n2,e-2\r\n1,e-1\r\n";
const typing = () => userEvent.setup({ delay: null });

function problem(status: number, code: string, title: string, detail: string, headers: Record<string, string> = {}) {
  return HttpResponse.json(
    { type: `urn:chance:problem:${code}`, title, status, detail, code },
    { status, headers: { "Content-Type": "application/problem+json", "X-Correlation-Id": "srv-corr-7", ...headers } },
  );
}

function file(body: string, headers: Record<string, string> = {}) {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="audit-acme-2026-11-11.csv"', "X-Export-Rows": "2", "X-Export-Truncated": "false", "X-Correlation-Id": "srv-corr-1", ...headers },
  });
}

/** What the page handed to the browser's download: the saved file name and the blobs behind the object addresses. */
let saved: { download: string; href: string }[] = [];
let blobs: Blob[] = [];
let revoke = vi.fn();

beforeEach(() => {
  saved = [];
  blobs = [];
  revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:test/${blobs.length}`;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ download: this.download, href: this.href });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

const emptyList = () => server.use(contractHandler("listAuditEntries", () => reply(200, { items: [], nextCursor: null })));
const open = (config: AppConfig = CONFIG) => {
  emptyList();
  return renderApp({ user: tenantAdminOidc(), path: "/audit", config });
};

describe("audit page: the Export control", () => {
  it("is not there when the configuration names no export function", async () => {
    open(TEST_CONFIG);
    await screen.findByText("No entries match.");
    expect(screen.queryByRole("heading", { name: "Export the log" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
  });

  it("downloads the file with the user's own token and says how many entries it holds", async () => {
    let seen: { query: URLSearchParams; headers: Headers } | null = null;
    server.use(
      http.get(EXPORT_URL, ({ request }) => {
        seen = { query: new URL(request.url).searchParams, headers: request.headers };
        return file(CSV);
      }),
    );
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    expect(await screen.findByText(/Exported 2 entries to/)).toBeInTheDocument();
    expect(screen.getByText("audit-acme-2026-11-11.csv")).toBeInTheDocument();
    expect([...(seen as unknown as { query: URLSearchParams }).query.entries()]).toEqual([["format", "csv"]]);
    const headers = (seen as unknown as { headers: Headers }).headers;
    expect(headers.get("authorization")).toMatch(/^Bearer .+\..+\..+$/);
    expect(headers.get("x-correlation-id")).toBeTruthy();
    expect(saved).toEqual([{ download: "audit-acme-2026-11-11.csv", href: "blob:test/1" }]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.size).toBe(CSV.length);
  });

  it("exports the filters that were applied, in the chosen format", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(EXPORT_URL, ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return file('{"seq":1}\n', { "Content-Type": "application/x-ndjson", "Content-Disposition": 'attachment; filename="audit-acme-2026-11-11.jsonl"', "X-Export-Rows": "1" });
      }),
    );
    open();
    const user = typing();
    await user.type(await screen.findByLabelText("Event types"), "a.b.v1, c.d.v1");
    await user.type(screen.getByLabelText("Actor"), "user-7");
    // Typed but not applied: the export must not use it yet.
    await user.type(screen.getByLabelText("Subject"), "market-3");
    await user.selectOptions(screen.getByLabelText("File format"), "jsonl");
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByText(/Exported 1 entry to/)).toBeInTheDocument();
    expect(queries).toHaveLength(1);
    expect(Object.fromEntries(queries[0] as URLSearchParams)).toEqual({ format: "jsonl" });

    await user.click(screen.getByRole("button", { name: "Apply the filters" }));
    await screen.findByText("No entries match.");
    await user.click(screen.getByRole("button", { name: "Export" }));
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    expect(Object.fromEntries(queries[1] as URLSearchParams)).toEqual({ format: "jsonl", type: "a.b.v1,c.d.v1", actor: "user-7", subject: "market-3" });
    expect(saved.at(-1)?.download).toBe("audit-acme-2026-11-11.jsonl");
  });

  it("says plainly that the file was cut at the limit", async () => {
    server.use(http.get(EXPORT_URL, () => file(CSV, { "X-Export-Truncated": "true", "X-Export-Rows": "50000", "Content-Disposition": 'attachment; filename="audit-acme-2026-11-11-truncated.csv"' })));
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The file is not complete.");
    expect(alert).toHaveTextContent("cut at 50000 entries, the limit of one export");
    expect(alert).toHaveTextContent("audit-acme-2026-11-11-truncated.csv");
    expect(alert).toHaveTextContent("Narrow the filters");
    expect(screen.queryByText(/Exported 50000 entries/)).not.toBeInTheDocument();
    // The file is still saved: the newest entries are what the user asked for first.
    expect(saved).toHaveLength(1);
  });

  it("says so when the browser may not read how many rows the file holds, but can read that it was cut", async () => {
    server.use(http.get(EXPORT_URL, () => new HttpResponse(CSV, { status: 200, headers: { "Content-Type": "text/csv", "X-Export-Truncated": "true" } })));
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cut at its limit");
  });

  it("never calls a file complete when the browser may not read X-Export-Truncated: it warns and marks the file name", async () => {
    // What a CORS layer that drops Access-Control-Expose-Headers leaves: no X-Export-* and no Content-Disposition.
    server.use(http.get(EXPORT_URL, () => new HttpResponse(CSV, { status: 200, headers: { "Content-Type": "text/csv" } })));
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The file was saved, but whether it is complete could not be confirmed.");
    expect(alert).toHaveTextContent("audit-export-unverified.csv");
    expect(alert).toHaveTextContent("expose X-Export-Truncated");
    expect(screen.queryByText(/Exported/)).not.toBeInTheDocument();
    expect(saved.at(-1)?.download).toBe("audit-export-unverified.csv");
  });

  it("says plainly that the file is complete when the function says so", async () => {
    server.use(http.get(EXPORT_URL, () => file(CSV)));
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    expect(await screen.findByText(/Exported 2 entries to/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the problem of a refusal, with the reference to quote, and saves nothing", async () => {
    server.use(http.get(EXPORT_URL, () => problem(403, "forbidden", "Forbidden", "The tenant-admin role is required")));
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The log could not be exported");
    expect(alert).toHaveTextContent("The tenant-admin role is required");
    expect(alert).toHaveTextContent("Reference: srv-corr-7");
    expect(saved).toEqual([]);
  });

  it("tells how long to wait when the service is busy, and lets the user try again", async () => {
    let answers = 0;
    server.use(http.get(EXPORT_URL, () => (++answers === 1 ? problem(503, "upstream_busy", "Service Unavailable", "The audit service is busy; try again later", { "Retry-After": "30" }) : file(CSV))));
    open();
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Export" }));
    expect(await screen.findByText(/Try again in/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByText(/Exported 2 entries to/)).toBeInTheDocument();
    expect(screen.queryByText(/Try again in/)).not.toBeInTheDocument();
  });

  it("says when the function cannot be reached", async () => {
    server.use(http.get(EXPORT_URL, () => HttpResponse.error()));
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The server cannot be reached");
  });

  it("blocks a second export while one is running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    server.use(
      http.get(EXPORT_URL, async () => {
        calls += 1;
        await gate;
        return file(CSV);
      }),
    );
    open();
    const user = typing();
    await user.click(await screen.findByRole("button", { name: "Export" }));
    expect(await screen.findByText("Preparing the file...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(screen.getByLabelText("File format")).toBeDisabled();
    release();
    expect(await screen.findByText(/Exported 2 entries to/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    expect(calls).toBe(1);
  });

  it("cancels an export that is still running when the page is left, and saves nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    server.use(
      http.get(EXPORT_URL, async () => {
        started = true;
        await gate;
        return file(CSV);
      }),
    );
    open();
    await typing().click(await screen.findByRole("button", { name: "Export" }));
    await vi.waitFor(() => expect(started).toBe(true));
    cleanup();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(saved).toEqual([]);
  });
});

describe("requestAuditExport", () => {
  const base = { url: EXPORT_URL, format: "csv" as const, filters: EMPTY_FILTERS, newCorrelationId: () => "corr-fixed" };

  it("renews the session once after a 401 and repeats the export with the new token", async () => {
    const tokens: (string | null)[] = [];
    server.use(
      http.get(EXPORT_URL, ({ request }) => {
        tokens.push(request.headers.get("authorization"));
        return request.headers.get("authorization") === "Bearer fresh" ? file(CSV) : problem(401, "unauthorized", "Unauthorized", "The token has expired");
      }),
    );
    let current = "old";
    const refreshSession = vi.fn(() => {
      current = "fresh";
      return Promise.resolve(true);
    });
    const onUnauthorized = vi.fn();
    const result = await requestAuditExport({ ...base, getAccessToken: () => Promise.resolve(current), refreshSession, onUnauthorized });
    expect(tokens).toEqual(["Bearer old", "Bearer fresh"]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fileName: "audit-acme-2026-11-11.csv", rows: 2, truncated: false, correlationId: "srv-corr-1" });
  });

  it("ends the session when the token is refused for good", async () => {
    server.use(http.get(EXPORT_URL, () => problem(401, "unauthorized", "Unauthorized", "The token is not valid")));
    const onUnauthorized = vi.fn();
    const failure = await requestAuditExport({ ...base, getAccessToken: () => Promise.resolve("t"), refreshSession: () => Promise.resolve(false), onUnauthorized }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 401, code: "unauthorized", correlationId: "srv-corr-7" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("sends no Authorization header without a session, asks for the format it wants, and keeps no cookie", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(file("{}\n", { "Content-Disposition": 'attachment; filename="audit-a-2026-11-11.jsonl"' })));
    await requestAuditExport({ ...base, format: "jsonl", getAccessToken: () => Promise.resolve(null), fetchImpl });
    const [address, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Accept"]).toContain("application/x-ndjson");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" });
    expect(new URL(address).searchParams.get("format")).toBe("jsonl");
  });

  it("reports a cut it cannot read as unknown, not as complete", async () => {
    const unreadable = { "X-Export-Truncated": "" };
    for (const [headers, expected] of [
      [{ "X-Export-Truncated": "TRUE" }, true],
      [{ "X-Export-Truncated": "false" }, false],
      [unreadable, null],
      [{ "X-Export-Truncated": "maybe" }, null],
    ] as const) {
      const fetchImpl = vi.fn(() => Promise.resolve(new HttpResponse(CSV, { status: 200, headers: { "Content-Type": "text/csv", ...headers } })));
      const result = await requestAuditExport({ ...base, getAccessToken: () => Promise.resolve("t"), fetchImpl });
      expect(result.truncated).toBe(expected);
    }
    // No header at all (the browser was not allowed to read it): unknown, rows unknown, and the plain name says unverified.
    const none = vi.fn(() => Promise.resolve(new HttpResponse(CSV, { status: 200, headers: { "Content-Type": "text/csv" } })));
    expect(await requestAuditExport({ ...base, format: "jsonl", getAccessToken: () => Promise.resolve("t"), fetchImpl: none })).toMatchObject({ truncated: null, rows: null, fileName: "audit-export-unverified.jsonl" });
    // A readable file name is kept even when the cut flag is not.
    const named = vi.fn(() => Promise.resolve(new HttpResponse(CSV, { status: 200, headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="audit-acme-2026-11-11.csv"' } })));
    expect(await requestAuditExport({ ...base, getAccessToken: () => Promise.resolve("t"), fetchImpl: named })).toMatchObject({ truncated: null, fileName: "audit-acme-2026-11-11.csv" });
  });

  it("passes a cancelled request on as the cancellation it is", async () => {
    server.use(http.get(EXPORT_URL, () => file(CSV)));
    const controller = new AbortController();
    controller.abort();
    const failure = await requestAuditExport({ ...base, getAccessToken: () => Promise.resolve("t"), signal: controller.signal }).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(ApiError);
  });
});

describe("fileNameFrom", () => {
  it("takes the name the function chose", () => {
    expect(fileNameFrom('attachment; filename="audit-acme-2026-11-11.csv"', "csv")).toBe("audit-acme-2026-11-11.csv");
  });

  it("reduces an odd name to safe characters and refuses a path or a wrong extension", () => {
    expect(fileNameFrom('attachment; filename="a b/../c.csv"', "csv")).toBe("a_b_.._c.csv");
    expect(fileNameFrom('attachment; filename="..hidden.csv"', "csv")).toBe("hidden.csv");
    expect(fileNameFrom('attachment; filename="report.exe"', "csv")).toBe("audit-export.csv");
    expect(fileNameFrom('attachment; filename="audit.csv"', "jsonl")).toBe("audit-export.jsonl");
  });

  it("falls back when the header is missing or has no name", () => {
    expect(fileNameFrom(null, "jsonl")).toBe("audit-export.jsonl");
    expect(fileNameFrom("attachment", "csv")).toBe("audit-export.csv");
  });
});

describe("saveBlob", () => {
  it("clicks a hidden link that carries the file name, and releases the address later", () => {
    vi.useFakeTimers();
    const blob = new Blob([CSV], { type: "text/csv" });
    saveBlob(blob, "audit.csv");
    expect(saved).toEqual([{ download: "audit.csv", href: "blob:test/1" }]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith("blob:test/1");
  });
});

describe("config: auditExportUrl", () => {
  const issuer = "https://idp.example/realms/chance";

  it("is optional and left out of the result when it is absent or empty", () => {
    expect("auditExportUrl" in parseConfig({ issuer })).toBe(false);
    expect("auditExportUrl" in parseConfig({ issuer, auditExportUrl: "  " })).toBe(false);
  });

  it("accepts an absolute http or https address and removes trailing slashes", () => {
    expect(parseConfig({ issuer, auditExportUrl: "https://chance-audit-export.example/api/audit-export" }).auditExportUrl).toBe("https://chance-audit-export.example/api/audit-export");
    expect(parseConfig({ issuer, auditExportUrl: "http://localhost:7071/api/audit-export//" }).auditExportUrl).toBe("http://localhost:7071/api/audit-export");
  });

  it.each([
    ["not an address", "audit-export"],
    ["not http", "ftp://export.example/api/audit-export"],
    ["with a query", "https://export.example/api/audit-export?code=1"],
    ["with an empty query", "https://export.example/api/audit-export?"],
    ["with a fragment", "https://export.example/api/audit-export#top"],
    ["with credentials", "https://user:secret@export.example/api/audit-export"],
  ])("refuses an address that is %s, naming the setting", (_label, value) => {
    expect(() => parseConfig({ issuer, auditExportUrl: value })).toThrow(ConfigError);
    expect(() => parseConfig({ issuer, auditExportUrl: value })).toThrow(/"auditExportUrl"/);
  });

  it("refuses a value that is not a string", () => {
    expect(() => parseConfig({ issuer, auditExportUrl: 7 })).toThrow('config.json: "auditExportUrl" must be a string');
  });
});
