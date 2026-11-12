import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recallDeposit } from "../src/api/payments";
import { goToExternal } from "../src/lib/navigation";
import { DEPOSIT_POLL_MAX, DEPOSIT_POLL_MS } from "../src/pages/wallet/DepositReturnPage";
import { WITHDRAWAL_POLL_MAX, WITHDRAWAL_POLL_MS } from "../src/pages/wallet/WithdrawalProgress";
import { useFakeClock } from "./support/clock";
import { API_BASE, contractHandler, problem, reply, unauthorized, unavailable } from "./support/contract";
import { deposit, platformAdminOidc, traderOidc, withdrawal } from "./support/fixtures";
import { renderApp } from "./support/render";
import { server } from "./support/server";

// The browser cannot leave the test page: the jump to the payment page is a spy.
vi.mock("../src/lib/navigation", async (importOriginal) => {
  const original: Record<string, unknown> = await importOriginal();
  return { ...original, goToExternal: vi.fn() };
});

beforeEach(() => vi.mocked(goToExternal).mockClear());

const typing = () => userEvent.setup({ delay: null });
const LOCATION = (id: string, kind: "deposits" | "withdrawals") => ({ Location: `/v1/${kind}/${id}` });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function fillAndSubmit(label: string, amount: string, button: string) {
  const user = typing();
  const field = await screen.findByLabelText(label);
  if (amount !== "") await user.type(field, amount);
  await user.click(screen.getByRole("button", { name: button }));
}

describe("deposit", () => {
  const DEPOSIT = ["Amount to deposit, in credits", "Continue to the payment page"] as const;

  it("shows the amount in credits and euros while typing", async () => {
    renderApp({ user: traderOidc(), path: "/wallet" });
    await typing().type(await screen.findByLabelText(DEPOSIT[0]), "1250");
    expect(screen.getByLabelText(DEPOSIT[0])).toHaveAccessibleDescription(/1,250 credits \(EUR 12\.50\)\. 1 credit = 1 EUR cent\./);
  });

  it("starts the deposit with one Idempotency-Key, remembers its id and sends the browser to the payment page", async () => {
    const seen: { key: string | null; body: unknown }[] = [];
    server.use(
      contractHandler("createDeposit", ({ request, body }) => {
        seen.push({ key: request.headers.get("Idempotency-Key"), body });
        return reply(201, deposit(), { headers: LOCATION(deposit().id, "deposits") });
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    await waitFor(() => expect(goToExternal).toHaveBeenCalledWith("https://pay.example.test/checkout/cs_123"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toEqual({ amount: 1250 });
    expect(seen[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(recallDeposit()).toBe(deposit().id);
    expect(screen.getByText("Taking you to the payment page...")).toBeInTheDocument();
  });

  it("sends one request for a double click, and its key stays the same while the request runs", async () => {
    const keys: (string | null)[] = [];
    let answer: (value: Response) => void = () => undefined;
    server.use(
      contractHandler("createDeposit", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    const user = typing();
    await user.type(await screen.findByLabelText(DEPOSIT[0]), "1250");
    await user.dblClick(screen.getByRole("button", { name: DEPOSIT[1] }));
    await waitFor(() => expect(keys).toHaveLength(1));
    expect(screen.getByRole("button", { name: DEPOSIT[1] })).toBeDisabled();
    answer(reply(201, deposit(), { headers: LOCATION(deposit().id, "deposits") }));
    await waitFor(() => expect(goToExternal).toHaveBeenCalledTimes(1));
    expect(keys).toHaveLength(1);
  });

  it("makes the form usable again when the browser restores the page from its back-forward cache", async () => {
    server.use(contractHandler("createDeposit", () => reply(201, deposit(), { headers: LOCATION(deposit().id, "deposits") })));
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    expect(await screen.findByText("Taking you to the payment page...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: DEPOSIT[1] })).toBeDisabled();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });
    expect(screen.getByRole("button", { name: DEPOSIT[1] })).toBeDisabled();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(screen.getByRole("button", { name: DEPOSIT[1] })).toBeEnabled();
    expect(screen.queryByText("Taking you to the payment page...")).not.toBeInTheDocument();
  });

  it.each(["", "0", "-5", "12.5", "abc", "1000001"])("rejects the amount %j before any request", async (amount) => {
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], amount, DEPOSIT[1]);
    expect(await screen.findByText(/Enter a whole number of credits from 1 to 1,000,000/, { selector: "p.field-error" })).toBeInTheDocument();
    expect(screen.getByLabelText(DEPOSIT[0])).toHaveAttribute("aria-invalid", "true");
  });

  it("repeats the same attempt with the same key after a 503, and uses a new key for another amount", async () => {
    const keys: string[] = [];
    let answers = 0;
    server.use(
      contractHandler("createDeposit", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return answers++ === 0 ? unavailable("provider_unavailable", 9) : reply(201, deposit(), { headers: LOCATION(deposit().id, "deposits") });
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    const user = typing();
    await fillAndSubmit(DEPOSIT[0], "300", DEPOSIT[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 9 seconds.");
    await user.click(screen.getByRole("button", { name: DEPOSIT[1] }));
    await waitFor(() => expect(goToExternal).toHaveBeenCalled());
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("makes a new key when the amount changes after a failed try", async () => {
    const keys: string[] = [];
    server.use(
      contractHandler("createDeposit", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return unavailable("provider_unavailable", 1);
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    const user = typing();
    await fillAndSubmit(DEPOSIT[0], "300", DEPOSIT[1]);
    await screen.findByRole("alert");
    await user.clear(screen.getByLabelText(DEPOSIT[0]));
    await user.type(screen.getByLabelText(DEPOSIT[0]), "400");
    await user.click(screen.getByRole("button", { name: DEPOSIT[1] }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("starts a new attempt with a new key after a definitive answer", async () => {
    const keys: string[] = [];
    server.use(
      contractHandler("createDeposit", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return reply(409, problem(409, "Key reused", { code: "idempotency_key_reused", detail: "The key was used with another body." }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    const user = typing();
    await fillAndSubmit(DEPOSIT[0], "300", DEPOSIT[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("The key was used with another body.");
    await user.click(screen.getByRole("button", { name: DEPOSIT[1] }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("keeps the key when the provider has not given a payment page yet, and goes on with the same deposit", async () => {
    const keys: string[] = [];
    let answers = 0;
    server.use(
      contractHandler("createDeposit", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return answers++ === 0
          ? reply(201, deposit({ checkoutUrl: null }), { headers: LOCATION(deposit().id, "deposits") })
          : reply(200, deposit());
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    const user = typing();
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    expect(await screen.findByText(/payment page is not ready yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: DEPOSIT[1] }));
    await waitFor(() => expect(goToExternal).toHaveBeenCalledWith("https://pay.example.test/checkout/cs_123"));
    expect(keys[1]).toBe(keys[0]);
  });

  it("sends the same Idempotency-Key for the same amount after a reload that followed a lost answer", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${API_BASE}/v1/deposits`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return keys.length === 1 ? HttpResponse.error() : HttpResponse.json(deposit(), { status: 201, headers: LOCATION(deposit().id, "deposits") });
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("We do not know yet whether the deposit was started");
    // A reload: the page is gone, the tab's sessionStorage stays.
    cleanup();
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    await waitFor(() => expect(goToExternal).toHaveBeenCalledWith("https://pay.example.test/checkout/cs_123"));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("does not open an address that is not http or https", async () => {
    server.use(contractHandler("createDeposit", () => reply(201, deposit({ checkoutUrl: "javascript:alert(1)" }), { headers: LOCATION(deposit().id, "deposits") })));
    vi.mocked(goToExternal).mockClear();
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    expect(await screen.findByText(/payment page address is not valid/)).toBeInTheDocument();
    expect(goToExternal).not.toHaveBeenCalled();
  });

  it("goes to the return page when the same attempt already ended", async () => {
    server.use(
      contractHandler("createDeposit", () => reply(200, deposit({ status: "succeeded", completedAt: "2026-11-11T10:01:00Z" }))),
      contractHandler("getDeposit", () => reply(200, deposit({ status: "succeeded", completedAt: "2026-11-11T10:01:00Z" }))),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    expect(await screen.findByText(/Your deposit of 1,250 credits \(EUR 12\.50\) is complete/)).toBeInTheDocument();
  });

  it.each([
    [400, "The request is invalid"],
    [403, "Forbidden"],
  ])("shows the answer %i of the service", async (status, title) => {
    server.use(contractHandler("createDeposit", () => reply(status, problem(status, title, { detail: "Detail." }))));
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The deposit could not be started");
    expect(alert).toHaveTextContent(title);
  });

  it("does not claim a deposit failed when the gateway answered 502: the outcome is unknown and a repeat is safe", async () => {
    server.use(http.post(`${API_BASE}/v1/deposits`, () => new HttpResponse(null, { status: 502 })));
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We do not know yet whether the deposit was started");
    expect(alert).not.toHaveTextContent("could not be started");
    expect(screen.getByText(/cannot start a second deposit/)).toBeInTheDocument();
  });

  it("ends the session on a 401", async () => {
    server.use(contractHandler("createDeposit", () => unauthorized()));
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(DEPOSIT[0], "1250", DEPOSIT[1]);
    expect(await screen.findByText(/Your session has ended/)).toBeInTheDocument();
  });
});

describe("withdrawal", () => {
  const WITHDRAW = ["Amount to withdraw, in credits", "Withdraw"] as const;

  it("accepts with 202, follows the status until paid out and then stops asking", async () => {
    useFakeClock();
    const keys: string[] = [];
    const states = ["requested", "debited", "paid_out"] as const;
    let reads = 0;
    server.use(
      contractHandler("createWithdrawal", ({ request, body }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        expect(body).toEqual({ amount: 500 });
        return reply(202, withdrawal({ status: "requested" }), { headers: LOCATION(withdrawal().id, "withdrawals") });
      }),
      contractHandler("getWithdrawal", ({ params }) => {
        expect(params["id"]).toBe(withdrawal().id);
        const status = states[Math.min(reads++, 2)] ?? "paid_out";
        return reply(200, withdrawal({ status, completedAt: status === "paid_out" ? "2026-11-11T10:05:00Z" : null }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByText(/Requested: 500 credits \(EUR 5\.00\)\. We are taking the credits/)).toBeInTheDocument();
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    await advance(WITHDRAWAL_POLL_MS);
    expect(await screen.findByText(/Credits taken: 500 credits/)).toBeInTheDocument();
    await advance(WITHDRAWAL_POLL_MS);
    expect(await screen.findByText(/Paid out: 500 credits \(EUR 5\.00\) has been sent\./)).toBeInTheDocument();
    await advance(WITHDRAWAL_POLL_MS * 5);
    expect(reads).toBe(3);
  });

  it("explains a failed payout and its refund in plain words", async () => {
    useFakeClock();
    const states = ["debited", "failed", "refunded"] as const;
    let reads = 0;
    server.use(
      contractHandler("createWithdrawal", () => reply(202, withdrawal(), { headers: LOCATION(withdrawal().id, "withdrawals") })),
      contractHandler("getWithdrawal", () => reply(200, withdrawal({ status: states[Math.min(reads++, 2)] ?? "refunded", reason: reads > 1 ? "declined" : null }))),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByText(/The payout is on its way/)).toBeInTheDocument();
    await advance(WITHDRAWAL_POLL_MS);
    expect(await screen.findByText(/The payout failed\. Your credits are being returned/)).toBeInTheDocument();
    await advance(WITHDRAWAL_POLL_MS);
    expect(await screen.findByText(/The payout failed and your credits were returned/)).toBeInTheDocument();
  });

  it.each([
    ["paid_out", null, /Paid out: 500 credits/],
    ["rejected", "insufficient_credits", /not have enough credits\. No credits were taken/],
    ["rejected", "trading_unavailable", /trading was not available\. No credits were taken/],
    ["refunded", "declined", /credits were returned to your balance/],
  ] as const)("shows a finished withdrawal (%s, %s) without asking again", async (status, reason, text) => {
    server.use(contractHandler("createWithdrawal", () => reply(200, withdrawal({ status, reason, completedAt: "2026-11-11T10:05:00Z" }))));
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("says plainly that there are too few credits (409)", async () => {
    server.use(
      contractHandler("createWithdrawal", () =>
        reply(409, problem(409, "Not enough credits", { code: "insufficient_credits", detail: "Your balance is 100 credits.", withdrawalId: withdrawal().id }), {
          headers: LOCATION(withdrawal().id, "withdrawals"),
        }),
      ),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The withdrawal was not made");
    expect(alert).toHaveTextContent("Your balance is 100 credits.");
    expect(screen.getByText(/do not have enough credits for this withdrawal/)).toBeInTheDocument();
  });

  it("does not claim a withdrawal failed when the gateway answered 504: the outcome is unknown and a repeat is safe", async () => {
    server.use(http.post(`${API_BASE}/v1/withdrawals`, () => new HttpResponse(null, { status: 504 })));
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We do not know yet whether the withdrawal was made");
    expect(alert).not.toHaveTextContent("was not made");
    expect(screen.getByText(/cannot withdraw twice/)).toBeInTheDocument();
  });

  it("shows a 503 from trading with its wait", async () => {
    server.use(
      contractHandler("createWithdrawal", () =>
        reply(503, problem(503, "Trading is unavailable", { code: "trading_unavailable", withdrawalId: withdrawal().id }), { headers: { "Retry-After": "30", ...LOCATION(withdrawal().id, "withdrawals") } }),
      ),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Try again in about 30 seconds.");
    expect(screen.getByText(/Trading is not available right now\. Nothing was taken/)).toBeInTheDocument();
  });

  it("sends a new Idempotency-Key when the same amount is tried again after trading was unavailable", async () => {
    // The service stored that withdrawal as rejected: a repeat with the same key and body would only get the same 503.
    const keys: string[] = [];
    server.use(
      contractHandler("createWithdrawal", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return keys.length === 1
          ? reply(503, problem(503, "Trading is unavailable", { code: "trading_unavailable", withdrawalId: withdrawal().id }), { headers: { "Retry-After": "30", ...LOCATION(withdrawal().id, "withdrawals") } })
          : reply(200, withdrawal({ status: "paid_out", completedAt: "2026-11-11T10:05:00Z" }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 30 seconds.");
    await typing().click(screen.getByRole("button", { name: WITHDRAW[1] }));
    expect(await screen.findByText(/Paid out: 500 credits/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("sends the same Idempotency-Key for the same amount after a reload that followed a lost answer, and a new one for another amount", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${API_BASE}/v1/withdrawals`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return keys.length === 1 ? HttpResponse.error() : HttpResponse.json(withdrawal({ status: "paid_out", completedAt: "2026-11-11T10:05:00Z" }), { status: 200 });
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("We do not know yet whether the withdrawal was made");
    // A reload: the page is gone, the tab's sessionStorage stays.
    cleanup();
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByText(/Paid out: 500 credits/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("sends a new Idempotency-Key after a reload when the amount changed since the lost answer", async () => {
    const keys: string[] = [];
    server.use(
      http.post(`${API_BASE}/v1/withdrawals`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return keys.length === 1 ? HttpResponse.error() : HttpResponse.json(withdrawal({ status: "paid_out", completedAt: "2026-11-11T10:05:00Z" }), { status: 200 });
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    await screen.findByRole("alert");
    cleanup();
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "700", WITHDRAW[1]);
    expect(await screen.findByText(/Paid out: 500 credits/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("sends a new Idempotency-Key after a reload that followed a stored rejection (insufficient_credits)", async () => {
    const keys: string[] = [];
    server.use(
      contractHandler("createWithdrawal", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return keys.length === 1
          ? reply(409, problem(409, "Not enough credits", { code: "insufficient_credits", detail: "Your balance is 100 credits." }))
          : reply(200, withdrawal({ status: "paid_out", completedAt: "2026-11-11T10:05:00Z" }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    await screen.findByRole("alert");
    cleanup();
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByText(/Paid out: 500 credits/)).toBeInTheDocument();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("keeps the Idempotency-Key after a 503 that stored nothing, so the same attempt is finished", async () => {
    const keys: string[] = [];
    server.use(
      contractHandler("createWithdrawal", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key") ?? "");
        return keys.length === 1 ? unavailable("tenant_not_ready", 3) : reply(200, withdrawal({ status: "paid_out", completedAt: "2026-11-11T10:05:00Z" }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 3 seconds.");
    await typing().click(screen.getByRole("button", { name: WITHDRAW[1] }));
    expect(await screen.findByText(/Paid out: 500 credits/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    [400, "Invalid amount"],
    [403, "Forbidden"],
  ])("shows the answer %i of the service", async (status, title) => {
    server.use(contractHandler("createWithdrawal", () => reply(status, problem(status, title))));
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent(title);
  });

  it("rejects a wrong amount before any request", async () => {
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "0", WITHDRAW[1]);
    expect(await screen.findByText(/Enter a whole number of credits/, { selector: "p.field-error" })).toBeInTheDocument();
  });

  it("keeps asking after a 503 while following the status, and stops on a 404", async () => {
    useFakeClock();
    const answers = ["503", "debited", "404"] as const;
    let reads = 0;
    server.use(
      contractHandler("createWithdrawal", () => reply(202, withdrawal(), { headers: LOCATION(withdrawal().id, "withdrawals") })),
      contractHandler("getWithdrawal", () => {
        const answer = answers[Math.min(reads++, 2)];
        if (answer === "503") return unavailable("tenant_not_ready", 4);
        if (answer === "404") return reply(404, problem(404, "Withdrawal not found"));
        return reply(200, withdrawal());
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    await waitFor(() => expect(reads).toBe(1));
    expect(await screen.findByText(/The status could not be read/)).toBeInTheDocument();
    await advance(4000);
    await waitFor(() => expect(reads).toBe(2));
    await advance(WITHDRAWAL_POLL_MS);
    expect(await screen.findByText("Withdrawal not found")).toBeInTheDocument();
    await advance(WITHDRAWAL_POLL_MS * 5);
    expect(reads).toBe(3);
  });

  it("gives up after a while and offers to check again", async () => {
    useFakeClock();
    let reads = 0;
    server.use(
      contractHandler("createWithdrawal", () => reply(202, withdrawal(), { headers: LOCATION(withdrawal().id, "withdrawals") })),
      contractHandler("getWithdrawal", () => {
        reads += 1;
        return reply(200, withdrawal());
      }),
    );
    renderApp({ user: traderOidc(), path: "/wallet" });
    await fillAndSubmit(WITHDRAW[0], "500", WITHDRAW[1]);
    await waitFor(() => expect(reads).toBe(1));
    await advance(WITHDRAWAL_POLL_MS * WITHDRAWAL_POLL_MAX);
    expect(await screen.findByText(/takes longer than usual/)).toBeInTheDocument();
    expect(reads).toBe(WITHDRAWAL_POLL_MAX);
    await typing().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reads).toBe(WITHDRAWAL_POLL_MAX + 1));
  });
});

describe("deposit return pages", () => {
  function remember(id = deposit().id) {
    window.sessionStorage.setItem("chance.deposit-id", id);
  }

  it("shows 'processing' and polls until the deposit succeeded", async () => {
    useFakeClock();
    remember();
    let reads = 0;
    server.use(
      contractHandler("getDeposit", ({ params }) => {
        expect(params["id"]).toBe(deposit().id);
        reads += 1;
        return reply(200, reads < 3 ? deposit() : deposit({ status: "succeeded", completedAt: "2026-11-11T10:01:00Z" }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/deposits/success" });
    expect(await screen.findByRole("heading", { name: "Deposit" })).toBeInTheDocument();
    expect(await screen.findByText(/Your payment is being processed/)).toBeInTheDocument();
    await advance(DEPOSIT_POLL_MS);
    expect(screen.getByText(/Your payment is being processed/)).toBeInTheDocument();
    await advance(DEPOSIT_POLL_MS);
    expect(await screen.findByText(/Your deposit of 1,250 credits \(EUR 12\.50\) is complete/)).toBeInTheDocument();
    expect(screen.queryByText(/being processed/)).not.toBeInTheDocument();
    await advance(DEPOSIT_POLL_MS * 5);
    expect(reads).toBe(3);
  });

  it("says that the buyer left the payment page on the cancel path", async () => {
    useFakeClock();
    remember();
    server.use(contractHandler("getDeposit", () => reply(200, deposit())));
    renderApp({ user: traderOidc(), path: "/deposits/cancelled" });
    expect(await screen.findByRole("heading", { name: "Deposit cancelled" })).toBeInTheDocument();
    expect(await screen.findByText(/You left the payment page/)).toBeInTheDocument();
  });

  it.each([
    ["declined", /payment was declined/],
    ["expired", /payment page expired/],
    ["provider_unavailable", /provider could not be reached/],
  ] as const)("explains a failed deposit (%s)", async (failureReason, text) => {
    remember();
    server.use(contractHandler("getDeposit", () => reply(200, deposit({ status: "failed", failureReason, completedAt: "2026-11-11T10:31:00Z" }))));
    renderApp({ user: traderOidc(), path: "/deposits/success" });
    expect(await screen.findByText("The deposit did not go through.")).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to your wallet" })).toHaveAttribute("href", "/wallet");
  });

  it("says when it cannot tell which deposit it is", async () => {
    renderApp({ user: traderOidc(), path: "/deposits/success" });
    expect(await screen.findByText(/cannot tell which deposit you came from/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your wallet" })).toHaveAttribute("href", "/wallet");
  });

  it("shows a 404 and stops asking", async () => {
    useFakeClock();
    remember();
    let reads = 0;
    server.use(
      contractHandler("getDeposit", () => {
        reads += 1;
        return reply(404, problem(404, "Deposit not found", { detail: "No such deposit." }));
      }),
    );
    renderApp({ user: traderOidc(), path: "/deposits/success" });
    expect(await screen.findByRole("alert")).toHaveTextContent("No such deposit.");
    await advance(DEPOSIT_POLL_MS * 5);
    expect(reads).toBe(1);
    // Polling has stopped, so the region is no longer "busy" for assistive technology.
    expect(screen.getByRole("heading", { name: "Deposit" }).closest("section")).toHaveAttribute("aria-busy", "false");
  });

  it("shows a 503 with its wait and goes on asking", async () => {
    useFakeClock();
    remember();
    let reads = 0;
    server.use(contractHandler("getDeposit", () => (reads++ === 0 ? unavailable("tenant_not_ready", 3) : reply(200, deposit({ status: "succeeded", completedAt: "2026-11-11T10:01:00Z" })))));
    renderApp({ user: traderOidc(), path: "/deposits/success" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in about 3 seconds.");
    // The page waits as long as the service asked (3 seconds), not only the usual 2.
    await advance(DEPOSIT_POLL_MS);
    expect(reads).toBe(1);
    await advance(1000);
    expect(await screen.findByText(/is complete/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives up after a while and offers to check again", async () => {
    useFakeClock();
    remember();
    let reads = 0;
    server.use(
      contractHandler("getDeposit", () => {
        reads += 1;
        return reply(200, deposit());
      }),
    );
    renderApp({ user: traderOidc(), path: "/deposits/success" });
    await waitFor(() => expect(reads).toBe(1));
    await advance(DEPOSIT_POLL_MS * DEPOSIT_POLL_MAX);
    expect(await screen.findByText(/provider has not confirmed the payment yet/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deposit" }).closest("section")).toHaveAttribute("aria-busy", "false");
    await typing().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reads).toBe(DEPOSIT_POLL_MAX + 1));
    expect(screen.queryByText(/has not confirmed/)).not.toBeInTheDocument();
  });

  it("is not for a platform admin", async () => {
    renderApp({ user: platformAdminOidc(), path: "/deposits/success" });
    expect(await screen.findByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
  });
});
