import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/certificates/service", async (original) => ({
  ...await original<typeof import("@/lib/certificates/service")>(), loadPublicCertificate: mocks.load,
}));
vi.mock("@/lib/db/client", () => ({ pool: {} }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("GENERIC_NOT_FOUND"); } }));
import Page, * as page from "../page";
import { CertificateError } from "@/lib/certificates/service";

const certificate = { verificationId: "a".repeat(32), learnerDisplayName: "Chosen Alias", courseTitle: "Python", courseVersion: "1", issuedAt: "2026-07-14T00:00:00Z", status: "valid", revokedAt: null, statement: "Verified" };
const props = { params: Promise.resolve({ verificationId: certificate.verificationId }) };
describe("public verification page", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.load.mockResolvedValue(certificate); });
  it("renders a valid consented certificate", async () => {
    render(await Page(props));
    expect(screen.getByText("Chosen Alias")).toBeInTheDocument();
    expect(screen.getByText("Python")).toBeInTheDocument();
    expect(screen.getByText(certificate.verificationId, { exact: false })).toBeInTheDocument();
  });
  it("renders a generic valid statement without a hidden name", async () => {
    mocks.load.mockResolvedValue({ ...certificate, learnerDisplayName: null });
    render(await Page(props));
    expect(screen.getByText("This certificate exists and is valid")).toBeInTheDocument();
    expect(screen.queryByText("This certifies that")).not.toBeInTheDocument();
  });
  it("renders revoked status and date without a name", async () => {
    mocks.load.mockResolvedValue({ ...certificate, learnerDisplayName: null, status: "revoked", revokedAt: "2026-08-01T00:00:00Z" });
    render(await Page(props));
    expect(screen.getByText("This certificate has been revoked")).toBeInTheDocument();
    expect(screen.getByText(/Revoked .*2026/)).toBeInTheDocument();
  });
  it("uses generic not-found for unknown IDs", async () => {
    mocks.load.mockRejectedValue(new CertificateError("NOT_FOUND"));
    await expect(Page(props)).rejects.toThrow("GENERIC_NOT_FOUND");
  });
  it("provides OG title and description without learner names", async () => {
    // Namespace lookup makes the missing function an explicit red assertion.
    expect(page).toHaveProperty("generateMetadata");
    const generate = (page as unknown as { generateMetadata: (input: typeof props) => Promise<{ openGraph: { title: string; description: string } }> }).generateMetadata;
    const metadata = await generate(props);
    expect(metadata.openGraph.title).toContain("Certificate");
    expect(metadata.openGraph.description).toBeTruthy();
    expect(JSON.stringify(metadata)).not.toContain("Chosen Alias");
  });
});
