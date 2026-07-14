import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewQueue } from "../review-queue";

describe("learner skill refresh queue", () => {
  it("distinguishes memory practice and links administrators to course review", () => {
    render(<ReviewQueue admin />);

    expect(screen.getByText("Learner spaced retrieval")).toBeInTheDocument();
    expect(screen.getByText(/personal memory-practice queue/i)).toBeInTheDocument();
    expect(screen.getByText("Looking for course editorial review?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open course review/i })).toHaveAttribute("href", "/admin/curriculum");
  });

  it("does not expose the administrator handoff to a learner", () => {
    render(<ReviewQueue />);

    expect(screen.queryByRole("link", { name: /Open course review/i })).not.toBeInTheDocument();
  });
});
