import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LostDeviceRecoveryForm } from "../lost-device-recovery-form";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("lost-device recovery form", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/lost-device");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the neutral mailbox response and sends only the email", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        {
          ok: true,
          message:
            "If an eligible account has an active browser profile, a short-lived confirmation link has been emailed.",
        },
        202,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const actor = userEvent.setup();
    render(<StrictMode><LostDeviceRecoveryForm /></StrictMode>);
    await actor.type(await screen.findByLabelText("Approved account email"), "person@example.test");
    await actor.click(screen.getByRole("button", { name: "Email a confirmation link" }));
    expect(await screen.findByText(/if an eligible account has an active browser profile/i)).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: "person@example.test",
    });
  });

  it("reads the proof from a non-HTTP fragment, clears browser history, and submits no target identity", async () => {
    const proof = "single-use-mailbox-proof-value-1234567890";
    window.history.replaceState(null, "", `/lost-device#proof=${proof}`);
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        {
          ok: true,
          message:
            "Your mailbox was confirmed. The administrator must still verify your identity and approve the revocation.",
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const actor = userEvent.setup();
    render(<StrictMode><LostDeviceRecoveryForm /></StrictMode>);
    const reason = await screen.findByLabelText(
      "Why can you no longer use the approved browser profile?",
    );
    await waitFor(() => expect(window.location.hash).toBe(""));
    await actor.type(reason, "My only approved laptop was stolen yesterday.");
    await actor.click(screen.getByRole("button", { name: "Confirm and request review" }));
    expect(await screen.findByText(/administrator must still verify your identity/i)).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      proof,
      reason: "My only approved laptop was stolen yesterday.",
    });
    expect(document.body.textContent).not.toContain(proof);
    expect(window.location.href).not.toContain(proof);
  });

  it("recovers from a rejected request and retains the approved email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("synthetic network failure")));
    const actor = userEvent.setup();
    render(<StrictMode><LostDeviceRecoveryForm /></StrictMode>);
    const email = await screen.findByLabelText("Approved account email");
    await actor.type(email, "person@example.test");
    await actor.click(screen.getByRole("button", { name: "Email a confirmation link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Email a confirmation link" })).toBeEnabled();
    expect(email).toHaveValue("person@example.test");
  });

  it("recovers from malformed verification JSON and retains the recovery reason", async () => {
    const proof = "single-use-mailbox-proof-value-1234567890";
    window.history.replaceState(null, "", `/lost-device#proof=${proof}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 502 })));
    const actor = userEvent.setup();
    render(<StrictMode><LostDeviceRecoveryForm /></StrictMode>);
    const reason = await screen.findByLabelText(
      "Why can you no longer use the approved browser profile?",
    );
    await actor.type(reason, "My only approved laptop was stolen yesterday.");
    await actor.click(screen.getByRole("button", { name: "Confirm and request review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be accepted");
    expect(screen.getByRole("button", { name: "Confirm and request review" })).toBeEnabled();
    expect(reason).toHaveValue("My only approved laptop was stolen yesterday.");
  });
});
