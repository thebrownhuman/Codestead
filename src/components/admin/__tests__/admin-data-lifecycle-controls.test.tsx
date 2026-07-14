import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminDataLifecycleControls } from "../admin-data-lifecycle-controls";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("administrator data lifecycle controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps deletion disabled until exact confirmation and performs fresh MFA first", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === "/api/admin/learners/learner-1/delete-account") {
        return json({
          report: {
            tombstoneId: "tombstone-1",
            backupStatus: "awaiting_retention_expiry",
            backupRetentionUntil: "2027-07-12T00:00:00.000Z",
            backupNotice: "Backups are not claimed erased.",
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminDataLifecycleControls learnerId="learner-1" />);

    const deleteButton = screen.getByRole("button", { name: /Delete learner account/i });
    expect(deleteButton).toBeDisabled();
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.type(screen.getByLabelText("Recorded reason"), "Learner requested account deletion");
    await user.type(screen.getByLabelText(/Type DELETE/i), "delete");
    expect(deleteButton).toBeDisabled();
    await user.clear(screen.getByLabelText(/Type DELETE/i));
    await user.type(screen.getByLabelText(/Type DELETE/i), "DELETE");
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);

    await screen.findByText(/Primary data deleted/i);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      url: "/api/security/fresh-mfa",
      body: { code: "123456" },
    });
    expect(calls[1]?.url).toBe("/api/admin/learners/learner-1/delete-account");
    expect(calls[1]?.body).toMatchObject({
      confirmation: "DELETE",
      reason: "Learner requested account deletion",
    });
    expect(calls[1]?.body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(document.body.textContent).toContain("not claimed erased");
  });

  it("does not call the network when local MFA or reason validation fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminDataLifecycleControls learnerId="learner-1" />);

    await user.type(screen.getByLabelText(/authenticator code/i), "123");
    await user.type(screen.getByLabelText("Recorded reason"), "too short");
    await user.click(screen.getByRole("button", { name: /Export bounded NDJSON/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter the current six-digit authenticator code.",
    ));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
