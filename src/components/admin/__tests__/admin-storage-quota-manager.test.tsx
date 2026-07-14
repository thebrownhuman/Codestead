import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminStorageQuotaManager } from "../admin-storage-quota-manager";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("administrator storage quota manager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("performs fresh MFA first and sends the current row version", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      return json({ usedBytes: 1024, quotaBytes: 3 * 1024 ** 3, rowVersion: 8 });
    }));
    const user = userEvent.setup();
    render(<AdminStorageQuotaManager
      initialQuotaBytes={2 * 1024 ** 3}
      initialRowVersion={7}
      initialUsedBytes={1024}
      learnerId="learner-1"
    />);

    await user.selectOptions(screen.getByLabelText("New quota"), "3");
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.type(screen.getByLabelText("Recorded reason"), "Learner needs additional PDF storage");
    await user.click(screen.getByRole("button", { name: /Change quota/i }));

    await screen.findByText(/learner was notified/i);
    expect(calls[0]).toEqual({ url: "/api/security/fresh-mfa", body: { code: "123456" } });
    expect(calls[1]?.url).toBe("/api/admin/learners/learner-1/storage-quota");
    expect(calls[1]?.body).toMatchObject({
      expectedRowVersion: 7,
      quotaBytes: 3 * 1024 ** 3,
      reason: "Learner needs additional PDF storage",
    });
    expect(calls[1]?.body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("does not call the network when local MFA validation fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminStorageQuotaManager
      initialQuotaBytes={2 * 1024 ** 3}
      initialRowVersion={1}
      initialUsedBytes={0}
      learnerId="learner-1"
    />);
    await user.type(screen.getByLabelText(/authenticator code/i), "12");
    await user.type(screen.getByLabelText("Recorded reason"), "A complete recorded reason");
    await user.click(screen.getByRole("button", { name: /Change quota/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("six-digit"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
