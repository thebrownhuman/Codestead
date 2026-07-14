import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmptyState, ErrorState, LoadingState, StatusPill } from "../status-pill";

describe("administrator state components", () => {
  it("humanizes operational state labels", () => {
    render(<StatusPill status="pending_validation" />);
    expect(screen.getByText("pending validation")).toBeInTheDocument();
  });

  it("announces loading and error states", () => {
    const { rerender } = render(<LoadingState label="Loading learner" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading learner");

    rerender(<ErrorState message="Database unavailable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable");
  });

  it("offers and invokes recovery when an error can be retried", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Database unavailable" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders a specific empty state", () => {
    render(<EmptyState title="No appeals" detail="Nothing needs review." />);
    expect(screen.getByText("No appeals")).toBeInTheDocument();
    expect(screen.getByText("Nothing needs review.")).toBeInTheDocument();
  });
});
