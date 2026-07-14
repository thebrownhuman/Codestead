import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminCredentialManager } from "../admin-credential-manager";
import type { SafeCredentialSummary } from "../types";

const learnerId = "b1000000-0000-4000-8000-000000000002";
const credential: SafeCredentialSummary = {
  id: "a1000000-0000-4000-8000-000000000001",
  ownerPublicId: learnerId,
  ownerName: "Learner",
  provider: "nvidia_nim",
  lastFour: "ABCD",
  status: "active",
  preferred: true,
  lastValidatedAt: null,
  lastUsedAt: null,
  failureCode: null,
};
const reason = "Help the learner repair their provider configuration.";
const plaintext = "temporary-provider-plaintext-1234";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function renderManager(onChanged = vi.fn(async () => undefined)) {
  render(
    <AdminCredentialManager
      credentials={[credential]}
      learnerId={learnerId}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

async function completeCeremony(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/authenticator code/i), "123456");
  await user.type(screen.getByLabelText("Recorded reason"), reason);
}

describe("administrator credential ceremony", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows only safe identifier metadata in the ordinary view", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderManager();
    expect(screen.getByText("nvidia nim")).toBeInTheDocument();
    expect(screen.getByText(/•••• ABCD/)).toBeInTheDocument();
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/authenticator code/i)).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(/replacement credential/i)).toHaveAttribute("type", "password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs fresh MFA before reveal and clears plaintext on demand", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      return json({ credential: plaintext, provider: "nvidia_nim", lastFour: "ABCD" });
    }));
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderManager();
    await completeCeremony(user);
    await user.click(screen.getByRole("button", { name: /Reveal for 30 seconds/i }));

    expect(await screen.findByText(plaintext)).toHaveAttribute("data-sensitive", "credential");
    expect(calls).toEqual([
      { url: "/api/security/fresh-mfa", body: { code: "123456" } },
      {
        url: `/api/admin/credentials/${credential.id}/reveal`,
        body: { reason },
      },
    ]);
    expect(storageSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Clear now/i }));
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
  });

  it("automatically removes revealed plaintext after thirty seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input) === "/api/security/fresh-mfa"
        ? json({ ok: true })
        : json({ credential: plaintext, provider: "nvidia_nim" })
    )));
    renderManager();
    fireEvent.change(screen.getByLabelText(/authenticator code/i), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("Recorded reason"), { target: { value: reason } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Reveal for 30 seconds/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(plaintext)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
  });

  it("sends replacement material only to the owner-bound mutation endpoint and clears the field", async () => {
    const replacement = "replacement-provider-material-5678";
    const calls: Array<{ url: string; body: Record<string, unknown>; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body, method: String(init?.method) });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      return json({ ok: true, action: "replace", status: "active" });
    }));
    const onChanged = renderManager();
    const user = userEvent.setup();
    await completeCeremony(user);
    await user.type(screen.getByLabelText(/replacement credential/i), replacement);
    await user.click(screen.getByRole("button", { name: /Replace credential/i }));

    await screen.findByText(/learner was notified/i);
    expect(calls[0]).toEqual({
      url: "/api/security/fresh-mfa",
      body: { code: "123456" },
      method: "POST",
    });
    expect(calls[1]).toEqual({
      url: `/api/admin/credentials/${credential.id}`,
      method: "PATCH",
      body: {
        learnerId,
        reason,
        action: "replace",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        secret: replacement,
      },
    });
    expect(screen.getByLabelText(/replacement credential/i)).toHaveValue("");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reuses one UUID when a credential test loses its first transport response", async () => {
    const mutationBodies: Record<string, unknown>[] = [];
    let mutationAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      mutationAttempts += 1;
      mutationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (mutationAttempts === 1) throw new TypeError("synthetic lost response");
      return json({ ok: true, action: "test", status: "active" });
    }));
    const user = userEvent.setup();
    renderManager();
    await completeCeremony(user);
    await user.click(screen.getByRole("button", { name: /Test credential/i }));

    expect(await screen.findByText(/completed with status active/i)).toBeInTheDocument();
    expect(mutationBodies).toHaveLength(2);
    expect(mutationBodies[0]).toEqual(mutationBodies[1]);
    expect(mutationBodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("requires explicit deletion confirmation before any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderManager();
    await completeCeremony(user);
    await user.click(screen.getByRole("button", { name: /Delete credential/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/permanently deleted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains no browser-persistence or clipboard path for plaintext", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/admin/admin-credential-manager.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|clipboard|writeText/);
    expect(source).toContain("window.setTimeout(clearReveal, REVEAL_LIFETIME_MS)");
    expect(source).toContain("return () => clearReveal();");
  });
});
