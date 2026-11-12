import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { http, HttpResponse } from "msw";
import { parse } from "yaml";

/**
 * The OpenAPI files of the four services (contracts/*.openapi.yaml, copies of the files the services keep) are the
 * truth for every request the pages send and every answer the mock API gives. A handler made with contractHandler()
 * checks the request before the test's resolver sees it and the answer before it leaves; a violation is recorded and
 * fails the test in tests/setup.ts.
 */

export const API_BASE = "http://gateway.test";

export type SpecName = "tenants" | "payments" | "audit" | "markets" | "trading" | "market-data";

type Json = any;

interface Operation {
  id: string;
  spec: SpecName;
  method: "get" | "post" | "put" | "delete";
  template: string;
  pointer: string;
  def: Json;
}

const METHODS = ["get", "post", "put", "delete"] as const;
const BASE_ID = (name: SpecName) => `https://contracts.test/${name}.json`;

const HERE = dirname(fileURLToPath(import.meta.url));

/** The copies of the contracts kept in this repository, as file paths. */
export const CONTRACT_FILES: Record<SpecName, string> = {
  tenants: resolvePath(HERE, "../../contracts/tenants.openapi.yaml"),
  payments: resolvePath(HERE, "../../contracts/payments.openapi.yaml"),
  audit: resolvePath(HERE, "../../contracts/audit.openapi.yaml"),
  markets: resolvePath(HERE, "../../contracts/markets.openapi.yaml"),
  trading: resolvePath(HERE, "../../contracts/trading.openapi.yaml"),
  "market-data": resolvePath(HERE, "../../contracts/market-data.openapi.yaml"),
};

/** The copy of the GraphQL schema of market-data (the service's `contracts/graphql/schema.graphql`); tests/support/graphql.ts builds its mock endpoint from it. */
export const GRAPHQL_CONTRACT_FILE = resolvePath(HERE, "../../contracts/market-data.graphql");

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addFormat("int64", true);

const docs = new Map<SpecName, Json>();
const operations = new Map<string, Operation>();

for (const name of Object.keys(CONTRACT_FILES) as SpecName[]) {
  const doc: Json = parse(readFileSync(CONTRACT_FILES[name], "utf8"));
  docs.set(name, doc);
  ajv.addSchema({ ...doc, $id: BASE_ID(name) });
  for (const [template, item] of Object.entries<Json>(doc.paths)) {
    for (const method of METHODS) {
      const def = item[method];
      if (!def) continue;
      const entry: Operation = { id: def.operationId, spec: name, method, template, def, pointer: `#/paths/${escapePointer(template)}/${method}` };
      // markets and market-data both have listMarkets and getMarket: the plain id names the first file that has it
      // (markets), every operation can also be named "<file>:<operationId>", for example "market-data:listMarkets".
      operations.set(`${name}:${def.operationId}`, { ...entry, id: `${name}:${def.operationId}` });
      if (!operations.has(def.operationId)) operations.set(def.operationId, entry);
    }
  }
}

function escapePointer(part: string): string {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function operation(id: string): Operation {
  const found = operations.get(id);
  if (!found) throw new Error(`No operation ${id} in the contracts`);
  return found;
}

/** Follows a "$ref" to the components of the same file; returns the node and its pointer. */
function resolve(spec: SpecName, node: Json, pointer: string): { node: Json; pointer: string } {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    const target = node.$ref as string;
    let found: Json = docs.get(spec);
    for (const part of target.slice(2).split("/")) found = found[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    return { node: found, pointer: target };
  }
  return { node, pointer };
}

function validateAt(spec: SpecName, pointer: string, value: unknown, label: string): string[] {
  const validate = ajv.getSchema(`${BASE_ID(spec)}${pointer}`);
  if (!validate) throw new Error(`No schema at ${pointer} in ${spec}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${label}${error.instancePath || " (value)"} ${error.message ?? "is invalid"}${error.params && "additionalProperty" in error.params ? `: ${String(error.params["additionalProperty"])}` : ""}`);
}

function mediaOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export interface RequestFacts {
  /** Values of the path parameters as the router decoded them. */
  params: Record<string, string>;
  url: string;
  headers: Headers;
  bodyText: string;
}

function parameterOf(op: Operation, name: string, where: "query" | "header" | "path") {
  for (const [index, raw] of ((op.def.parameters ?? []) as Json[]).entries()) {
    const { node, pointer } = resolve(op.spec, raw, `${op.pointer}/parameters/${index}`);
    if (node.in === where && (where === "header" ? node.name.toLowerCase() === name.toLowerCase() : node.name === name)) return { node, pointer };
  }
  return null;
}

/** The problems of a request against the contract of its operation; an empty list means it is valid. */
export function checkRequest(opOrId: Operation | string, facts: RequestFacts): string[] {
  const op = typeof opOrId === "string" ? operation(opOrId) : opOrId;
  const label = `${op.id} request`;
  const problems: string[] = [];
  const parameters = ((op.def.parameters ?? []) as Json[]).map((raw, index) => resolve(op.spec, raw, `${op.pointer}/parameters/${index}`));

  for (const { node, pointer } of parameters) {
    if (node.in === "path") {
      const value = facts.params[node.name];
      if (value === undefined) problems.push(`${label}: path parameter ${node.name} is missing`);
      else problems.push(...validateAt(op.spec, `${pointer}/schema`, value, `${label} path ${node.name}`));
    }
    if (node.in === "header") {
      const value = facts.headers.get(node.name);
      if (value === null) {
        if (node.required) problems.push(`${label}: header ${node.name} is missing`);
      } else problems.push(...validateAt(op.spec, `${pointer}/schema`, value, `${label} header ${node.name}`));
    }
  }

  const search = new URL(facts.url).searchParams;
  for (const name of new Set(search.keys())) {
    const declared = parameterOf(op, name, "query");
    if (!declared) {
      problems.push(`${label}: query parameter ${name} is not in the contract`);
      continue;
    }
    const raw = search.getAll(name);
    const schema = resolve(op.spec, declared.node.schema, `${declared.pointer}/schema`).node;
    let value: unknown;
    if (schema.type === "array") value = raw.flatMap((part) => part.split(","));
    else if (raw.length > 1) {
      problems.push(`${label}: query parameter ${name} is repeated`);
      continue;
    } else value = schema.type === "integer" && /^-?\d+$/.test(raw[0] ?? "") ? Number(raw[0]) : raw[0];
    problems.push(...validateAt(op.spec, `${declared.pointer}/schema`, value, `${label} query ${name}`));
  }
  for (const { node } of parameters) {
    if (node.in === "query" && node.required && !search.has(node.name)) problems.push(`${label}: query parameter ${node.name} is missing`);
  }

  const secured = (op.def.security ?? docs.get(op.spec).security ?? []) as Json[];
  const authorization = facts.headers.get("Authorization");
  // "security: [{}, {bearerAuth: []}]" makes the bearer token optional (the public lookup of a share link); one that is sent must still be well formed.
  const optional = secured.some((entry) => Object.keys(entry as object).length === 0);
  if (secured.length > 0 && !optional && !/^Bearer \S+$/.test(authorization ?? "")) problems.push(`${label}: the bearer token is missing`);
  if (optional && authorization !== null && !/^Bearer \S+$/.test(authorization)) problems.push(`${label}: the Authorization header is not a bearer token`);
  if (!facts.headers.get("X-Correlation-Id")) problems.push(`${label}: X-Correlation-Id is missing`);

  const body: Json = op.def.requestBody;
  if (!body) {
    if (facts.bodyText !== "") problems.push(`${label}: the contract has no request body`);
  } else if (facts.bodyText === "") {
    if (body.required) problems.push(`${label}: the request body is missing`);
  } else {
    const type = mediaOf(facts.headers.get("Content-Type"));
    if (!(type in body.content)) problems.push(`${label}: content type ${type || "(none)"} is not in the contract`);
    else {
      try {
        problems.push(...validateAt(op.spec, `${op.pointer}/requestBody/content/${escapePointer(type)}/schema`, JSON.parse(facts.bodyText), `${label} body`));
      } catch {
        problems.push(`${label}: the body is not JSON`);
      }
    }
  }
  return problems;
}

export interface ResponseFacts {
  status: number;
  headers: Headers;
  bodyText: string;
}

/** The problems of an answer against the contract of its operation; an empty list means it is valid. */
export function checkResponse(opOrId: Operation | string, facts: ResponseFacts): string[] {
  const op = typeof opOrId === "string" ? operation(opOrId) : opOrId;
  const label = `${op.id} response ${facts.status}`;
  const responses = op.def.responses as Record<string, Json>;
  const declared = responses[String(facts.status)];
  if (!declared) return [`${label}: the status is not in the contract`];
  const { node, pointer } = resolve(op.spec, declared, `${op.pointer}/responses/${facts.status}`);
  const problems: string[] = [];

  const content = node.content as Record<string, Json> | undefined;
  if (!content) {
    if (facts.bodyText !== "") problems.push(`${label}: the contract has no body here`);
  } else {
    const type = mediaOf(facts.headers.get("Content-Type"));
    if (!(type in content)) problems.push(`${label}: content type ${type || "(none)"} is not in the contract`);
    else if (facts.bodyText === "") problems.push(`${label}: the body is missing`);
    else {
      try {
        problems.push(...validateAt(op.spec, `${pointer}/content/${escapePointer(type)}/schema`, JSON.parse(facts.bodyText), `${label} body`));
      } catch {
        problems.push(`${label}: the body is not JSON`);
      }
    }
  }

  // A 503 always carries Retry-After, a 401 the Bearer challenge, a created or accepted resource its status link.
  const names = Object.keys((node.headers ?? {}) as Record<string, unknown>);
  if (names.includes("Retry-After") && !/^\d+$/.test(facts.headers.get("Retry-After") ?? "")) problems.push(`${label}: Retry-After (whole seconds) is missing`);
  if (names.includes("WWW-Authenticate") && !facts.headers.get("WWW-Authenticate")) problems.push(`${label}: WWW-Authenticate is missing`);
  if (names.includes("Location") && (facts.status === 201 || facts.status === 202) && !facts.headers.get("Location")) problems.push(`${label}: Location is missing`);
  return problems;
}

const violations: string[] = [];

/** A violation found by a mock that is not made with contractHandler (the GraphQL endpoint): recorded like the others, so the test fails on it. */
export function recordViolation(...problems: string[]): void {
  violations.push(...problems);
}

/** The contract violations recorded since the last call; tests/setup.ts fails the test when there are any. */
export function takeViolations(): string[] {
  return violations.splice(0, violations.length);
}

export interface Call {
  params: Record<string, string>;
  /** The query of the request. */
  query: URLSearchParams;
  /** The parsed JSON body, or undefined. */
  body: any;
  request: Request;
}

export interface ReplyInit {
  headers?: Record<string, string>;
}

/** An answer of the mock API: JSON for a success, application/problem+json for an error. */
export function reply(status: number, body?: unknown, init: ReplyInit = {}): Response {
  const type = status >= 400 ? "application/problem+json" : "application/json";
  const headers = { "Content-Type": type, ...init.headers };
  return body === undefined ? new HttpResponse(null, { status, headers: init.headers ?? {} }) : new HttpResponse(JSON.stringify(body), { status, headers });
}

/** A problem body as the services send it (RFC 9457). */
export function problem(
  status: number,
  title: string,
  // Other members are the extensions of a problem (trading: maxAmount, quote, heldMicro; market-data: lastTradeSequence).
  extra: { code?: string; detail?: string; errors?: { field: string; message: string }[]; withdrawalId?: string; organization?: { name: string | null }; next?: string[]; [member: string]: unknown } = {},
) {
  return { type: `urn:chance:problem:${extra.code ?? "problem"}`.replace(/_/g, "-"), title, status, ...extra };
}

/** 503 with Retry-After, as every service answers while a dependency is away. */
export function unavailable(code: string, seconds = 7): Response {
  return reply(503, problem(503, "Service unavailable", { code, detail: "A dependency does not answer." }), { headers: { "Retry-After": String(seconds) } });
}

/** 401 with the Bearer challenge. */
export function unauthorized(): Response {
  return reply(401, problem(401, "Unauthorized", { code: "unauthorized", detail: "The token is not valid." }), { headers: { "WWW-Authenticate": "Bearer" } });
}

/**
 * A mock handler of one operation of the contracts. The resolver returns reply(...). The request is checked against the
 * contract first and the answer after; both kinds of violation are recorded for the test to fail on.
 */
export function contractHandler(id: string, resolver: (call: Call) => Response | Promise<Response>) {
  const op = operation(id);
  const path = op.template.replace(/\{(\w+)\}/g, ":$1");
  return http[op.method](`${API_BASE}${path}`, async ({ request, params }) => {
    const bodyText = await request.clone().text();
    const decoded = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, decodeURIComponent(String(value))]));
    violations.push(...checkRequest(op, { params: decoded, url: request.url, headers: request.headers, bodyText }));
    const response = await resolver({ params: decoded, query: new URL(request.url).searchParams, body: bodyText === "" ? undefined : JSON.parse(bodyText), request });
    violations.push(...checkResponse(op, { status: response.status, headers: response.headers, bodyText: await response.clone().text() }));
    return response;
  });
}
