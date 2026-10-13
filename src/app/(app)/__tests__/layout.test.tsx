import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), authRequired: vi.fn(), createRepository: vi.fn(), listCourses: vi.fn(),
  currentConsents: vi.fn(), needsRenewal: vi.fn(),
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/runtime-policy", () => ({ isApplicationAuthRequired: mocks.authRequired }));
vi.mock("@/lib/content", () => ({ createContentRepository: mocks.createRepository }));
vi.mock("@/lib/privacy/consent", () => ({ getCurrentConsents: mocks.currentConsents, needsDisclosureRenewal: mocks.needsRenewal }));
vi.mock("@/components/shell/app-shell", () => ({ AppShell: () => null }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
import LearnerLayout from "../layout";

const active = {
  session: { user: { id: "learner", name: "Learner" }, session: { id: "session" } },
  account: { status: "active", role: "learner" },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authRequired.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue(active);
  mocks.currentConsents.mockResolvedValue(new Map());
  mocks.needsRenewal.mockReturnValue(false);
  mocks.createRepository.mockReturnValue({ listCourses: mocks.listCourses });
  mocks.listCourses.mockResolvedValue([{ id: "python", title: "Python", modules: [{ skills: [{ id: "python.assignment", title: "Assignment" }] }] }]);
});

it("shows the renewal screen instead of a broken tutor page until acknowledgement", async () => {
  mocks.needsRenewal.mockReturnValue(true);
  const layout = await LearnerLayout({ children: "Tutor chat" });
  expect(layout.props.children.type.name).toBe("DisclosureRenewal");
  mocks.needsRenewal.mockReturnValue(false);
  expect((await LearnerLayout({ children: "Tutor chat" })).props.children).toBe("Tutor chat");
});

it.each([
  [{ session: null, response: new Response(JSON.stringify({}), { status: 401 }) }, "/login"],
  [{ session: null, response: new Response(JSON.stringify({ code: "MFA_CHALLENGE_REQUIRED" }), { status: 403 }) }, "/two-factor"],
  [{ session: null, response: new Response(JSON.stringify({}), { status: 403 }) }, "/login?error=account-inactive"],
  [{ ...active, account: { ...active.account, status: "pending" } }, "/onboarding"],
])("redirects before constructing the content repository (%s)", async (authz, destination) => {
  mocks.requireAuth.mockResolvedValue(authz);
  await expect(LearnerLayout({ children: null })).rejects.toThrow(`redirect:${destination}`);
  expect(mocks.createRepository).not.toHaveBeenCalled();
  expect(mocks.listCourses).not.toHaveBeenCalled();
});

it("waits for successful authorization before loading catalog metadata", async () => {
  let resolveAuth!: (value: typeof active) => void;
  mocks.requireAuth.mockReturnValue(new Promise((resolve) => { resolveAuth = resolve; }));
  const pending = LearnerLayout({ children: null });
  expect(mocks.requireAuth).toHaveBeenCalledWith({ allowPending: true });
  expect(mocks.createRepository).not.toHaveBeenCalled();
  resolveAuth(active);
  const layout = await pending;
  expect(layout.props.catalog).toHaveLength(2);
  expect(layout.props.catalog[1].href).toBe("/courses/python/skills/python.assignment");
});

it("still supplies the catalog in demo mode without calling authentication", async () => {
  mocks.authRequired.mockReturnValue(false);
  const layout = await LearnerLayout({ children: null });
  expect(mocks.requireAuth).not.toHaveBeenCalled();
  expect(layout.props.catalog).toHaveLength(2);
});
