import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminSessionControls } from "../admin-session-controls";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

const sessions = {
  sessions: [{
    id: "session-1", current: false, state: "active", deviceLabel: "Chrome on Windows",
    lastSeenAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-12-20T10:00:00.000Z", endedAt: null,
  }],
  revocationRequests: [],
};

describe("administrator session controls feedback", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function revokeWith(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminSessionControls learnerId="learner-1" />);
    await screen.findByText("Chrome on Windows");
    await user.type(screen.getByLabelText("Current six-digit authenticator code"), "123456");
    await user.type(screen.getByLabelText("Recorded reason"), "Learner reported a lost laptop.");
    await user.click(screen.getByRole("button", { name: "Revoke" }));
  }

  it("announces a failed revoke as an error alert, not a success", async () => {
    await revokeWith(vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions")) return json(sessions);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith("/revoke")) return json({ error: "Session could not be revoked." }, { status: 409 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Session could not be revoked.");
    expect(alert.className).toMatch(/inlineError/);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a successful revoke as a polite status", async () => {
    await revokeWith(vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions")) return json(sessions);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url.endsWith("/revoke")) return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Session revoked. The learner was notified.");
    expect(status.className).toMatch(/inlineSuccess/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
