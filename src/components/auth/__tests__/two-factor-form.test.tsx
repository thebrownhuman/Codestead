import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { twoFactor: { verifyTotp: mocks.verifyTotp, verifyBackupCode: mocks.verifyBackupCode } },
}));

import { TwoFactorForm } from "../two-factor-form";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("two-factor session completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyTotp.mockResolvedValue({ data: { ok: true }, error: null });
    mocks.verifyBackupCode.mockResolvedValue({ data: { ok: true }, error: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function submit() {
    const user = userEvent.setup();
    render(<TwoFactorForm />);
    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
  }

  it("verifies and stamps an existing social session without using a pending credential challenge", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, redirectTo: "/learn" }));
    vi.stubGlobal("fetch", fetchMock);
    await submit();
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/learn"));
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes Better Auth's pending password challenge and then stamps the created session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: "Authentication required." }, 401))
      .mockResolvedValueOnce(json({ ok: true, redirectTo: "/onboarding" }));
    vi.stubGlobal("fetch", fetchMock);
    await submit();
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
    expect(mocks.verifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to a pending challenge after an authenticated invalid code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Code rejected." }, 403)));
    await submit();
    expect(await screen.findByText("Code rejected.")).toBeInTheDocument();
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("uses a single-use recovery code for a pending credential challenge", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: "Authentication required." }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TwoFactorForm />);
    await user.click(screen.getByRole("button", { name: "Use a saved recovery code" }));
    await user.type(screen.getByLabelText("Single-use recovery code"), "recovery-code-1234");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
    expect(mocks.verifyBackupCode).toHaveBeenCalledWith({
      code: "recovery-code-1234",
      trustDevice: false,
      disableSession: false,
    });
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("synthetic network failure"))],
    ["malformed JSON", () => Promise.resolve(new Response("not-json", { status: 200 }))],
  ])("recovers from %s, announces the error, and retains the code", async (_label, implementation) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(implementation));
    const user = userEvent.setup();
    render(<TwoFactorForm />);
    const code = screen.getByLabelText("Authenticator code");
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Verify and continue" })).toBeEnabled();
    expect(code).toHaveValue("123456");
  });
});
