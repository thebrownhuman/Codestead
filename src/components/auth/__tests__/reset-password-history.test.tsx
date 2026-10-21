import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({ authClient: { resetPassword: vi.fn() } }));

import { ResetPasswordForm } from "../password-recovery-forms";

afterEach(() => window.history.replaceState(null, "", "/"));

it("removes the reset bearer from the address bar after reading it", () => {
  window.history.replaceState(null, "", "/reset-password?token=bearer-token-value-123456");
  const replace = vi.spyOn(window.history, "replaceState");
  render(<ResetPasswordForm token="bearer-token-value-123456" />);
  expect(replace).toHaveBeenCalledWith(null, "", "/reset-password");
  expect(window.location.href).not.toContain("bearer-token-value");
});
