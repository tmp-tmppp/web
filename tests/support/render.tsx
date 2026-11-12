import { render } from "@testing-library/react";
import type { User } from "oidc-client-ts";
import { MemoryRouter } from "react-router";
import { App } from "../../src/App";
import type { AppConfig } from "../../src/config/types";
import { createFakeOidc } from "./fake-oidc";
import type { FakeOidc } from "./fake-oidc";

export const TEST_CONFIG: AppConfig = {
  issuer: "http://idp.test/realms/chance",
  clientId: "web",
  apiBase: "http://gateway.test",
  depositSuccessPath: "/deposits/success",
  depositCancelPath: "/deposits/cancelled",
};

interface RenderAppOptions {
  user?: User | null;
  path?: string;
  config?: AppConfig;
  oidc?: FakeOidc;
}

/** Renders the whole app at an address with a fake identity provider; returns the fake so a test can inspect its calls. */
export function renderApp({ user = null, path = "/", config = TEST_CONFIG, oidc = createFakeOidc(user) }: RenderAppOptions = {}): FakeOidc {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App config={config} manager={oidc.client} />
    </MemoryRouter>,
  );
  return oidc;
}
