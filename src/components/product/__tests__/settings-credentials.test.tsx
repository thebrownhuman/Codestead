import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../settings-view";

const credential = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "nvidia_nim",
  label: "Personal NIM",
  lastFour: "abcd",
  status: "active",
  isPreferred: true,
  routingConsented: true,
  lastValidatedAt: "2026-07-12T10:00:00.000Z",
};

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("provider credential settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows only masked metadata and reauthenticates before testing a key", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/credentials" && !init?.method) return json({ credentials: [credential] });
      if (url === "/api/security/fresh-mfa") {
        return json({ ok: true, validUntil: "2026-07-12T10:05:00.000Z" });
      }
      if (url.endsWith(credential.id) && init?.method === "PATCH") {
        return json({ ok: true, status: "active" });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SettingsView />);
    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    expect(screen.getByText(/•••• abcd/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ciphertext|wrapped data key/i);

    await user.type(screen.getByLabelText("Authenticator code for provider changes"), "123456");
    await user.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/security/fresh-mfa",
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/credentials/${credential.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ action: "test" }),
        }),
      );
    });
  });

  it("replaces a key through the dedicated fresh-MFA mutation without returning it", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url === "/api/credentials" && method === "GET") return json({ credentials: [credential] });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith(credential.id) && method === "PATCH") return json({ ok: true, status: "active" });
      throw new Error(`Unexpected request: ${url} ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code for provider changes"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify authenticator" }));
    await screen.findByRole("button", { name: "Verified" });
    await user.click(screen.getByRole("button", { name: "Replace" }));

    expect(screen.getByRole("heading", { name: "Replace Personal NIM" })).toBeInTheDocument();
    const replacement = "synthetic-new-provider-key";
    await user.type(screen.getByLabelText(/New API key/), replacement);
    await user.click(screen.getByRole("button", { name: "Replace encrypted key" }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: `/api/credentials/${credential.id}`,
        method: "PATCH",
        body: JSON.stringify({ action: "replace", secret: replacement }),
      });
    });
    expect(document.body.textContent).not.toContain(replacement);
  });

  it("focuses, dismisses, and restores focus for the shared provider dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/credentials") return json({ credentials: [credential] });
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Add provider" });
    await user.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Add an AI provider" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add an AI provider" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Add an AI provider" });
    const backdrop = dialog.parentElement!;
    fireEvent.mouseDown(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add an AI provider" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it.each([
    ["an HTTP 500", () => Promise.resolve(json({ error: "Provider metadata is unavailable." }, { status: 500 }))],
    ["a rejected network request", () => Promise.reject(new TypeError("synthetic network failure"))],
  ])("distinguishes %s from an empty provider list and offers retry", async (_label, load) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(load));
    render(<SettingsView />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "AI providers could not be loaded" })).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "No AI providers yet" })).not.toBeInTheDocument();
  });

  it("recovers from rejected MFA verification and retains the authenticator code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/credentials") return json({ credentials: [credential] });
      if (String(input) === "/api/security/fresh-mfa") throw new TypeError("synthetic network failure");
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    const code = screen.getByLabelText("Authenticator code for provider changes");
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Verify authenticator" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Verify authenticator" })).toBeEnabled();
    expect(code).toHaveValue("123456");
  });

  it("recovers from a rejected credential mutation and retains MFA data", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/credentials") return json({ credentials: [credential] });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith(credential.id) && init?.method === "PATCH") throw new TypeError("synthetic network failure");
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    }));
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    const code = screen.getByLabelText("Authenticator code for provider changes");
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be changed");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    expect(code).toBeEnabled();
    expect(code).toHaveValue("123456");
  });

  it("surfaces a rejected post-mutation refresh and restores usable controls", async () => {
    let credentialLoads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/credentials") {
        credentialLoads += 1;
        if (credentialLoads === 1) return json({ credentials: [credential] });
        throw new TypeError("synthetic refresh failure");
      }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith(credential.id) && init?.method === "PATCH") return json({ ok: true });
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    }));
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code for provider changes"), "123456");
    await user.click(screen.getByRole("button", { name: "Test" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "AI providers could not be loaded" })).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByLabelText("Authenticator code for provider changes")).toBeEnabled();
  });

  it("retains a replacement key when the replacement request is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/credentials") return json({ credentials: [credential] });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith(credential.id) && init?.method === "PATCH") throw new TypeError("synthetic replacement failure");
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    }));
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code for provider changes"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify authenticator" }));
    await screen.findByRole("button", { name: "Verified" });
    await user.click(screen.getByRole("button", { name: "Replace" }));
    const replacement = screen.getByLabelText(/New API key/);
    await user.type(replacement, "synthetic-new-provider-key");
    await user.click(screen.getByRole("button", { name: "Replace encrypted key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be replaced");
    expect(screen.getByRole("button", { name: "Replace encrypted key" })).toBeEnabled();
    expect(replacement).toHaveValue("synthetic-new-provider-key");
  });

  it("requires deliberate confirmation before deleting a provider", async () => {
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/credentials") return json({ credentials: deleted ? [] : [credential] });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith(credential.id) && init?.method === "DELETE") {
        deleted = true;
        return json({ ok: true });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code for provider changes"), "123456");
    const deleteTrigger = screen.getByRole("button", { name: "Delete Personal NIM" });
    await user.click(deleteTrigger);
    let dialog = screen.getByRole("dialog", { name: "Delete Personal NIM?" });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delete Personal NIM?" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(deleteTrigger).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Delete Personal NIM" }));
    dialog = screen.getByRole("dialog", { name: "Delete Personal NIM?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete Personal NIM" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    expect(await screen.findByRole("heading", { name: "No AI providers yet" })).toBeInTheDocument();
  });

  it("does not dismiss the delete dialog while its mutation is busy", async () => {
    let resolveDelete!: (value: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    let deleted = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/credentials") return json({ credentials: deleted ? [] : [credential] });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith(credential.id) && init?.method === "DELETE") {
        const response = await pendingDelete;
        deleted = true;
        return response;
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    }));
    const user = userEvent.setup();
    render(<SettingsView />);

    expect(await screen.findByText("Personal NIM")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code for provider changes"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify authenticator" }));
    await screen.findByRole("button", { name: "Verified" });
    await user.click(screen.getByRole("button", { name: "Delete Personal NIM" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Personal NIM?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete Personal NIM" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /Deleting/ })).toBeDisabled());

    await user.keyboard("{Escape}");
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByRole("dialog", { name: "Delete Personal NIM?" })).toBeInTheDocument();

    await act(async () => { resolveDelete(json({ ok: true })); });
    expect(await screen.findByRole("heading", { name: "No AI providers yet" })).toBeInTheDocument();
  });
});
