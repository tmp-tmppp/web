import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User } from "oidc-client-ts";
import { StrictMode, useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { createFakeOidc, oidcUser } from "./support/fake-oidc";
import type { FakeOidc } from "./support/fake-oidc";

function Probe() {
  const auth = useAuth();
  const location = useLocation();
  const [result, setResult] = useState("");
  return (
    <div>
      <p data-testid="status">{auth.status}</p>
      <p data-testid="path">{location.pathname}</p>
      <p data-testid="user">{auth.user ? `${auth.user.name}|${auth.user.roles.join(",")}|${auth.user.tenantId ?? "none"}` : "none"}</p>
      <p data-testid="error">{auth.error?.message ?? ""}</p>
      <p data-testid="notice">{auth.notice ?? ""}</p>
      <p data-testid="result">{result}</p>
      <button onClick={() => void auth.login("/wallet")}>login</button>
      <button onClick={() => void auth.login("https://evil.example")}>login-unsafe</button>
      <button onClick={() => void auth.login()}>login-default</button>
      <button onClick={() => void auth.logout()}>logout</button>
      <button onClick={() => void auth.getAccessToken().then((token) => setResult(String(token)))}>token</button>
      <button onClick={() => void auth.refreshSession().then((ok) => setResult(String(ok)))}>refresh</button>
      <button onClick={() => void auth.expireSession()}>expire</button>
    </div>
  );
}

function mount(oidc: FakeOidc, path = "/", strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider manager={oidc.client}>
        <Probe />
      </AuthProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const status = () => screen.getByTestId("status").textContent;

describe("start", () => {
  it("is signed out without a stored session", async () => {
    mount(createFakeOidc(null));
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  it("restores the session from storage and reads roles and tenant from the token", async () => {
    mount(createFakeOidc(oidcUser({ roles: ["trader"], organization: ["acme"] })));
    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(screen.getByTestId("user")).toHaveTextContent("Ana Novak|trader|acme");
  });

  it("starts as loading", () => {
    mount(createFakeOidc(null));
    expect(status()).toBe("loading");
  });

  it("renews an expired session before it shows the user", async () => {
    const oidc = createFakeOidc(oidcUser({ expired: true }));
    oidc.signinSilent.mockResolvedValue(oidcUser({ roles: ["tenant-admin"], organization: { acme: {} } }));
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(screen.getByTestId("user")).toHaveTextContent("tenant-admin|acme");
  });

  it("drops an expired session that cannot be renewed", async () => {
    const oidc = createFakeOidc(oidcUser({ expired: true }));
    oidc.signinSilent.mockRejectedValue(new Error("refresh token used"));
    mount(oidc);
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(oidc.removeUser).toHaveBeenCalled();
  });

  it("reports a token that names two organizations", async () => {
    mount(createFakeOidc(oidcUser({ organization: ["a", "b"] })));
    await waitFor(() => expect(status()).toBe("error"));
    expect(screen.getByTestId("error")).toHaveTextContent("more than one organization");
  });

  it("reports a failing storage read", async () => {
    const oidc = createFakeOidc(null);
    oidc.getUser.mockRejectedValue("storage is gone");
    mount(oidc);
    await waitFor(() => expect(status()).toBe("error"));
    expect(screen.getByTestId("error")).toHaveTextContent("storage is gone");
  });
});

describe("login callback", () => {
  it("completes the login and goes back to the page the user came from", async () => {
    const oidc = createFakeOidc(null);
    oidc.signinCallback.mockResolvedValue(oidcUser({ roles: ["trader"], organization: ["acme"], state: { returnTo: "/wallet" } }));
    mount(oidc, "/auth/callback?code=abc&state=xyz");
    await waitFor(() => expect(status()).toBe("authenticated"));
    // The navigation follows the status change in a later render, so the test waits for it (a slow run shows the gap).
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/wallet$/));
    expect(oidc.signinCallback).toHaveBeenCalledWith(`${window.location.origin}/auth/callback?code=abc&state=xyz`);
  });

  it("ignores a return address that leaves the app", async () => {
    const oidc = createFakeOidc(null);
    oidc.signinCallback.mockResolvedValue(oidcUser({ state: { returnTo: "//evil.example" } }));
    mount(oidc, "/auth/callback?code=abc&state=xyz");
    await waitFor(() => expect(status()).toBe("authenticated"));
    // Exactly "/": a plain "/" would also match the callback path the page starts on.
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/$/));
  });

  it("consumes the callback once, also in strict mode", async () => {
    const oidc = createFakeOidc(null);
    oidc.signinCallback.mockResolvedValue(oidcUser({ state: {} }));
    mount(oidc, "/auth/callback?code=abc&state=xyz", true);
    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(oidc.signinCallback).toHaveBeenCalledTimes(1);
  });

  it("reports a refused or invalid login", async () => {
    const oidc = createFakeOidc(null);
    oidc.signinCallback.mockRejectedValue(new Error("access_denied"));
    mount(oidc, "/auth/callback?error=access_denied");
    await waitFor(() => expect(status()).toBe("error"));
    expect(screen.getByTestId("error")).toHaveTextContent("access_denied");
  });

  it("is signed out when the callback brings no user", async () => {
    const oidc = createFakeOidc(null);
    oidc.signinCallback.mockResolvedValue(undefined);
    mount(oidc, "/auth/callback?code=a&state=b");
    await waitFor(() => expect(status()).toBe("unauthenticated"));
  });
});

describe("actions", () => {
  it("starts the login and remembers where to return to", async () => {
    const oidc = createFakeOidc(null);
    mount(oidc);
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    const user = userEvent.setup();
    await user.click(screen.getByText("login"));
    expect(oidc.signinRedirect).toHaveBeenLastCalledWith({ state: { returnTo: "/wallet" } });
    await user.click(screen.getByText("login-unsafe"));
    expect(oidc.signinRedirect).toHaveBeenLastCalledWith({ state: { returnTo: "/" } });
    await user.click(screen.getByText("login-default"));
    expect(oidc.signinRedirect).toHaveBeenLastCalledWith({ state: { returnTo: "/" } });
  });

  it("ends the session at the identity provider", async () => {
    const oidc = createFakeOidc(oidcUser());
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));
    await userEvent.setup().click(screen.getByText("logout"));
    expect(oidc.signoutRedirect).toHaveBeenCalledTimes(1);
  });

  it("ends the local session when the end-session request cannot start", async () => {
    const oidc = createFakeOidc(oidcUser());
    oidc.signoutRedirect.mockRejectedValue(new Error("offline"));
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));
    await userEvent.setup().click(screen.getByText("logout"));
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(oidc.removeUser).toHaveBeenCalled();
  });

  it("hands out the access token, renewing an expired one first", async () => {
    const oidc = createFakeOidc(oidcUser({ sub: "first" }));
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));
    const user = userEvent.setup();
    await user.click(screen.getByText("token"));
    expect(screen.getByTestId("result").textContent).toBe(oidc.user?.access_token);

    const fresh = oidcUser({ sub: "second" });
    oidc.user = oidcUser({ sub: "first", expired: true });
    oidc.signinSilent.mockResolvedValue(fresh);
    await user.click(screen.getByText("token"));
    expect(screen.getByTestId("result").textContent).toBe(fresh.access_token);

    oidc.signinSilent.mockRejectedValue(new Error("no"));
    await user.click(screen.getByText("token"));
    expect(screen.getByTestId("result")).toHaveTextContent("null");

    oidc.user = null;
    await user.click(screen.getByText("token"));
    expect(screen.getByTestId("result")).toHaveTextContent("null");
  });

  it("renews the session so new roles and a new tenant reach the app", async () => {
    const oidc = createFakeOidc(oidcUser());
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(screen.getByTestId("user")).toHaveTextContent("Ana Novak||none");

    oidc.signinSilent.mockResolvedValue(oidcUser({ roles: ["trader"], organization: ["acme"] }));
    await userEvent.setup().click(screen.getByText("refresh"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("Ana Novak|trader|acme"));
    expect(screen.getByTestId("result")).toHaveTextContent("true");
  });

  it("reports a renewal that gives no user or fails", async () => {
    const oidc = createFakeOidc(oidcUser());
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));
    const user = userEvent.setup();
    oidc.signinSilent.mockResolvedValue(null);
    await user.click(screen.getByText("refresh"));
    expect(screen.getByTestId("result")).toHaveTextContent("false");
    oidc.signinSilent.mockRejectedValue(new Error("expired"));
    await user.click(screen.getByText("refresh"));
    expect(screen.getByTestId("result")).toHaveTextContent("false");
    expect(status()).toBe("authenticated");
  });

  // The realm rotates refresh tokens and allows no reuse: a second renewal with the same refresh token is refused.
  describe("renewal", () => {
    function deferredRenewal(oidc: FakeOidc) {
      let settle: (user: User | null) => void = () => undefined;
      oidc.signinSilent.mockImplementation(
        () =>
          new Promise<User | null>((resolve) => {
            settle = resolve;
          }),
      );
      return { settle: (user: User | null) => settle(user) };
    }

    async function mountAuthenticated() {
      const oidc = createFakeOidc(oidcUser({ sub: "first" }));
      mount(oidc);
      await waitFor(() => expect(status()).toBe("authenticated"));
      oidc.user = oidcUser({ sub: "first", expired: true });
      return oidc;
    }

    it("runs one renewal for a token request, a session refresh and an expiring token that arrive together", async () => {
      const oidc = await mountAuthenticated();
      const renewal = deferredRenewal(oidc);
      const user = userEvent.setup();
      await user.click(screen.getByText("token"));
      await user.click(screen.getByText("refresh"));
      await user.click(screen.getByText("token"));
      act(() => oidc.emit.expiring());
      await waitFor(() => expect(oidc.signinSilent).toHaveBeenCalledTimes(1));
      const fresh = oidcUser({ sub: "second", roles: ["trader"], organization: ["acme"] });
      await act(async () => {
        renewal.settle(fresh);
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("Ana Novak|trader|acme"));
      expect(oidc.signinSilent).toHaveBeenCalledTimes(1);
    });

    it("hands the same renewed token to every caller that waited for it", async () => {
      const oidc = createFakeOidc(oidcUser({ sub: "first" }));
      const tokens: (string | null)[] = [];
      function Collector() {
        const auth = useAuth();
        return (
          <div>
            <p data-testid="status">{auth.status}</p>
            <button onClick={() => void Promise.all([auth.getAccessToken(), auth.getAccessToken()]).then((all) => tokens.push(...all))}>both</button>
          </div>
        );
      }
      render(
        <MemoryRouter>
          <AuthProvider manager={oidc.client}>
            <Collector />
          </AuthProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(status()).toBe("authenticated"));
      oidc.user = oidcUser({ sub: "first", expired: true });
      const renewal = deferredRenewal(oidc);
      await userEvent.setup().click(screen.getByText("both"));
      const fresh = oidcUser({ sub: "second" });
      await act(async () => {
        renewal.settle(fresh);
        await Promise.resolve();
      });
      await waitFor(() => expect(tokens).toHaveLength(2));
      expect(tokens).toEqual([fresh.access_token, fresh.access_token]);
      expect(oidc.signinSilent).toHaveBeenCalledTimes(1);
    });

    it("renews again once the first renewal has ended, also after a failed one", async () => {
      const oidc = await mountAuthenticated();
      const user = userEvent.setup();
      oidc.signinSilent.mockRejectedValueOnce(new Error("refused")).mockResolvedValue(oidcUser({ sub: "second" }));
      await user.click(screen.getByText("refresh"));
      expect(screen.getByTestId("result")).toHaveTextContent("false");
      await user.click(screen.getByText("refresh"));
      expect(screen.getByTestId("result")).toHaveTextContent("true");
      await user.click(screen.getByText("refresh"));
      expect(oidc.signinSilent).toHaveBeenCalledTimes(3);
    });

    it("renews on the expiring-token event, and a failed renewal leaves the session as it is", async () => {
      const oidc = await mountAuthenticated();
      oidc.signinSilent.mockRejectedValue(new Error("offline"));
      act(() => oidc.emit.expiring());
      await waitFor(() => expect(oidc.signinSilent).toHaveBeenCalledTimes(1));
      expect(status()).toBe("authenticated");
      expect(screen.getByTestId("notice")).toHaveTextContent("");
    });

    it("unsubscribes from the expiring-token event with the provider", async () => {
      const oidc = createFakeOidc(null);
      const view = mount(oidc);
      await waitFor(() => expect(status()).toBe("unauthenticated"));
      expect(oidc.listeners.expiring.size).toBe(1);
      view.unmount();
      expect(oidc.listeners.expiring.size).toBe(0);
    });
  });

  it("drops the session when the API refuses the token for good", async () => {
    const oidc = createFakeOidc(oidcUser());
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));
    await userEvent.setup().click(screen.getByText("expire"));
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(screen.getByTestId("notice")).toHaveTextContent("Your session has ended");
    expect(oidc.removeUser).toHaveBeenCalled();
  });
});

describe("events of the OIDC library", () => {
  it("follow renewed tokens, a removed user and an expired token", async () => {
    const oidc = createFakeOidc(oidcUser());
    mount(oidc);
    await waitFor(() => expect(status()).toBe("authenticated"));

    act(() => oidc.emit.loaded(oidcUser({ name: "Renewed", roles: ["tenant-admin"], organization: ["acme"] })));
    expect(screen.getByTestId("user")).toHaveTextContent("Renewed|tenant-admin|acme");

    act(() => oidc.emit.expired());
    expect(status()).toBe("unauthenticated");
    expect(screen.getByTestId("notice")).toHaveTextContent("Your session has ended");

    act(() => oidc.emit.loaded(oidcUser()));
    expect(status()).toBe("authenticated");
    act(() => oidc.emit.unloaded());
    expect(status()).toBe("unauthenticated");
    expect(screen.getByTestId("notice")).toHaveTextContent("");
  });

  it("are unsubscribed when the provider goes away", async () => {
    const oidc = createFakeOidc(null);
    const view = mount(oidc);
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(oidc.listeners.loaded.size).toBe(1);
    view.unmount();
    expect(oidc.listeners.loaded.size).toBe(0);
    expect(oidc.listeners.unloaded.size).toBe(0);
    expect(oidc.listeners.expired.size).toBe(0);
  });
});

describe("useAuth", () => {
  it("needs the provider", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <MemoryRouter>
          <Probe />
        </MemoryRouter>,
      ),
    ).toThrow("useAuth must be used inside");
    quiet.mockRestore();
  });
});
