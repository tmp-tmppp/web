import { describe, expect, it } from "vitest";
import { ApiError, apiErrorFromResponse } from "../src/api/errors";

// ApiError.outcomeUnknown decides whether a page may say "nothing was done": it is true for no answer at all, and for a
// 5xx other than 503 that is not one of the services' own refusals (no code, or "internal_error": the service failed and
// may have committed), and for a success status whose body could not be read (the app's own "cannot read" error carries the
// status of the answer). A 5xx with a code of ours (markets' 502 funding_rejected) is a definite answer.

const error = (status: number, code: string | null) => new ApiError({ status, type: "about:blank", title: "Title", code });

describe("ApiError.outcomeUnknown", () => {
  it.each([
    [0, null, true, "no answer at all"],
    [500, null, true, "a 500 without a code"],
    [500, "internal_error", true, "a 500 internal_error: the service failed and may have committed"],
    [502, "funding_rejected", false, "a 502 funding_rejected: trading refused, nothing was funded"],
    [502, null, true, "a bad gateway page"],
    [503, null, false, "a 503: not taken on"],
    [503, "trading_unavailable", false, "a 503 with a code of ours"],
    [504, null, true, "a gateway timeout without a code"],
    [504, "gateway_timeout", false, "a 504 that names a code of its own"],
    [500, "forbidden", false, "a 5xx with another code is the service's own answer"],
    [400, null, false, "a 4xx is a refusal"],
    [409, "insufficient_credits", false, "a 409 is a refusal"],
    [429, null, false, "a 429 was not taken on"],
    [200, null, true, "a 200 whose body could not be read: the request was taken on"],
    [201, null, true, "a 201 whose body could not be read: the order was most likely made"],
    [202, null, true, "a 202 whose body could not be read"],
    [299, null, true, "the top of the success range"],
    [300, null, false, "a 3xx is not a success status"],
  ] as const)("status %i, code %j gives %s (%s)", (status, code, expected, _why) => {
    expect(error(status, code).outcomeUnknown).toBe(expected);
  });

  it("reads the code from the problem body of a real answer and leaves a body that is not a problem without one", async () => {
    const refused = await apiErrorFromResponse(
      new Response(JSON.stringify({ type: "urn:chance:problem:funding-rejected", title: "Funding rejected", status: 502, code: "funding_rejected" }), {
        status: 502,
        headers: { "Content-Type": "application/problem+json" },
      }),
      "c-1",
    );
    expect(refused.outcomeUnknown).toBe(false);
    const page = await apiErrorFromResponse(new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }), "c-2");
    expect(page.code).toBeNull();
    expect(page.outcomeUnknown).toBe(true);
    const failed = await apiErrorFromResponse(
      new Response(JSON.stringify({ title: "Internal error", status: 500, code: "internal_error" }), { status: 500, headers: { "Content-Type": "application/problem+json" } }),
      "c-3",
    );
    expect(failed.outcomeUnknown).toBe(true);
  });
});
