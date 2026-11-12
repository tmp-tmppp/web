import { waitFor } from "@testing-library/react";
import { OidcClient as LibraryClient, User } from "oidc-client-ts";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { CALLBACK_PATH, createUserManager } from "../src/auth/oidc";
import { TEST_CONFIG } from "./support/render";
import { server } from "./support/server";

describe("createUserManager", () => {
  const manager = createUserManager(TEST_CONFIG, "http://app.test");

  it("is configured for the code flow, with the callback and the start page as return addresses", () => {
    expect(manager.settings).toMatchObject({
      authority: "http://idp.test/realms/chance",
      client_id: "web",
      redirect_uri: `http://app.test${CALLBACK_PATH}`,
      post_logout_redirect_uri: "http://app.test/",
      response_type: "code",
      // AuthProvider renews on the expiring-token event through one shared renewal (refresh tokens are rotated).
      automaticSilentRenew: false,
      loadUserInfo: false,
    });
    // The plain organization scope: Keycloak lets a member of several organizations pick one (token contract v2).
    expect(manager.settings.scope).toBe("openid profile email chance-organization");
  });

  it("keeps the tokens and the login state in sessionStorage, never in localStorage", async () => {
    await manager.settings.userStore.set("user-key", "tokens");
    await manager.settings.stateStore.set("state-key", "verifier");
    // The library prefixes its keys with "oidc.".
    expect(window.sessionStorage.getItem("oidc.user-key")).toBe("tokens");
    expect(window.sessionStorage.getItem("oidc.state-key")).toBe("verifier");
    expect(window.localStorage).toHaveLength(0);
  });

  it("still raises the expiring-token event with the library's renewal timer off, which AuthProvider renews on", async () => {
    const own = createUserManager(TEST_CONFIG, "http://app.test");
    const expiring = vi.fn();
    own.events.addAccessTokenExpiring(expiring);
    // 30 seconds left is inside the one-minute notice window: the library raises the event after about a second.
    const user = new User({ access_token: "token", token_type: "Bearer", profile: { sub: "user-1" } as User["profile"], expires_at: Math.floor(Date.now() / 1000) + 30 });
    await own.storeUser(user);
    await own.getUser();
    await waitFor(() => expect(expiring).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await own.removeUser();
  });

  it("defaults to the origin of the page", () => {
    expect(createUserManager(TEST_CONFIG).settings.redirect_uri).toBe(`${window.location.origin}${CALLBACK_PATH}`);
  });

  it("asks the identity provider for the code with a PKCE challenge (S256)", async () => {
    server.use(
      http.get("http://idp.test/realms/chance/.well-known/openid-configuration", () =>
        HttpResponse.json({
          issuer: "http://idp.test/realms/chance",
          authorization_endpoint: "http://idp.test/realms/chance/protocol/openid-connect/auth",
          token_endpoint: "http://idp.test/realms/chance/protocol/openid-connect/token",
          end_session_endpoint: "http://idp.test/realms/chance/protocol/openid-connect/logout",
        }),
      ),
    );
    const request = await new LibraryClient(manager.settings).createSigninRequest({ state: { returnTo: "/wallet" } });
    const url = new URL(request.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("web");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe(`http://app.test${CALLBACK_PATH}`);
    expect(url.searchParams.get("scope")).toBe("openid profile email chance-organization");
  });
});
