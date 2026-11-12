import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { API_BASE, problem } from "./support/contract";
import { traderOidc, withdrawal } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

// A withdrawal whose answer was lost may have been taken. Trying another amount in between (and being refused) must not make
// the first request forgotten: going back to the first amount sends the same Idempotency-Key, so the service answers with
// the first withdrawal instead of making a second one.

const LABEL = "Amount to withdraw, in credits";

describe("a withdrawal whose answer was lost, then another amount, then the first amount again", () => {
  it("sends the key of the first amount again, and a key of its own for the other amount", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${API_BASE}/v1/withdrawals`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        if (keys.length === 1) return HttpResponse.error();
        if (keys.length === 2) return HttpResponse.json(problem(409, "Not enough credits", { code: "insufficient_credits" }), { status: 409, headers: { "Content-Type": "application/problem+json" } });
        return HttpResponse.json(withdrawal({ status: "paid_out", completedAt: "2026-11-11T10:05:00Z" }), { status: 200 });
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    const user = userEvent.setup({ delay: null });
    const field = await screen.findByLabelText(LABEL);
    const submit = async (amount: string) => {
      await user.clear(field);
      await user.type(field, amount);
      await user.click(screen.getByRole("button", { name: "Withdraw" }));
    };
    await submit("100");
    expect(await screen.findByRole("alert")).toHaveTextContent("We do not know yet whether the withdrawal was made");
    await submit("200");
    expect(await screen.findByText(/You do not have enough credits for this withdrawal/)).toBeInTheDocument();
    await submit("100");
    expect(await screen.findByText(/Paid out: 500 credits/)).toBeInTheDocument();
    expect(keys).toHaveLength(3);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });
});
