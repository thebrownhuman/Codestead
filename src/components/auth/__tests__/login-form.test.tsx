import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    getSession: mocks.getSession,
    signIn: {
      email: mocks.signInEmail,
      social: mocks.signInSocial,
    },
  },
}));

import { LoginForm } from "../login-form";

const authenticated = {
  data: {
    session: { id: "session-1" },
    user: { id: "admin-1" },
  },
  error: null,
};

describe("login session resume guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ data: null, error: null });
    mocks.signInEmail.mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  });

  it("replaces the login page when the browser already has a valid session", async () => {
    mocks.getSession.mockResolvedValue(authenticated);
    render(<LoginForm />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/learn"));
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });

  it("checks again when browser Back restores the login page from cache", async () => {
    render(<LoginForm />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());

    mocks.getSession.mockResolvedValue(authenticated);
    act(() => window.dispatchEvent(new Event("pageshow")));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/learn"));
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it("resumes the existing session when sign-in reports a duplicate-session failure", async () => {
    mocks.getSession
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce(authenticated);
    mocks.signInEmail.mockResolvedValue({
      data: null,
      error: { code: "FAILED_TO_CREATE_SESSION", message: "Failed to create session" },
    });
    const user = userEvent.setup();
    render(<LoginForm />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());

    await user.type(screen.getByLabelText("Email address"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "a-secure-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/learn"));
    expect(screen.queryByText("Failed to create session")).not.toBeInTheDocument();
  });

  it("recovers from a rejected sign-in request without clearing credentials", async () => {
    mocks.signInEmail.mockRejectedValueOnce(new TypeError("synthetic network failure"));
    const user = userEvent.setup();
    render(<LoginForm />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());

    const email = screen.getByLabelText("Email address");
    const password = screen.getByLabelText("Password");
    await user.type(email, "learner@example.test");
    await user.type(password, "a-secure-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(email).toHaveValue("learner@example.test");
    expect(password).toHaveValue("a-secure-password");
  });
});
