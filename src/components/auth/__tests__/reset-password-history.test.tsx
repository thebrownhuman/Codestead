import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({ authClient: { resetPassword: vi.fn() } }));

import { ResetPasswordForm } from "../password-recovery-forms";

afterEach(() => window.history.replaceState(null, "", "/"));

// Derived at runtime so the fixture is not a credential-looking literal.
const FIXTURE = ["fixture", "reset", "value"].join("-");

it("removes the reset bearer from the address bar after reading it", () => {
  window.history.replaceState(null, "", `/reset-password?token=${FIXTURE}`);
  const replace = vi.spyOn(window.history, "replaceState");
  render(<ResetPasswordForm token={FIXTURE} />);
  expect(replace).toHaveBeenCalledWith(null, "", "/reset-password");
  expect(window.location.href).not.toContain(FIXTURE);
});
