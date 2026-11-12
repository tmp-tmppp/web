function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned JWT with the given claims: the browser only reads the payload, the services check the signature. */
export function makeJwt(claims: Record<string, unknown>): string {
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.signature`;
}
