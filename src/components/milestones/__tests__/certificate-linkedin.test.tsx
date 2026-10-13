import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CertificatesPage from "@/app/(app)/certificates/page";
import { buildLinkedInCertificateUrl } from "@/lib/certificates/linkedin";

vi.mock("@/components/milestones/trophy-cabinet", () => ({ TrophyCabinet: () => null }));

const certificate = {
  id: "certificate-id", verificationId: "opaque-token", learnerDisplayName: "Owner",
  courseTitle: "Web & AI 日本語", courseVersion: "1", issuedAt: "2026-07-14T00:00:00.000Z",
  status: "valid", revokedAt: null, revocationReason: null, verificationPath: "/verify/opaque-token",
};

describe("owner certificate LinkedIn link", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv("APP_NAME", "Learning & Skills 学校");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ certificates: [certificate], candidates: [] })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("offers the configured link on the owner's certificates page with a safe new tab", async () => {
    render(<CertificatesPage />);
    const link = await screen.findByRole("link", { name: /Add to LinkedIn/ });
    expect(link).toHaveAttribute("href", buildLinkedInCertificateUrl(certificate, "Learning & Skills 学校"));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/certificates", { cache: "no-store" });
  });

  it("omits the button for revoked certificates", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ certificates: [{ ...certificate, status: "revoked", revokedAt: "2026-08-01T00:00:00Z" }], candidates: [] })));
    render(<CertificatesPage />);
    await screen.findByText(/Owner · issued/);
    expect(screen.queryByRole("link", { name: /Add to LinkedIn/ })).not.toBeInTheDocument();
  });

  it("offers a link only for the valid certificate in a mixed collection", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ certificates: [certificate, { ...certificate, id: "revoked-id", status: "revoked" }], candidates: [] })));
    render(<CertificatesPage />);
    await screen.findByRole("link", { name: /Add to LinkedIn/ });
    expect(screen.getAllByRole("link", { name: /Add to LinkedIn/ })).toHaveLength(1);
  });
});
