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
  openBrowserOutbox: vi.fn(),
  purgeRecovery: vi.fn(),
  close: vi.fn(),
  withRepository: vi.fn(),
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
vi.mock("@/lib/browser-durability/indexed-db", () => ({
  openBrowserOutbox: mocks.openBrowserOutbox,
}));
vi.mock("@/lib/browser-durability/lifecycle", () => ({
  purgeBrowserRecoveryData: mocks.purgeRecovery,
  withBrowserRecoveryRepository: mocks.withRepository,
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
    mocks.close.mockReset();
    mocks.openBrowserOutbox.mockReset();
    mocks.purgeRecovery.mockReset();
    mocks.openBrowserOutbox.mockResolvedValue({ close: mocks.close });
    mocks.purgeRecovery.mockResolvedValue(undefined);
    mocks.withRepository.mockImplementation(async (
      openRepository: () => Promise<{ close(): void }>,
      operation: (repository: { close(): void }) => Promise<unknown>,
    ) => {
      let unavailable = false;
      let repository: { close(): void };
      try {
        repository = await openRepository();
      } catch {
        unavailable = true;
        repository = { close: vi.fn() };
      }
      try {
        const result = await operation(repository);
        if (unavailable) throw new Error("Browser recovery IndexedDB is unavailable.");
        return result;
      } finally {
        if (!unavailable) repository.close();
      }
    });
  });

  it("replaces the login page when the browser already has a valid session", async () => {
    mocks.getSession.mockResolvedValue(authenticated);
    render(<LoginForm />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/learn"));
    expect(mocks.signInEmail).not.toHaveBeenCalled();
    expect(mocks.purgeRecovery).not.toHaveBeenCalled();
  });

  it("withholds credentials until confirmed-anonymous recovery cleanup completes", async () => {
    let finish!: () => void;
    mocks.purgeRecovery.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    render(<LoginForm />);

    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.purgeRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repository: expect.any(Object),
    })));
    expect(screen.getByRole("status")).toHaveTextContent(/cleaning private browser recovery/i);

    await act(async () => finish());
    expect(await screen.findByLabelText("Email address")).toBeEnabled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("preserves recovery and offers only a session-check retry when session state is unknown", async () => {
    mocks.getSession
      .mockRejectedValueOnce(new TypeError("private network detail"))
      .mockResolvedValueOnce({ data: null, error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not confirm whether this browser is signed in/i);
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(mocks.purgeRecovery).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry session check" }));

    expect(await screen.findByLabelText("Email address")).toBeEnabled();
    expect(mocks.purgeRecovery).toHaveBeenCalledOnce();
  });

  it("withholds credentials and retries an anonymous cleanup failure", async () => {
    mocks.purgeRecovery
      .mockRejectedValueOnce(new Error("private database detail"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<LoginForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not clean private browser recovery storage/i);
    expect(screen.queryByText("private database detail")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry browser storage cleanup" }));

    expect(await screen.findByLabelText("Email address")).toBeEnabled();
    expect(mocks.openBrowserOutbox).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("still publishes anonymous cleanup when repository open fails and retries acquisition", async () => {
    mocks.openBrowserOutbox
      .mockRejectedValueOnce(new Error("IndexedDB open failed"))
      .mockResolvedValueOnce({ close: mocks.close });
    const user = userEvent.setup();
    render(<LoginForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not clean private browser recovery storage/i,
    );
    expect(mocks.purgeRecovery).toHaveBeenCalledOnce();
    expect(mocks.purgeRecovery).toHaveBeenCalledWith(expect.objectContaining({
      repository: expect.any(Object),
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
    }));
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry browser storage cleanup" }));
    expect(await screen.findByLabelText("Email address")).toBeEnabled();
    expect(mocks.openBrowserOutbox).toHaveBeenCalledTimes(2);
    expect(mocks.purgeRecovery).toHaveBeenCalledTimes(2);
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
