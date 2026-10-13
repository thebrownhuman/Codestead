import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestAdminJson } from "../admin-utils";
import { AdminStepUpDialog } from "../step-up";
import { registerStepUpPrompter, withStepUp } from "../step-up-request";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

afterEach(() => {
  registerStepUpPrompter(null);
  vi.unstubAllGlobals();
});

describe("administrator step-up", () => {
  it("settles the admin action when the open step-up component unmounts", async () => {
    const view = render(<AdminStepUpDialog />);
    const run = vi.fn().mockResolvedValue(json({ error: "FRESH_MFA_REQUIRED" }, 403));
    const completed = vi.fn();
    void withStepUp(run).then(completed);
    await screen.findByRole("dialog");
    view.unmount();
    await waitFor(() => expect(completed).toHaveBeenCalled());
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("allows a new generation to prompt after an abandoned global request", async () => {
    const stale = vi.fn(() => new Promise<boolean>(() => undefined));
    registerStepUpPrompter(stale);
    const refusal = () => Promise.resolve(json({ error: "FRESH_MFA_REQUIRED" }, 403));
    const completed = vi.fn();
    void withStepUp(refusal).then(completed);
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    registerStepUpPrompter(null);
    const fresh = vi.fn(async () => false);
    registerStepUpPrompter(fresh);
    void withStepUp(refusal).then(completed);
    await waitFor(() => expect(fresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
  });
  it("ignores stale owner cleanup and completion while the new generation is pending", async () => {
    let staleRelease: (value: boolean) => void = () => undefined;
    const stalePrompt = vi.fn(() => new Promise<boolean>((resolve) => { staleRelease = resolve; }));
    const staleCleanup = registerStepUpPrompter(stalePrompt);
    const run = () => Promise.resolve(json({ code: "FRESH_MFA_REQUIRED" }, 403));
    const staleAction = withStepUp(run);
    await waitFor(() => expect(stalePrompt).toHaveBeenCalledTimes(1));
    let freshRelease: (value: boolean) => void = () => undefined;
    const fresh = vi.fn(() => new Promise<boolean>((resolve) => { freshRelease = resolve; }));
    registerStepUpPrompter(fresh);
    const first = withStepUp(run);
    await waitFor(() => expect(fresh).toHaveBeenCalledTimes(1));
    staleCleanup();
    staleRelease(true);
    await expect(staleAction).resolves.toHaveProperty("status", 403);
    const second = withStepUp(run);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fresh).toHaveBeenCalledTimes(1);
    freshRelease(false);
    await expect(first).resolves.toHaveProperty("status", 403);
    await expect(second).resolves.toHaveProperty("status", 403);
  });
  it.each(["Cancel", "Escape", "navigation"])("settles the refusal on %s without retrying the action", async (dismissal) => {
    const user = userEvent.setup();
    render(<AdminStepUpDialog />);
    const run = vi.fn().mockResolvedValue(json({ error: "FRESH_MFA_REQUIRED" }, 403));
    const action = withStepUp(run);
    await screen.findByRole("dialog", { name: "Confirm it's you" });
    if (dismissal === "Cancel") await user.click(screen.getByRole("button", { name: "Cancel" }));
    else if (dismissal === "Escape") await user.keyboard("{Escape}");
    else fireEvent(window, new Event("popstate"));
    await expect(action).resolves.toHaveProperty("status", 403);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("traps step-up focus and returns to the action trigger on Escape", async () => {
    const user = userEvent.setup();
    const completed = vi.fn();
    const run = vi.fn().mockResolvedValue(json({ error: "FRESH_MFA_REQUIRED" }, 403));
    render(<><button onClick={() => { void withStepUp(run).then(completed); }} type="button">Admin action</button><AdminStepUpDialog /></>);
    const trigger = screen.getByRole("button", { name: "Admin action" });
    await user.click(trigger);
    const input = await screen.findByLabelText("Authenticator code");
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Verify and continue" })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("does not let an old verification response approve a new prompt", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminStepUpDialog />);
    const run = vi.fn(async () => json({ error: "FRESH_MFA_REQUIRED" }, 403));
    const first = withStepUp(run);
    await user.type(await screen.findByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(first).resolves.toHaveProperty("status", 403);
    const second = withStepUp(run);
    await screen.findByLabelText("Authenticator code");
    release(json({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("dialog", { name: "Confirm it's you" })).toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(2);
    await user.keyboard("{Escape}");
    await expect(second).resolves.toHaveProperty("status", 403);
  });
  it("prompts on FRESH_MFA_REQUIRED and retries the original request once", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(json({ error: "FRESH_MFA_REQUIRED" }, 403))
      .mockResolvedValueOnce(json({ ok: true }));
    const prompt = vi.fn(async () => true);
    registerStepUpPrompter(prompt);

    const response = await withStepUp(run);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it("returns the original refusal when the administrator cancels", async () => {
    const run = vi.fn().mockResolvedValue(json({ error: "FRESH_MFA_REQUIRED" }, 403));
    registerStepUpPrompter(async () => false);

    const response = await withStepUp(run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(403);
  });

  it("does not prompt for other refusals", async () => {
    const run = vi.fn().mockResolvedValue(json({ error: "ADMIN_REQUIRED" }, 403));
    const prompt = vi.fn(async () => true);
    registerStepUpPrompter(prompt);

    await withStepUp(run);

    expect(prompt).not.toHaveBeenCalled();
  });

  it("shares one prompt across parallel refusals", async () => {
    let release: (value: boolean) => void = () => undefined;
    const prompt = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    registerStepUpPrompter(prompt);
    const run = () => vi.fn()
      .mockResolvedValueOnce(json({ code: "FRESH_MFA_REQUIRED" }, 403))
      .mockResolvedValueOnce(json({ ok: true }));
    const first = withStepUp(run());
    const second = withStepUp(run());
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    release(true);

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("asks for the code in a dialog, verifies it, then completes the admin action", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      const approvals = fetchMock.mock.calls.filter(([value]) => String(value).endsWith("/approve")).length;
      return approvals === 1 ? json({ error: "FRESH_MFA_REQUIRED" }, 403) : json({ expiresAt: "2026-09-27T00:00:00Z" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminStepUpDialog />);

    const action = requestAdminJson<{ expiresAt: string }>("/api/admin/access-requests/r1/approve", { method: "POST" });
    await user.type(await screen.findByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));

    await expect(action).resolves.toEqual({ expiresAt: "2026-09-27T00:00:00Z" });
    expect(fetchMock).toHaveBeenCalledWith("/api/security/fresh-mfa", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open with the server message when the code is wrong", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/security/fresh-mfa"
      ? json({ error: "That code was not accepted." }, 400)
      : json({ error: "FRESH_MFA_REQUIRED" }, 403)));
    const user = userEvent.setup();
    render(<AdminStepUpDialog />);

    void requestAdminJson("/api/admin/access-requests/r1/approve", { method: "POST" }).catch(() => undefined);
    await user.type(await screen.findByLabelText("Authenticator code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));

    expect(await screen.findByText("That code was not accepted.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
