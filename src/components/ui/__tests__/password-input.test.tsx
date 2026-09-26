import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PasswordInput } from "../password-input";

describe("PasswordInput", () => {
  it("masks the value by default and toggles visibility via a labeled, keyboard-reachable button", async () => {
    const user = userEvent.setup();
    render(<PasswordInput id="password" name="password" autoComplete="current-password" />);

    const field = document.getElementById("password") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("current-password");

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("type", "button");

    await user.type(field, "correct horse battery staple");
    expect(field.type).toBe("password");

    toggle.focus();
    await user.keyboard("{Enter}");

    expect(field.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    expect(field.value).toBe("correct horse battery staple");
  });

  it("never submits the enclosing form when the toggle is activated", async () => {
    const user = userEvent.setup();
    let submitCount = 0;
    render(
      <form onSubmit={(event) => { event.preventDefault(); submitCount += 1; }}>
        <PasswordInput name="password" />
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(submitCount).toBe(0);
  });
});
