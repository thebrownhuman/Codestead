import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  withRateLimit: vi.fn(),
  audit: vi.fn(),
  createGroup: vi.fn(),
  addMember: vi.fn(),
  createPost: vi.fn(),
  createReply: vi.fn(),
  edit: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  report: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/community/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/community/service")>();
  return {
    ...actual,
    addCommunityGroupMember: mocks.addMember,
    createCommunityGroup: mocks.createGroup,
    createCommunityPost: mocks.createPost,
    createCommunityReply: mocks.createReply,
    deleteCommunityContent: mocks.remove,
    editCommunityContent: mocks.edit,
    listCommunity: mocks.list,
    reportCommunityContent: mocks.report,
  };
});

import { POST } from "../route";

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/community/discussions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const postBody = {
  action: "create_post",
  requestId: "91000000-0000-4000-8000-000000000001",
  groupId: "91000000-0000-4000-8000-000000000002",
  kind: "discussion",
  title: "Explain one useful loop pattern",
  body: "Here is a safe, bounded discussion prompt.",
} as const;

describe("community discussion route audit truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } }, response: null });
    mocks.withRateLimit.mockImplementation(async (_check, handler: () => Promise<Response>) => handler());
    mocks.createPost.mockResolvedValue({ id: "post-1", replayed: false });
    mocks.audit.mockResolvedValue(undefined);
  });

  it("returns the authentication response before mutation", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await POST(request(postBody))).status).toBe(401);
    expect(mocks.createPost).not.toHaveBeenCalled();
  });

  it("returns committed success with an explicit warning when the completion audit fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request(postBody));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      result: { id: "post-1" },
      completionAuditRecorded: false,
      warning: expect.stringContaining("Do not repeat"),
    });
    expect(mocks.createPost).toHaveBeenCalledTimes(1);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "community_write_user", identity: { kind: "user", value: "learner-1" } },
      expect.any(Function),
    );
  });
});
