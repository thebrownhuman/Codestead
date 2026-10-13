import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));
import { loadPublicCertificate } from "../service";

const token = "a".repeat(32);
const row = {
  id: "a3000000-0000-4000-8000-000000000001", verification_id: token,
  learner_display_name: "Issued Account Name", public_display_name: null as string | null,
  course_title: "Python foundations", course_version_label: "1.0.0", policy_version: "v1",
  issued_at: new Date("2026-07-14T00:00:00Z"), revoked_at: null as Date | null, revocation_reason: null,
};

describe("certificate public consent", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.query.mockResolvedValue({ rows: [{ ...row }] }); });
  it("hides the issued account name without a published portfolio selection", async () => {
    const result = await loadPublicCertificate(token);
    expect(result.learnerDisplayName).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Issued Account Name");
  });
  it("uses only the portfolio chosen display name for a linked certificate", async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...row, public_display_name: "Chosen Alias" }] });
    expect((await loadPublicCertificate(token)).learnerDisplayName).toBe("Chosen Alias");
    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain("public_portfolio_certificate");
    expect(sql).toContain("portfolio.is_published");
    expect(sql).toContain("selected.certificate_id=certificate.id");
    expect(sql).toContain("selected.user_id=certificate.user_id");
  });
  it.each(["unpublishing", "unlinking"])("hides the name immediately after %s", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...row, public_display_name: "Chosen Alias" }] })
      .mockResolvedValueOnce({ rows: [{ ...row, public_display_name: null }] });
    expect((await loadPublicCertificate(token)).learnerDisplayName).toBe("Chosen Alias");
    expect((await loadPublicCertificate(token)).learnerDisplayName).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it("keeps revoked status and date without exposing a name or private reason", async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...row, revoked_at: new Date("2026-08-01T00:00:00Z") }] });
    expect(await loadPublicCertificate(token)).toMatchObject({ status: "revoked", revokedAt: "2026-08-01T00:00:00.000Z", learnerDisplayName: null });
  });
  it("uses the same not-found error for unknown and malformed IDs", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(loadPublicCertificate(token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    mocks.query.mockClear();
    await expect(loadPublicCertificate("short")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
