import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  searchParamsGet: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  openBrowserOutbox: vi.fn(),
  purgeRecovery: vi.fn(),
  close: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => ({ get: mocks.searchParamsGet }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    requestPasswordReset: mocks.requestPasswordReset,
    resetPassword: mocks.resetPassword,
  },
}));
vi.mock("@/lib/browser-durability/indexed-db", () => ({
  openBrowserOutbox: mocks.openBrowserOutbox,
}));
vi.mock("@/lib/browser-durability/lifecycle", () => ({
  purgeBrowserRecoveryData: mocks.purgeRecovery,
}));

import { AccessRequestForm } from "../access-request-form";
import { ActivationForm } from "../activation-form";
import { ForgotPasswordForm, ResetPasswordForm } from "../password-recovery-forms";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("public auth form failure recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParamsGet.mockImplementation((name: string) => name === "token" ? "activation-token" : null);
    mocks.requestPasswordReset.mockResolvedValue({ data: { ok: true }, error: null });
    mocks.resetPassword.mockResolvedValue({ data: { ok: true }, error: null });
    mocks.close.mockReset();
    mocks.openBrowserOutbox.mockReset();
    mocks.purgeRecovery.mockReset();
    mocks.openBrowserOutbox.mockResolvedValue({ close: mocks.close });
    mocks.purgeRecovery.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recovers from malformed access-request JSON and retains every field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 502 })));
    const user = userEvent.setup();
    render(<AccessRequestForm />);

    const name = screen.getByLabelText("Your name");
    const email = screen.getByLabelText("Email address");
    const reason = screen.getByLabelText(/What would you like to learn/);
    const adult = screen.getByRole("checkbox", { name: /I confirm that I am 18 or older/ });
    await user.type(name, "Learner One");
    await user.type(email, "learner@example.test");
    await user.type(reason, "C++ and data structures");
    await user.click(adult);
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
    expect(name).toHaveValue("Learner One");
    expect(email).toHaveValue("learner@example.test");
    expect(reason).toHaveValue("C++ and data structures");
    expect(adult).toBeChecked();
  });

  it("recovers from a rejected password-reset request and retains the email", async () => {
    mocks.requestPasswordReset.mockRejectedValueOnce(new TypeError("synthetic network failure"));
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);

    const email = screen.getByLabelText("Email address");
    await user.type(email, "learner@example.test");
    await user.click(screen.getByRole("button", { name: "Email a reset link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Email a reset link" })).toBeEnabled();
    expect(email).toHaveValue("learner@example.test");
  });

  it("recovers from a rejected password change and retains both matching passwords", async () => {
    mocks.resetPassword.mockRejectedValueOnce(new TypeError("synthetic network failure"));
    const user = userEvent.setup();
    render(<ResetPasswordForm token="reset-token" />);

    const password = screen.getByLabelText("New password");
    const confirmation = screen.getByLabelText("Confirm new password");
    await user.type(password, "a-long-new-password");
    await user.type(confirmation, "a-long-new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid, expired, or already used");
    expect(screen.getByRole("button", { name: "Change password" })).toBeEnabled();
    expect(password).toHaveValue("a-long-new-password");
    expect(confirmation).toHaveValue("a-long-new-password");
  });

  it("withholds sign-in after password reset until global browser recovery cleanup completes", async () => {
    let finish!: () => void;
    mocks.purgeRecovery.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const user = userEvent.setup();
    render(<ResetPasswordForm token="reset-token" />);

    await user.type(screen.getByLabelText("New password"), "a-long-new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "a-long-new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText(/Password changed.*sessions have been revoked/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/cleaning private browser recovery/i);
    await act(async () => finish());

    expect(await screen.findByRole("link", { name: "Sign in again" })).toBeInTheDocument();
    expect(mocks.purgeRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repository: expect.any(Object),
    }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("reports a confirmed password change separately from cleanup failure and retries", async () => {
    mocks.purgeRecovery
      .mockRejectedValueOnce(new Error("private recovery detail"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<ResetPasswordForm token="reset-token" />);

    await user.type(screen.getByLabelText("New password"), "a-long-new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "a-long-new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /password changed.*sessions.*revoked.*browser cleanup still needs/i,
    );
    expect(screen.queryByText("private recovery detail")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry browser storage cleanup" }));

    expect(await screen.findByRole("link", { name: "Sign in again" })).toBeInTheDocument();
    expect(mocks.openBrowserOutbox).toHaveBeenCalledTimes(2);
  });

  it("recovers from malformed activation JSON and retains all activation values", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ valid: true, email: "invited@example.test" }))
      .mockResolvedValueOnce(new Response("not-json", { status: 502 })));
    const user = userEvent.setup();
    render(<ActivationForm />);

    const name = await screen.findByLabelText("Display name");
    const password = screen.getByLabelText("Create password");
    const confirmation = screen.getByLabelText("Confirm password");
    await user.type(name, "Invited Learner");
    await user.type(password, "a-long-new-password");
    await user.type(confirmation, "a-long-new-password");
    await user.click(screen.getByRole("button", { name: "Activate account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Activate account" })).toBeEnabled();
    expect(name).toHaveValue("Invited Learner");
    expect(password).toHaveValue("a-long-new-password");
    expect(confirmation).toHaveValue("a-long-new-password");
  });

  it("blocks duplicate activation submissions before React can rerender the button", async () => {
    let resolveActivation!: (response: Response) => void;
    const pendingActivation = new Promise<Response>((resolve) => {
      resolveActivation = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ valid: true, email: "invited@example.test" }))
      .mockReturnValueOnce(pendingActivation);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ActivationForm />);

    await user.type(await screen.findByLabelText("Display name"), "Invited Learner");
    await user.type(screen.getByLabelText("Create password"), "a-long-new-password");
    await user.type(screen.getByLabelText("Confirm password"), "a-long-new-password");
    const button = screen.getByRole("button", { name: "Activate account" });
    const form = button.closest("form");
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "Activating…" })).toBeDisabled());
    await act(async () => {
      resolveActivation(json({ ok: true }));
      await pendingActivation;
    });
    expect(await screen.findByText(/Your account is ready/)).toBeInTheDocument();
  });
});
