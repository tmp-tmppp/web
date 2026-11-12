import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import { ProblemDisplay } from "../src/components/ProblemDisplay";
import { StatusMessage } from "../src/components/StatusMessage";
import { describeWait } from "../src/lib/format";
import { newIdempotencyKey, randomId } from "../src/lib/ids";

describe("ProblemDisplay", () => {
  it("shows title, detail, invalid fields, the wait and the reference", () => {
    const error = new ApiError({
      status: 503,
      type: "urn:chance:problem:verify-busy",
      title: "Verification is busy",
      detail: "Too many verifications are running.",
      fieldErrors: [{ field: "to", message: "must be after from" }],
      retryAfterSeconds: 30,
      correlationId: "corr-123",
    });
    render(<ProblemDisplay error={error} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Verification is busy");
    expect(alert).toHaveTextContent("Too many verifications are running.");
    expect(alert).toHaveTextContent("to: must be after from");
    expect(alert).toHaveTextContent("Try again in about 30 seconds.");
    expect(alert).toHaveTextContent("Reference: corr-123");
  });

  it("never shows raw JSON or a stack", () => {
    const error = new ApiError({ status: 500, type: "about:blank", title: "Something went wrong on the server", detail: "Try again in a moment." });
    render(<ProblemDisplay error={error} />);
    expect(screen.getByRole("alert").textContent).not.toMatch(/[{}]|\bat \w+\.\w+ \(/);
  });

  it("can replace the heading and keep the problem's title below it", () => {
    render(<ProblemDisplay error={new ApiError({ status: 409, type: "t", title: "Last tenant admin" })} heading="The role could not be changed" />);
    expect(screen.getByText("The role could not be changed")).toBeInTheDocument();
    expect(screen.getByText("Last tenant admin")).toBeInTheDocument();
  });

  it("does not repeat a heading that equals the title", () => {
    render(<ProblemDisplay error={new ApiError({ status: 409, type: "t", title: "Conflict" })} heading="Conflict" />);
    expect(screen.getAllByText("Conflict")).toHaveLength(1);
  });

  it("shows a general message for an error that is not an API problem", () => {
    render(<ProblemDisplay error={new TypeError("Cannot read properties of undefined (reading 'x')")} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(alert).not.toHaveTextContent("Cannot read properties");
  });

  it("uses a given heading for an error that is not an API problem", () => {
    render(<ProblemDisplay error="boom" heading="The list could not be loaded" />);
    expect(screen.getByRole("alert")).toHaveTextContent("The list could not be loaded");
  });
});

describe("StatusMessage", () => {
  it("is a polite status", () => {
    render(<StatusMessage>Processing</StatusMessage>);
    expect(screen.getByRole("status")).toHaveTextContent("Processing");
  });
});

describe("helpers", () => {
  it("describes a wait in words", () => {
    expect(describeWait(0)).toBe("about 1 second");
    expect(describeWait(1)).toBe("about 1 second");
    expect(describeWait(0.2)).toBe("about 1 second");
    expect(describeWait(45)).toBe("about 45 seconds");
    expect(describeWait(119)).toBe("about 119 seconds");
    expect(describeWait(150)).toBe("about 3 minutes");
  });

  it("makes version 4 UUIDs that differ", () => {
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = Array.from({ length: 20 }, () => randomId());
    expect(ids.every((id) => pattern.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(20);
    expect(newIdempotencyKey()).toMatch(pattern);
  });
});
