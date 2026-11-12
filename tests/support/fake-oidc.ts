import type { User } from "oidc-client-ts";
import { vi } from "vitest";
import type { OidcClient } from "../../src/auth/oidc";
import { makeJwt } from "./jwt";

export interface OidcUserOptions {
  sub?: string;
  name?: string;
  /** App roles. platform-admin goes to realm_access.roles; trader and tenant-admin become the group of every organization. */
  roles?: string[];
  /** One alias, an array of aliases or an object keyed by alias: the token gets the claim { alias: { id, groups } } (contract v2). */
  organization?: unknown;
  /** The groups of every organization in the token; by default "/trader" and "/tenant-admin" as the roles say. */
  groups?: string[];
  /** A raw realm role list added as is, for the tests that prove a realm role trader or tenant-admin counts for nothing. */
  realmRoles?: string[];
  email?: string | null;
  expired?: boolean;
  state?: unknown;
}

const TENANT_ROLES = ["trader", "tenant-admin"];

/** The organization claim of token contract v2: an object keyed by alias with the groups of the user in that organization. */
function organizationClaim(organization: unknown, groups: string[]): unknown {
  const entry = (alias: string, own?: unknown) => {
    const base = typeof own === "object" && own !== null && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
    return { id: alias, ...base, groups: "groups" in base ? base["groups"] : groups };
  };
  if (typeof organization === "string") return { [organization]: entry(organization) };
  if (Array.isArray(organization)) return Object.fromEntries(organization.map((alias) => [String(alias), entry(String(alias))]));
  if (typeof organization === "object" && organization !== null) {
    return Object.fromEntries(Object.entries(organization).map(([alias, own]) => [alias, entry(alias, own)]));
  }
  return organization;
}

/** The user object the OIDC library would hand over after a login. */
export function oidcUser(options: OidcUserOptions = {}): User {
  const sub = options.sub ?? "user-1";
  const roles = options.roles ?? [];
  const groups = options.groups ?? roles.filter((role) => TENANT_ROLES.includes(role)).map((role) => `/${role}`);
  const access = makeJwt({
    sub,
    preferred_username: "ana",
    realm_access: {
      roles: ["default-roles-chance", "offline_access", ...roles.filter((role) => !TENANT_ROLES.includes(role)), ...(options.realmRoles ?? [])],
    },
    ...(options.organization !== undefined ? { organization: organizationClaim(options.organization, groups) } : {}),
  });
  return {
    access_token: access,
    token_type: "Bearer",
    profile: { sub, name: options.name ?? "Ana Novak", email: options.email === null ? undefined : (options.email ?? "ana@example.test"), preferred_username: "ana" },
    expired: options.expired ?? false,
    state: options.state,
  } as unknown as User;
}

type Listener = (argument?: unknown) => void;

/** A stand-in for UserManager: the calls are spies, and emit.* fires the library's events. */
export function createFakeOidc(initial: User | null = null) {
  const loaded = new Set<Listener>();
  const unloaded = new Set<Listener>();
  const expired = new Set<Listener>();
  const expiring = new Set<Listener>();

  const fake = {
    user: initial,
    getUser: vi.fn((): Promise<User | null> => Promise.resolve(fake.user)),
    signinRedirect: vi.fn((_args?: unknown): Promise<void> => Promise.resolve()),
    signinCallback: vi.fn((_url?: string): Promise<User | undefined> => Promise.resolve(fake.user ?? undefined)),
    signinSilent: vi.fn((): Promise<User | null> => Promise.resolve(fake.user)),
    signoutRedirect: vi.fn((): Promise<void> => Promise.resolve()),
    removeUser: vi.fn((): Promise<void> => {
      fake.user = null;
      return Promise.resolve();
    }),
    events: {
      addUserLoaded: (callback: Listener) => void loaded.add(callback),
      removeUserLoaded: (callback: Listener) => void loaded.delete(callback),
      addUserUnloaded: (callback: Listener) => void unloaded.add(callback),
      removeUserUnloaded: (callback: Listener) => void unloaded.delete(callback),
      addAccessTokenExpired: (callback: Listener) => void expired.add(callback),
      removeAccessTokenExpired: (callback: Listener) => void expired.delete(callback),
      addAccessTokenExpiring: (callback: Listener) => void expiring.add(callback),
      removeAccessTokenExpiring: (callback: Listener) => void expiring.delete(callback),
    },
    listeners: { loaded, unloaded, expired, expiring },
    emit: {
      loaded: (user: User) => loaded.forEach((callback) => callback(user)),
      unloaded: () => unloaded.forEach((callback) => callback()),
      expired: () => expired.forEach((callback) => callback()),
      expiring: () => expiring.forEach((callback) => callback()),
    },
  };
  // The same object, so a test that reads "user" after removeUser() sees the change.
  return Object.assign(fake, { client: fake as unknown as OidcClient });
}

export type FakeOidc = ReturnType<typeof createFakeOidc>;
