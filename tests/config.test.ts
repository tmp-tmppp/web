import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config/runtime-config";
import { server } from "./support/server";

describe("parseConfig", () => {
  it("accepts a complete file", () => {
    expect(
      parseConfig({
        issuer: "https://chance.example/realms/chance",
        clientId: "web",
        apiBase: "https://api.example",
        depositSuccessPath: "/ok",
        depositCancelPath: "/no",
      }),
    ).toEqual({
      issuer: "https://chance.example/realms/chance",
      clientId: "web",
      apiBase: "https://api.example",
      depositSuccessPath: "/ok",
      depositCancelPath: "/no",
    });
  });

  it("fills the optional settings with the values the other services expect", () => {
    expect(parseConfig({ issuer: "http://localhost:8081/realms/chance" })).toEqual({
      issuer: "http://localhost:8081/realms/chance",
      clientId: "web",
      apiBase: "",
      depositSuccessPath: "/deposits/success",
      depositCancelPath: "/deposits/cancelled",
    });
  });

  it("removes trailing slashes from the issuer and the API base", () => {
    const config = parseConfig({ issuer: "https://idp.example/realms/chance/", apiBase: "https://api.example//" });
    expect(config.issuer).toBe("https://idp.example/realms/chance");
    expect(config.apiBase).toBe("https://api.example");
    expect(parseConfig({ issuer: "https://idp.example/r", apiBase: "/gateway/" }).apiBase).toBe("/gateway");
  });

  it("uses the default client id when the file leaves it blank", () => {
    expect(parseConfig({ issuer: "https://idp.example/r", clientId: "  " }).clientId).toBe("web");
  });

  it.each([
    ["a list", []],
    ["a string", "text"],
    ["null", null],
  ])("rejects %s instead of an object", (_name, value) => {
    expect(() => parseConfig(value)).toThrow(ConfigError);
  });

  it.each([
    ["no issuer", {}, /"issuer" is required/],
    ["a blank issuer", { issuer: " " }, /"issuer" is required/],
    ["an issuer that is not a string", { issuer: 5 }, /"issuer" must be a string/],
    ["an issuer without a scheme", { issuer: "idp.example/realms/chance" }, /absolute http or https/],
    ["an issuer with another scheme", { issuer: "ftp://idp.example/realms/chance" }, /absolute http or https/],
    ["an API base that is neither a path nor an address", { issuer: "https://i.example/r", apiBase: "api" }, /apiBase/],
    ["a protocol-relative API base", { issuer: "https://i.example/r", apiBase: "//evil.example" }, /apiBase/],
    ["a success path without a slash", { issuer: "https://i.example/r", depositSuccessPath: "ok" }, /depositSuccessPath/],
    ["a cancel path that leaves the site", { issuer: "https://i.example/r", depositCancelPath: "//evil.example/x" }, /depositCancelPath/],
    ["a cancel path with a backslash", { issuer: "https://i.example/r", depositCancelPath: "/\\evil" }, /depositCancelPath/],
  ])("rejects %s", (_name, value, message) => {
    expect(() => parseConfig(value)).toThrow(message);
  });
});

describe("loadConfig", () => {
  const url = "http://app.test/config.json";

  it("loads and validates the file", async () => {
    server.use(http.get(url, () => HttpResponse.json({ issuer: "https://idp.example/realms/chance" })));
    await expect(loadConfig(undefined, url)).resolves.toMatchObject({ issuer: "https://idp.example/realms/chance", clientId: "web" });
  });

  it("asks for a fresh copy every time", async () => {
    const fake = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({ issuer: "https://idp.example/realms/chance" })));
    await loadConfig(fake);
    expect(fake.mock.calls[0]).toEqual(["/config.json", expect.objectContaining({ cache: "no-store" })]);
  });

  it("reports an HTTP error", async () => {
    server.use(http.get(url, () => new HttpResponse(null, { status: 404 })));
    await expect(loadConfig(undefined, url)).rejects.toThrow("HTTP 404");
  });

  it("reports a file that is not JSON", async () => {
    server.use(http.get(url, () => new HttpResponse("<html>", { status: 200 })));
    await expect(loadConfig(undefined, url)).rejects.toThrow("not valid JSON");
  });

  it("reports an unreachable server", async () => {
    server.use(http.get(url, () => HttpResponse.error()));
    await expect(loadConfig(undefined, url)).rejects.toThrow("did not answer");
  });

  it("reports a wrong setting by name", async () => {
    server.use(http.get(url, () => HttpResponse.json({ issuer: "nope" })));
    await expect(loadConfig(undefined, url)).rejects.toThrow('"issuer"');
  });

  it("uses an injected fetch", async () => {
    const fake = (() => Promise.resolve(Response.json({ issuer: "https://idp.example/realms/chance" }))) as typeof fetch;
    await expect(loadConfig(fake)).resolves.toMatchObject({ clientId: "web" });
  });
});
