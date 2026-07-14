import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommunitySpaces } from "../community-spaces";

const groupId = "cc000000-0000-4000-8000-000000000001";
const postId = "cc000000-0000-4000-8000-000000000002";
const battleId = "cc000000-0000-4000-8000-000000000003";
const reportId = "cc000000-0000-4000-8000-000000000006";

const discussion = {
  groups: [{
    id: groupId,
    name: "Python pod",
    description: "A private, focused study group.",
    visibility: "members",
    status: "active",
    membershipRole: "owner",
    memberCount: 2,
  }],
  posts: [{
    id: postId,
    groupId,
    kind: "help",
    title: "Why does assignment point left?",
    body: "<script>this is rendered as plain text</script>",
    rowVersion: 1,
    createdAt: "2026-07-14T12:00:00.000Z",
    editedAt: null,
    authorAlias: "learner-alpha",
    own: false,
    replies: [],
  }],
  nextCursor: null,
  moderation: false,
  privacy: "Plain text and consent-safe aliases only.",
};

const battle = {
  id: battleId,
  scope: "invite",
  competitionKey: null,
  title: "Variable assignment challenge",
  language: "Python",
  skillKey: "python.variables",
  challengeKind: "authored_answer",
  maxPoints: 100,
  status: "open",
  startsAt: "2026-07-14T12:00:00.000Z",
  endsAt: "2026-07-14T13:00:00.000Z",
  revealAt: "2026-07-14T13:00:00.000Z",
  participantCount: 2,
  submissionCount: 0,
  participant: true,
  submitted: false,
  canJoin: false,
  prompt: {
    instructions: "Which line stores 7 in score?",
    specification: {
      options: [{ id: "a", text: "score = 7" }, { id: "b", text: "7 = score" }],
      multiple: false,
    },
  },
  limitations: "Asynchronous reviewed challenge; no AI answers.",
};

const battles = {
  battles: [battle],
  sources: [{ activityId: "cc000000-0000-4000-8000-000000000004", skillKey: "python.variables", title: "Variable assignment", language: "Python", kind: "quiz-mcq" }],
  scoring: {
    version: "battle-score-v1",
    rule: "Equal scores share rank and speed gives no points.",
    reveal: "Scores stay sealed until server reveal.",
  },
};

function installMatchMedia(phone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: phone,
      media: "(max-width: 767px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/community/discussions")) {
      return new Response(JSON.stringify(discussion), { status: 200 });
    }
    if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
    if (url === `/api/battles/${battleId}`) {
      return new Response(JSON.stringify({ battle, resultsRevealed: false, results: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected test request" }), { status: 500 });
  }));
}

describe("community spaces UI boundaries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installMatchMedia(false);
    installFetch();
  });

  it("renders discussion text safely and keeps battle results sealed before reveal", async () => {
    const user = userEvent.setup();
    const { container } = render(<CommunitySpaces people={[{
      publicId: "cc000000-0000-4000-8000-000000000005",
      alias: "learner-beta",
    }]} />);

    expect(await screen.findByRole("heading", { name: "Community spaces & coding battles" })).toBeInTheDocument();
    expect(screen.getByText("<script>this is rendered as plain text</script>")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("learner-alpha", { exact: false })).toBeInTheDocument();

    const discussionTab = screen.getByRole("tab", { name: "Discuss & help" });
    const battleTab = screen.getByRole("tab", { name: "Battles" });
    expect(discussionTab).toHaveAttribute("aria-controls", "community-panel-discuss");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "community-tab-discuss");
    discussionTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(battleTab).toHaveFocus();
    expect(battleTab).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "community-tab-battle");
    await user.keyboard("{Home}");
    expect(discussionTab).toHaveFocus();
    await user.click(battleTab);
    expect(screen.getByText("Equal scores share rank and speed gives no points.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View challenge" }));
    expect(await screen.findByText("Results are sealed")).toBeInTheDocument();
    const answerGroup = screen.getByRole("group", { name: "Your answer" });
    expect(within(answerGroup).getByRole("radio", { name: "score = 7" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit once" })).toBeEnabled();
    expect(screen.queryByText(/correctOptionIds|grading|solution/i)).not.toBeInTheDocument();
  });

  it("makes battles read-only on phone while discussions remain available", async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByRole("tab", { name: "Battles" }));
    expect(await screen.findByText("Read-only on phone")).toBeInTheDocument();
    expect(screen.queryByText("Create a battle")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View challenge" }));
    await waitFor(() => expect(screen.getByText("Results are sealed")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Submit once" })).not.toBeInTheDocument();
  });

  it("keeps a scheduled battle prompt sealed until its server start time", async () => {
    const user = userEvent.setup();
    const scheduledBattle = {
      ...battle,
      status: "scheduled",
      startsAt: "2026-07-15T12:00:00.000Z",
      prompt: null,
    };
    const scheduledBattles = { ...battles, battles: [scheduledBattle] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/community/discussions")) {
        return new Response(JSON.stringify(discussion), { status: 200 });
      }
      if (url === "/api/battles") return new Response(JSON.stringify(scheduledBattles), { status: 200 });
      if (url === `/api/battles/${battleId}`) {
        return new Response(JSON.stringify({ battle: scheduledBattle, resultsRevealed: false, results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected test request" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByRole("tab", { name: "Battles" }));
    expect(screen.getByText(/Challenge details unlock/)).toBeInTheDocument();
    expect(screen.queryByText("Which line stores 7 in score?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View challenge" }));
    expect(await screen.findByText("Results are sealed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit once" })).not.toBeInTheDocument();
  });

  it("offers a real retry after the initial read fails", async () => {
    const user = userEvent.setup();
    let failed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!failed) {
        failed = true;
        return new Response(JSON.stringify({ error: "Temporary read failure" }), { status: 503 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    expect(await screen.findByRole("heading", { name: "Community spaces are unavailable" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Community spaces & coding battles" })).toBeInTheDocument();
  });

  it("reuses one logical create request after a lost response", async () => {
    const user = userEvent.setup();
    const postBodies: Array<Record<string, unknown>> = [];
    let lost = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/discussions" && init?.method === "POST") {
        postBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (lost) {
          lost = false;
          throw new TypeError("synthetic lost response");
        }
        return new Response(JSON.stringify({ result: { id: postId } }), { status: 201 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByText("Start a conversation"));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Retry-safe post");
    await user.type(screen.getByRole("textbox", { name: "What do you want the group to know?" }), "This post keeps one logical request identifier.");
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("synthetic lost response");
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Post added");
    expect(postBodies).toHaveLength(2);
    expect(postBodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(postBodies[1]?.requestId).toBe(postBodies[0]?.requestId);
  });

  it("reuses one logical moderation request after a lost response", async () => {
    const user = userEvent.setup();
    const moderationBodies: Array<Record<string, unknown>> = [];
    const adminDiscussion = { ...discussion, moderation: true };
    const report = {
      id: reportId,
      target: "post",
      targetId: postId,
      reason: "privacy",
      details: null,
      status: "open",
      excerpt: "Please review this private detail.",
      createdAt: "2026-07-14T12:05:00.000Z",
    };
    let lost = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/community/moderation" && init?.method === "POST") {
        moderationBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (lost) {
          lost = false;
          throw new TypeError("synthetic lost moderation response");
        }
        return new Response(JSON.stringify({ result: { replayed: true } }), { status: 200 });
      }
      if (url === "/api/admin/community/moderation") {
        return new Response(JSON.stringify({ reports: [report] }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) {
        return new Response(JSON.stringify(adminDiscussion), { status: 200 });
      }
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected test request" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    expect(await screen.findByText("Moderation queue")).toBeInTheDocument();
    const hide = await screen.findByRole("button", { name: "Hide content" });
    await user.click(hide);
    expect(await screen.findByRole("alert")).toHaveTextContent("synthetic lost moderation response");
    await user.click(hide);
    expect(await screen.findByRole("status")).toHaveTextContent("Content hidden and report resolved");
    expect(moderationBodies).toHaveLength(2);
    expect(moderationBodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(moderationBodies[1]?.requestId).toBe(moderationBodies[0]?.requestId);
  });

  it("keeps a confirmed mutation successful when only the refresh fails", async () => {
    const user = userEvent.setup();
    let initialReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/discussions" && init?.method === "POST") {
        return new Response(JSON.stringify({ result: { id: postId } }), { status: 201 });
      }
      if (url.startsWith("/api/community/discussions")) {
        initialReads += 1;
        return initialReads === 1
          ? new Response(JSON.stringify(discussion), { status: 200 })
          : new Response(JSON.stringify({ error: "refresh unavailable" }), { status: 503 });
      }
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByText("Start a conversation"));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.type(title, "Saved before refresh");
    await user.type(screen.getByRole("textbox", { name: "What do you want the group to know?" }), "The mutation result and refresh result stay separate.");
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Post added");
    expect(screen.getByRole("alert")).toHaveTextContent("change was saved");
    expect(title).toHaveValue("");
  });
});
