import { setupServer } from "msw/node";
import { contractHandler, reply } from "./contract";

/**
 * The mock API of all tests. Each test adds its handlers with server.use(...); they are removed after the test.
 *
 * The layout of the signed-in app reads GET /v1/me/organizations on every page, so the default answer is a user without
 * any organization yet; a test about organizations answers it with its own handler.
 */
export const server = setupServer(contractHandler("listMyOrganizations", () => reply(200, { items: [], nextCursor: null, identityPending: false })));
