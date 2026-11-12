import { readFileSync } from "node:fs";
import { GraphQLError, Kind, buildSchema, getNamedType, graphql, isObjectType, parse } from "graphql";
import type { DocumentNode, FieldNode, GraphQLScalarType, GraphQLSchema, OperationDefinitionNode, SelectionSetNode, ValueNode } from "graphql";
import { http, HttpResponse } from "msw";
import type { DataMarket, History } from "../../src/api/market-data";
import { API_BASE, GRAPHQL_CONTRACT_FILE, recordViolation } from "./contract";
import { dataMarket, history as restHistory } from "./fixtures";

/**
 * A mock of the GraphQL endpoint of market-data (POST /v1/market-data/graphql), built the way the service is: from the
 * schema file in contracts/market-data.graphql. A request is parsed, checked against the limits of the service (body size,
 * query length, depth, complexity), validated against the schema, and executed by graphql-js with the test's resolvers, so
 * a variable of the wrong type or a field the schema does not have is refused as the service refuses it, and the answer
 * holds exactly the selected fields. What the page sends that the real endpoint would refuse is recorded as a violation
 * and fails the test (tests/setup.ts), as for the OpenAPI mocks.
 */

export const GRAPHQL_URL = `${API_BASE}/v1/market-data/graphql`;

export const marketDataSchema: GraphQLSchema = buildSchema(readFileSync(GRAPHQL_CONTRACT_FILE, "utf8"));

// The service's scalar refuses what is no RFC 3339 instant; the default scalar of buildSchema takes anything.
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
(marketDataSchema.getType("DateTime") as GraphQLScalarType).parseValue = (value: unknown) => {
  if (typeof value !== "string" || !RFC_3339.test(value) || Number.isNaN(Date.parse(value))) throw new TypeError("DateTime must be an RFC 3339 date-time");
  return value;
};

// --- the limits of the service (GRAPHQL_MAX_DEPTH, GRAPHQL_MAX_COMPLEXITY, README "GraphQL") --------------------------------

export const MAX_DEPTH = 5;
export const MAX_COMPLEXITY = 5000;
const MAX_QUERY_LENGTH = 10_000;
const MAX_BODY_BYTES = 16 * 1024;
const ROOT_FIELD_COST = 20;
const LIST_FIELDS = new Set(["MarketPage.items", "PriceHistory.buckets"]);

type Variables = Record<string, unknown>;

function valueOf(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case Kind.INT:
      return Number(node.value);
    case Kind.VARIABLE:
      return Object.hasOwn(variables, node.name.value) ? variables[node.name.value] : undefined;
    case Kind.LIST:
      return node.values.map((item) => valueOf(item, variables));
    default:
      return undefined;
  }
}

const clamp = (value: unknown, fallback: number, max: number): number => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback);

function pageSizeOf(key: string, field: FieldNode, variables: Variables): number | undefined {
  const argument = (name: string) => {
    const found = field.arguments?.find((candidate) => candidate.name.value === name);
    return found ? valueOf(found.value, variables) : undefined;
  };
  if (key === "Query.markets") {
    const ids = argument("ids");
    return Array.isArray(ids) ? clamp(ids.length, 1, 100) : clamp(argument("first"), 20, 100);
  }
  if (key === "Query.history") return clamp(argument("first"), 100, 500);
  return undefined;
}

function operationOf(document: DocumentNode): OperationDefinitionNode {
  const operation = document.definitions.find((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  if (!operation) throw new Error("The document has no operation");
  return operation;
}

/**
 * The complexity the service counts for a document (src/web/graphql/limits.ts): every selected field costs 1, a root field
 * 20 more, and the fields of `MarketPage.items` and `PriceHistory.buckets` cost once per row the page asks for (`first`, or
 * the number of `ids`); a variable counts with its value, or with its declared default. Documents without fragments only.
 */
export function queryCost(document: DocumentNode, sent: Variables = {}): number {
  const operation = operationOf(document);
  const variables: Variables = { ...sent };
  for (const definition of operation.variableDefinitions ?? []) {
    if (definition.defaultValue !== undefined && !Object.hasOwn(sent, definition.variable.name.value)) variables[definition.variable.name.value] = valueOf(definition.defaultValue, {});
  }
  const ofSet = (set: SelectionSetNode | undefined, parentType: string | null, pageSize: number): number => {
    let cost = 0;
    for (const selection of set?.selections ?? []) {
      if (selection.kind !== Kind.FIELD) throw new Error("This estimator does not read fragments");
      const name = selection.name.value;
      const key = `${parentType ?? ""}.${name}`;
      const type = parentType === null ? undefined : marketDataSchema.getType(parentType);
      const definition = isObjectType(type) ? type.getFields()[name] : undefined;
      const childType = definition ? getNamedType(definition.type).name : null;
      const own = 1 + (parentType === "Query" ? ROOT_FIELD_COST : 0);
      cost += (own + ofSet(selection.selectionSet, childType, pageSizeOf(key, selection, variables) ?? pageSize)) * (LIST_FIELDS.has(key) ? pageSize : 1);
    }
    return cost;
  };
  return ofSet(operation.selectionSet, "Query", 1);
}

/** The levels of nested fields: `{ markets { items { marketId } } }` is 3. */
export function queryDepth(document: DocumentNode): number {
  const ofSet = (set: SelectionSetNode | undefined): number => Math.max(0, ...(set?.selections ?? []).map((selection) => (selection.kind === Kind.FIELD ? 1 + ofSet(selection.selectionSet) : 0)));
  return ofSet(operationOf(document).selectionSet);
}

// --- the endpoint -------------------------------------------------------------------------------------------------------

type Resolver = (args: Record<string, unknown>) => unknown;

export interface Resolvers {
  markets?: Resolver;
  market?: Resolver;
  history?: Resolver;
}

export interface GraphqlCall {
  query: string;
  variables: Variables;
  /** The complexity the service would count. */
  cost: number;
}

/** An error of a resolver as the service tells it: the code of the REST problem, the status REST gives for it, and the extensions it carries. */
export function fieldError(code: string, status: number, message: string, extensions: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code, status } });
}

const refused = (code: string, message: string, status = 400): Response =>
  HttpResponse.json({ errors: [{ message, extensions: { code, status } }] }, { status, headers: { "Cache-Control": "private, no-store" } });

/**
 * The mock endpoint: `handler` goes to `server.use(...)`, `calls` lists what the page sent, in order. The resolvers answer
 * a query field with the object of the schema (every field of it; the answer keeps the selected ones) or throw a fieldError.
 */
export function graphqlEndpoint(resolvers: Resolvers) {
  const calls: GraphqlCall[] = [];
  const handler = http.post(GRAPHQL_URL, async ({ request }) => {
    const label = "market-data GraphQL request";
    const bodyText = await request.clone().text();
    if (!/^Bearer \S+$/.test(request.headers.get("Authorization") ?? "")) recordViolation(`${label}: the bearer token is missing`);
    if (!request.headers.get("X-Correlation-Id")) recordViolation(`${label}: X-Correlation-Id is missing`);
    if ((request.headers.get("Content-Type") ?? "").split(";")[0]?.trim() !== "application/json") recordViolation(`${label}: the body is not application/json`);
    if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) recordViolation(`${label}: the body is over 16 KiB`);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      recordViolation(`${label}: the body is not JSON`);
      return refused("bad_request", "The body is not JSON");
    }
    const parts = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (parts === null || typeof parts["query"] !== "string" || parts["query"] === "" || Object.keys(parts).some((name) => !["query", "variables", "operationName", "extensions"].includes(name))) {
      recordViolation(`${label}: the body must be one object { query, variables? }`);
      return refused("bad_request", "The body is not a GraphQL request");
    }
    const query = parts["query"];
    const variables = (parts["variables"] ?? {}) as Variables;
    if (query.length > MAX_QUERY_LENGTH) {
      recordViolation(`${label}: the query is over ${MAX_QUERY_LENGTH} characters`);
      return refused("bad_request", "The query is too long");
    }
    let document: DocumentNode;
    try {
      document = parse(query);
    } catch (error) {
      recordViolation(`${label}: the query does not parse: ${String(error)}`);
      return refused("graphql_syntax_error", "The query does not parse");
    }
    const cost = queryCost(document, variables);
    calls.push({ query, variables, cost });
    if (queryDepth(document) > MAX_DEPTH) {
      recordViolation(`${label}: deeper than ${MAX_DEPTH} levels`);
      return refused("depth_limit_exceeded", "The query is too deep");
    }
    if (cost > MAX_COMPLEXITY) {
      recordViolation(`${label}: complexity ${cost} is over the limit ${MAX_COMPLEXITY}`);
      return refused("complexity_limit_exceeded", "The query is too expensive");
    }
    const result = await graphql({ schema: marketDataSchema, source: query, variableValues: variables, rootValue: resolvers });
    // A query that cannot run (it does not fit the schema, a variable has the wrong type): 400 without data. Errors of a field: 200.
    if (result.data == null && !(result.errors ?? []).some((error) => error.path !== undefined)) {
      recordViolation(`${label}: ${(result.errors ?? []).map((error) => error.message).join("; ")}`);
      return refused("graphql_validation_failed", "The query does not fit the schema");
    }
    return HttpResponse.json(result, { headers: { "Cache-Control": "private, no-store", "X-Correlation-Id": request.headers.get("X-Correlation-Id") ?? "none" } });
  });
  return { handler, calls };
}

// --- fixtures -----------------------------------------------------------------------------------------------------------

/** A market of the schema: the `dataMarket` fixture of the REST tests with the enum written as GraphQL has it (OPEN, CLOSED, RESOLVED). */
export const gqlMarket = (overrides: Partial<DataMarket> = {}) => {
  const market = dataMarket(overrides);
  return { ...market, status: market.status.toUpperCase() };
};

/** The page of markets a `markets` resolver returns. */
export const gqlPage = (items: ReturnType<typeof gqlMarket>[], endCursor: string | null = null) => ({ items, pageInfo: { hasNextPage: endCursor !== null, endCursor } });

/** The history of the schema: the `history` fixture of the REST tests, with the interval as the enum names it. */
export const gqlHistory = (overrides: Partial<History> = {}) => ({ ...restHistory(overrides), interval: "ONE_HOUR", pageInfo: { hasNextPage: false, endCursor: null } });
