import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminCertificateManager } from "../admin-certificate-manager";

const certificate = {
  id: "a3000000-0000-4000-8000-000000000001",
  verificationId: "public-token",
  learnerDisplayName: "Safe Learner",
  learnerEmail: "learner@example.test",
  courseTitle: "Python foundations",
  courseVersion: "1.0.0",
  policyVersion: "certificate-v1",
  issuedAt: "2026-07-14T00:00:00.000Z",
  status: "valid",
  revokedAt: null,
  revocationReason: null,
  verificationPath: "/verify/public-token",
};

describe("administrator certificate manager", () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ result: { replayed: false } }), { status: 200 });
    return new Response(JSON.stringify({ certificates: [certificate] }), { status: 200 });
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requires a private reason and sends a reasoned revocation request", async () => {
    const user = userEvent.setup();
    render(<AdminCertificateManager />);
    expect(await screen.findByText(/safe learner · learner@example.test/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /review revocation/i }));
    const reason = screen.getByLabelText(/private administrative reason/i);
    const confirm = screen.getByRole("button", { name: /confirm permanent revocation/i });
    expect(confirm).toBeDisabled();
    await user.type(reason, "Verified integrity correction");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe(`/api/admin/certificates/${certificate.id}/revoke`);
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ reason: "Verified integrity correction" });
    expect(await screen.findByText(/reason stays private/i)).toBeInTheDocument();
  });
});
