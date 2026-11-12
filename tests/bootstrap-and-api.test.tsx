import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider, useApi } from "../src/api/ApiContext";
import type { ApiError } from "../src/api/errors";
import { AuthProvider } from "../src/auth/AuthContext";
import { Bootstrap } from "../src/Bootstrap";
import { ConfigContext, useConfig } from "../src/config/ConfigContext";
import { ConfigError } from "../src/config/runtime-config";
import { createFakeOidc, oidcUser } from "./support/fake-oidc";
import { TEST_CONFIG } from "./support/render";
import { server } from "./support/server";

describe("Bootstrap", () => {
  it("loads the configuration, then shows the app", async () => {
    const oidc = createFakeOidc(null);
    render(<Bootstrap load={() => Promise.resolve(TEST_CONFIG)} createManager={() => oidc.client} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("builds the real OIDC client when none is given", async () => {
    render(<Bootstrap load={() => Promise.resolve(TEST_CONFIG)} />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("stops with the reason when the configuration is wrong", async () => {
    render(<Bootstrap load={() => Promise.reject(new ConfigError('config.json: "issuer" is required'))} />);
    expect(await screen.findByRole("heading", { name: "The app cannot start" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent('"issuer" is required');
  });

  it("stops with a general message when the failure is not an error object", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test: a rejection that is not an Error
    render(<Bootstrap load={() => Promise.reject("boom")} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read");
  });

  it("reads /config.json by default, and says so when no server answers", async () => {
    // The test environment has no page origin for a relative address, so the default load fails the way an unreachable server does.
    render(<Bootstrap />);
    expect(await screen.findByRole("alert")).toHaveTextContent("config.json could not be loaded");
  });

  it("ignores a result that arrives after the page went away", async () => {
    let resolve: (value: typeof TEST_CONFIG) => void = () => undefined;
    const view = render(<Bootstrap load={() => new Promise((done) => (resolve = done))} />);
    view.unmount();
    resolve(TEST_CONFIG);
    await Promise.resolve();
  });
});

describe("ConfigContext", () => {
  function Reader() {
    return <p>{useConfig().clientId}</p>;
  }

  it("hands the configuration to the components", () => {
    render(
      <ConfigContext value={TEST_CONFIG}>
        <Reader />
      </ConfigContext>,
    );
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("is required", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Reader />)).toThrow("useConfig must be used");
    quiet.mockRestore();
  });
});

describe("ApiProvider", () => {
  function Caller({ path }: { path: string }) {
    const api = useApi();
    return (
      <button
        onClick={() => {
          api.get(path).then(
            () => document.body.setAttribute("data-api", "ok"),
            (error: ApiError) => document.body.setAttribute("data-api", `${error.status}`),
          );
        }}
      >
        call
      </button>
    );
  }

  function setup(oidc = createFakeOidc(oidcUser({ roles: ["trader"], organization: ["acme"] })), path = "/v1/me") {
    render(
      <MemoryRouter>
        <ConfigContext value={TEST_CONFIG}>
          <AuthProvider manager={oidc.client}>
            <ApiProvider>
              <Caller path={path} />
            </ApiProvider>
          </AuthProvider>
        </ConfigContext>
      </MemoryRouter>,
    );
    return oidc;
  }

  it("calls the gateway with the token of the session", async () => {
    const oidc = setup();
    let authorization: string | null = null;
    server.use(
      http.get("http://gateway.test/v1/me", ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json({ userId: "u1" });
      }),
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "call" }));
    await waitFor(() => expect(document.body.getAttribute("data-api")).toBe("ok"));
    expect(authorization).toBe(`Bearer ${oidc.user?.access_token}`);
  });

  it("ends the session when the gateway keeps refusing the token", async () => {
    const oidc = createFakeOidc(oidcUser({ roles: ["trader"], organization: ["acme"] }));
    oidc.signinSilent.mockResolvedValue(null);
    setup(oidc);
    server.use(http.get("http://gateway.test/v1/me", () => HttpResponse.json({ type: "t", title: "Unauthorized", status: 401 }, { status: 401 })));
    await userEvent.setup().click(await screen.findByRole("button", { name: "call" }));
    await waitFor(() => expect(document.body.getAttribute("data-api")).toBe("401"));
    await waitFor(() => expect(oidc.removeUser).toHaveBeenCalled());
  });

  it("is required", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Caller path="/x" />)).toThrow("useApi must be used");
    quiet.mockRestore();
  });

  it("can use another fetch, for tests of the pages", async () => {
    const fake = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const oidc = createFakeOidc(oidcUser());
    render(
      <MemoryRouter>
        <ConfigContext value={TEST_CONFIG}>
          <AuthProvider manager={oidc.client}>
            <ApiProvider fetchImpl={fake as unknown as typeof fetch}>
              <Caller path="/v1/me" />
            </ApiProvider>
          </AuthProvider>
        </ConfigContext>
      </MemoryRouter>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "call" }));
    await waitFor(() => expect(fake).toHaveBeenCalledTimes(1));
  });
});
