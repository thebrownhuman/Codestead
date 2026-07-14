import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminFallbackGrantManager } from "../admin-fallback-grant-manager";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const credential = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "nvidia_nim",
  label: "Admin NIM",
  lastFour: "N1M4",
};
const availableModels = [{ provider: "nvidia_nim", model: "offline/nim-model" }];

describe("administrator fallback grant manager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("performs fresh MFA before creating a bounded grant and never sends key material", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let listCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.startsWith("/api/admin/fallback-grants?")) {
        listCount += 1;
        return json({ grants: [], availableCredentials: [credential], availableModels, learnerConsent: { adminFallbackAi: true, providers: { nvidia_nim: true } } });
      }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === "/api/admin/fallback-grants") return json({ grant: { id: "grant-1" } }, { status: 201 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminFallbackGrantManager learnerId="learner-1" />);

    await screen.findByRole("option", { name: /Admin NIM/i });
    await user.clear(screen.getByLabelText("Maximum tokens"));
    await user.type(screen.getByLabelText("Maximum tokens"), "12500");
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.type(screen.getByLabelText("Recorded reason"), "Temporary course support budget");
    await user.click(screen.getByRole("button", { name: "Grant capped fallback" }));

    await screen.findByText(/Capped fallback access granted/i);
    expect(listCount).toBe(2);
    const fresh = calls.find((call) => call.url === "/api/security/fresh-mfa");
    const create = calls.find((call) => call.url === "/api/admin/fallback-grants");
    expect(fresh?.body).toEqual({ code: "123456" });
    expect(calls.indexOf(fresh!)).toBeLessThan(calls.indexOf(create!));
    expect(create?.body).toMatchObject({
      learnerId: "learner-1",
      credentialId: credential.id,
      model: "offline/nim-model",
      tokenBudget: 12500,
      rupeeBudgetPaise: 50000,
      inputPaisePerMillionTokens: 10000,
      outputPaisePerMillionTokens: 20000,
      reason: "Temporary course support budget",
    });
    expect(create?.body?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(create?.body)).not.toMatch(/ciphertext|api.?key|wrappedDataKey/i);
  });

  it("requires local MFA and reason validation before any grant mutation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/admin/fallback-grants?")) {
        return json({ grants: [], availableCredentials: [credential], availableModels, learnerConsent: { adminFallbackAi: true, providers: { nvidia_nim: true } } });
      }
      throw new Error("Mutation should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminFallbackGrantManager learnerId="learner-1" />);

    await screen.findByRole("option", { name: /Admin NIM/i });
    await user.type(screen.getByLabelText(/authenticator code/i), "123");
    await user.type(screen.getByLabelText("Recorded reason"), "short");
    await user.click(screen.getByRole("button", { name: "Grant capped fallback" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter the current six-digit authenticator code.",
    ));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows only safe grant metadata and fresh-MFA gates revocation", async () => {
    const grant = {
      id: "grant-1",
      learnerId: "learner-1",
      credentialId: credential.id,
      model: "offline/nim-model",
      tokenBudget: 50000,
      tokensUsed: 1500,
      rupeeBudgetPaise: 50000,
      rupeesUsedPaise: 1250,
      inputPaisePerMillionTokens: 10000,
      outputPaisePerMillionTokens: 20000,
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      revokedAt: null,
      provider: "nvidia_nim",
      credentialLastFour: "N1M4",
    };
    let revoked = false;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/admin/fallback-grants?")) {
        return json({ grants: revoked ? [{ ...grant, revokedAt: new Date().toISOString() }] : [grant], availableCredentials: [credential], availableModels, learnerConsent: { adminFallbackAi: true, providers: { nvidia_nim: true } } });
      }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === "/api/admin/fallback-grants/grant-1/revoke") {
        revoked = true;
        return json({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminFallbackGrantManager learnerId="learner-1" />);

    expect(await screen.findByText(/1,500 \/ 50,000 tokens/i)).toBeInTheDocument();
    expect(document.body.textContent).toContain("N1M4");
    expect(document.body.textContent).not.toMatch(/ciphertext|wrapped data key/i);
    await user.type(screen.getByLabelText(/authenticator code/i), "654321");
    await user.type(screen.getByLabelText("Recorded reason"), "Learner fallback no longer needed");
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await screen.findByText(/Fallback access revoked/i);
    expect(calls.indexOf("/api/security/fresh-mfa")).toBeLessThan(
      calls.indexOf("/api/admin/fallback-grants/grant-1/revoke"),
    );
  });
});
