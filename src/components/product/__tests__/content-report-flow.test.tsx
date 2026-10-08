import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import RequestsPage from "@/app/(app)/requests/page";
import { PracticePanel } from "@/components/lesson/practice-panel";

const content = vi.hoisted(() => ({ getSkillLocation: vi.fn() }));
vi.mock("@/lib/content", () => ({ createContentRepository: () => content }));
const location = {
  course: { id: "python", title: "Python", status: "beta" },
  skill: { id: "python.variables.assignment", title: "Assignment" },
};
afterEach(() => vi.unstubAllGlobals());
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }

it.each(["practice", "checkpoint"] as const)("follows the unavailable %s report link through prefill and submission", async (purpose) => {
  content.getSkillLocation.mockResolvedValue(location);
  const fetchMock = vi.fn(async (url, init) => {
    if (url === "/api/practice/attempts") return json({ state: "degraded", attempt: null, activity: null, reason: "activity_unavailable", idempotent: false });
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      return json({ request: { ...body, id: body.requestId, status: "pending", decisionReason: null, createdAt: "2026-10-04T00:00:00Z", decidedAt: null } });
    }
    return json({ requests: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  const panel = render(<PracticePanel skillId={location.skill.id} purpose={purpose} />);
  await user.click(screen.getByRole("button", { name: purpose === "practice" ? "Start practice" : "Start checkpoint" }));
  const link = await screen.findByRole("link", { name: "Report a content problem" });
  const url = new URL(link.getAttribute("href")!, "https://codestead.test");
  expect(url.searchParams.get("kind")).toBe("content-defect");
  panel.unmount();
  render(await RequestsPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
  expect(screen.getByLabelText("Request type")).toHaveAttribute("data-value", "content-defect");
  expect(screen.getByLabelText("Subject or topic")).toHaveValue("Python: Assignment");
  await screen.findByText("No requests yet");
  await user.type(screen.getByLabelText("What should the course cover?"), "There is no reviewed activity.");
  await user.click(screen.getByRole("button", { name: "Send for review" }));
  expect(await screen.findByText(/Request sent to the administrator/)).toBeInTheDocument();
  const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/learning-requests" && init?.method === "POST");
  const body = JSON.parse(post![1]!.body);
  expect(body.kind).toBe("content-defect");
  expect(body.details).toContain(`Skill: Assignment (${location.skill.id})`);
  expect(body.details).toContain("Course: Python (python)");
});

it.each([
  { kind: "unknown", skillId: location.skill.id },
  { kind: ["content-defect", "new-subject"], skillId: location.skill.id },
  { kind: "content-defect", skillId: [location.skill.id, "other"] },
  { kind: "content-defect", skillId: "unknown" },
])("ignores invalid or ambiguous report context %j", async (query) => {
  content.getSkillLocation.mockResolvedValue(undefined);
  const page = await RequestsPage({ searchParams: Promise.resolve(query) });
  expect(page.props.prefill?.context).toBeUndefined();
  expect(page.props.prefill?.subject ?? "").toBe("");
});
