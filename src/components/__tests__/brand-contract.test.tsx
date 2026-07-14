import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandMark } from "@/components/brand-mark";
import { LandingPage } from "@/components/landing/landing-page";

describe("Codestead brand contract", () => {
  it("exposes one accessible product name", () => {
    render(<BrandMark />);

    expect(screen.getByRole("img", { name: "Codestead" })).toHaveTextContent("Codestead");
  });

  it("keeps the learning promise and mentor identity on the public page", () => {
    render(<LandingPage />);

    expect(screen.getByText("Codestead · Build skills that stay.")).toBeVisible();
    expect(screen.getByText("Codestead mentor")).toBeVisible();
    expect(screen.queryByText("Buddy tutor")).not.toBeInTheDocument();
  });
});
