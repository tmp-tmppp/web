import { describe, expect, it } from "vitest";
import { decodeJwtPayload, rolesFromClaims, tenantFromClaims, TokenError, userFromTokens } from "../src/auth/token";
import { isRole } from "../src/auth/roles";
import { safeReturnTo } from "../src/auth/return-to";
import { makeJwt } from "./support/jwt";

describe("decodeJwtPayload", () => {
  it("reads the payload, also with non-ASCII text", () => {
    expect(decodeJwtPayload(makeJwt({ sub: "u1", name: "Žan Šuštar" }))).toEqual({ sub: "u1", name: "Žan Šuštar" });
  });

  it.each([
    ["a token with two parts", "a.b"],
    ["an empty payload", "a..c"],
    ["a payload that is not base64", "a.!!!.c"],
    ["a payload that is not JSON", `a.${Buffer.from("text").toString("base64url")}.c`],
    ["a payload that is a list", `a.${Buffer.from("[1]").toString("base64url")}.c`],
  ])("rejects %s", (_name, token) => {
    expect(() => decodeJwtPayload(token)).toThrow(TokenError);
  });
});

describe("rolesFromClaims (token contract v2)", () => {
  const organization = (groups: unknown) => ({ acme: { id: "acme", groups } });

  it("takes platform-admin from the realm roles and the tenant role from the group of the one organization", () => {
    expect(rolesFromClaims({ realm_access: { roles: ["platform-admin"] } })).toEqual(["platform-admin"]);
    expect(rolesFromClaims({ organization: organization(["/trader"]) })).toEqual(["trader"]);
    expect(rolesFromClaims({ organization: organization(["/tenant-admin"]) })).toEqual(["tenant-admin"]);
    expect(rolesFromClaims({ realm_access: { roles: ["platform-admin"] }, organization: organization(["/tenant-admin"]) })).toEqual(["tenant-admin", "platform-admin"]);
  });

  it("ignores a realm role trader or tenant-admin: the roles of an organization are not realm roles", () => {
    expect(rolesFromClaims({ realm_access: { roles: ["offline_access", "tenant-admin", "trader"] } })).toEqual([]);
    expect(rolesFromClaims({ realm_access: { roles: ["trader"] }, organization: organization([]) })).toEqual([]);
  });

  it.each([
    ["both groups", ["/trader", "/tenant-admin"]],
    ["a group that is not a role", ["/finance"]],
    ["a group name without the slash", ["trader"]],
    ["a list that is not a list", "/trader"],
    ["no groups", undefined],
  ])("gives no tenant role for %s", (_name, groups) => {
    expect(rolesFromClaims({ organization: organization(groups) })).toEqual([]);
  });

  it("gives no tenant role when the token names none or several organizations", () => {
    expect(rolesFromClaims({ organization: {} })).toEqual([]);
    expect(rolesFromClaims({ organization: ["acme"] })).toEqual([]);
    expect(rolesFromClaims({ organization: { a: { groups: ["/trader"] }, b: { groups: ["/trader"] } } })).toEqual([]);
    expect(rolesFromClaims({ organization: { acme: "/trader" } })).toEqual([]);
  });

  it.each([[{}], [{ realm_access: null }], [{ realm_access: {} }], [{ realm_access: { roles: "platform-admin" } }]])("returns no role for %j", (claims) => {
    expect(rolesFromClaims(claims)).toEqual([]);
  });
});

describe("tenantFromClaims", () => {
  it.each([
    ["a string", "acme", "acme"],
    ["an array", ["acme"], "acme"],
    ["an object keyed by alias", { acme: { id: "x" } }, "acme"],
  ])("reads the tenant from %s", (_name, organization, expected) => {
    expect(tenantFromClaims({ organization })).toBe(expected);
  });

  it.each([[undefined], [[]], [{}], [""], [5]])("returns null for %j", (organization) => {
    expect(tenantFromClaims({ organization })).toBeNull();
  });

  it("refuses a token with two organizations", () => {
    expect(() => tenantFromClaims({ organization: ["a", "b"] })).toThrow("more than one organization");
  });
});

describe("userFromTokens", () => {
  it("builds the user from both tokens", () => {
    const access = makeJwt({ sub: "u1", organization: { acme: { id: "acme", groups: ["/trader"] } } });
    expect(userFromTokens(access, { name: "Ana Novak", email: "ana@example.test", preferred_username: "ana" })).toEqual({
      id: "u1",
      username: "ana",
      name: "Ana Novak",
      email: "ana@example.test",
      roles: ["trader"],
      tenantId: "acme",
    });
  });

  it("falls back to the claims of the access token and then to the id", () => {
    expect(userFromTokens(makeJwt({ sub: "u1", name: "Ana", email: "a@example.test", preferred_username: "ana" }))).toMatchObject({
      username: "ana",
      name: "Ana",
      email: "a@example.test",
      tenantId: null,
      roles: [],
    });
    expect(userFromTokens(makeJwt({ sub: "u1" }))).toMatchObject({ username: "u1", name: "u1", email: null });
  });

  it("needs a subject", () => {
    expect(() => userFromTokens(makeJwt({}))).toThrow("no subject");
  });
});

describe("isRole and safeReturnTo", () => {
  it("knows the three roles", () => {
    expect(["trader", "tenant-admin", "platform-admin"].every(isRole)).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(3)).toBe(false);
  });

  it("accepts only a path of this app", () => {
    expect(safeReturnTo("/wallet?x=1")).toBe("/wallet?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "wallet", 5, undefined, "/auth/callback", "/auth/callback?code=1"]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});
