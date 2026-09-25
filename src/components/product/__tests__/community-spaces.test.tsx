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

  it("edits and deletes an owned post, and replies to a post", async () => {
    const user = userEvent.setup();
    const ownedDiscussion = { ...discussion, posts: [{ ...discussion.posts[0]!, own: true }] };
    const mutationBodies: Array<Record<string, unknown>> = [];
    let readCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/discussions" && init?.method === "POST") {
        mutationBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) {
        readCount += 1;
        return new Response(JSON.stringify(ownedDiscussion), { status: 200 });
      }
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });

    await user.click(screen.getByRole("button", { name: /Edit/i }));
    const editTitleField = screen.getByDisplayValue("Why does assignment point left?");
    await user.clear(editTitleField);
    await user.type(editTitleField, "Updated title");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(mutationBodies).toHaveLength(1));
    expect(mutationBodies[0]).toMatchObject({ action: "edit", target: "post" });

    await user.click(screen.getByRole("button", { name: /Reply/i }));
    await user.type(screen.getByLabelText("Your reply"), "Thanks, that clears it up.");
    await user.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(mutationBodies).toHaveLength(2));
    expect(mutationBodies[1]).toMatchObject({ action: "reply", postId });

    await user.click(screen.getByRole("button", { name: /Delete/i }));
    await waitFor(() => expect(mutationBodies).toHaveLength(3));
    expect(mutationBodies[2]).toMatchObject({ action: "delete", target: "post", targetId: postId });
    expect(readCount).toBeGreaterThan(1);
  });

  it("edits and deletes an owned reply", async () => {
    const user = userEvent.setup();
    const replyId = "cc000000-0000-4000-8000-000000000007";
    const withReply = {
      ...discussion,
      posts: [{
        ...discussion.posts[0]!,
        replies: [{
          id: replyId, body: "Original reply text.", rowVersion: 1,
          createdAt: "2026-07-14T12:01:00.000Z", editedAt: null, authorAlias: "you", own: true,
        }],
      }],
    };
    const mutationBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/discussions" && init?.method === "POST") {
        mutationBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(withReply), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByText("Original reply text.");

    await user.click(screen.getByRole("button", { name: /Edit/i, hidden: true }));
    const replyEditField = screen.getByDisplayValue("Original reply text.");
    await user.clear(replyEditField);
    await user.type(replyEditField, "Updated reply.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutationBodies).toHaveLength(1));
    expect(mutationBodies[0]).toMatchObject({ action: "edit", target: "reply", targetId: replyId });

    const deleteButtons = screen.getAllByRole("button", { name: /Delete/i });
    await user.click(deleteButtons[deleteButtons.length - 1]!);
    await waitFor(() => expect(mutationBodies).toHaveLength(2));
    expect(mutationBodies[1]).toMatchObject({ action: "delete", target: "reply", targetId: replyId });
  });

  it("sends a post report without notifying the author", async () => {
    const user = userEvent.setup();
    const reportBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/discussions" && init?.method === "POST") {
        reportBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByText("Report"));
    await user.selectOptions(screen.getByLabelText("Reason"), "harassment");
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText(/Report sent privately/)).toBeInTheDocument();
    expect(reportBodies[0]).toMatchObject({ action: "report", target: "post", targetId: postId, reason: "harassment" });
  });

  it("surfaces a report failure inline", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/discussions" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Report queue is full." }), { status: 503 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByText("Report"));
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Report queue is full.");
  });

  it("adds a member to a private group the learner owns", async () => {
    const user = userEvent.setup();
    const memberBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/community/discussions" && init?.method === "POST") {
        memberBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[{ publicId: "cc000000-0000-4000-8000-000000000005", alias: "learner-beta" }]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByText("Add a learner"));
    await user.selectOptions(screen.getByLabelText("Learner"), "cc000000-0000-4000-8000-000000000005");
    await user.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() => expect(memberBodies).toHaveLength(1));
    expect(memberBodies[0]).toMatchObject({
      action: "add_member",
      groupId,
      learnerPublicId: "cc000000-0000-4000-8000-000000000005",
    });
  });

  it("creates a battle and joins an open one", async () => {
    const user = userEvent.setup();
    const battleBodies: Array<Record<string, unknown>> = [];
    const joinableBattle = { ...battle, canJoin: true, participant: false };
    const joinableBattles = { ...battles, battles: [joinableBattle] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/battles" && init?.method === "POST") {
        battleBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { id: battleId } }), { status: 201 });
      }
      if (url === `/api/battles/${battleId}` && init?.method === "POST") {
        battleBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(joinableBattles), { status: 200 });
      if (url === `/api/battles/${battleId}`) {
        return new Response(JSON.stringify({ battle: joinableBattle, resultsRevealed: false, results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByRole("tab", { name: "Battles" }));

    await user.click(screen.getByText("Create a battle"));
    await user.selectOptions(screen.getByLabelText("Reviewed challenge"), "cc000000-0000-4000-8000-000000000004");
    await user.click(screen.getByRole("button", { name: "Freeze reviewed challenge" }));
    await waitFor(() => expect(battleBodies).toHaveLength(1));
    expect(battleBodies[0]).toMatchObject({ scope: "invite" });

    await user.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(battleBodies).toHaveLength(2));
    expect(battleBodies[1]).toMatchObject({ action: "join" });
  });

  it("submits a single-select battle answer and shows revealed results with points", async () => {
    const user = userEvent.setup();
    const submitBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/battles/${battleId}` && init?.method === "POST") {
        submitBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      if (url === `/api/battles/${battleId}`) {
        return new Response(JSON.stringify({
          battle,
          resultsRevealed: true,
          results: [{ rank: 1, alias: "learner-beta", score: 100, passed: true }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByRole("tab", { name: "Battles" }));
    await user.click(screen.getByRole("button", { name: "View challenge" }));
    await screen.findByText("Revealed results");
    expect(screen.getByText(/#1 learner-beta/)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "score = 7" }));
    await user.click(screen.getByRole("button", { name: "Submit once" }));

    await waitFor(() => expect(submitBodies).toHaveLength(1));
    expect(submitBodies[0]).toMatchObject({ action: "submit", answer: { value: "a" } });
  });

  it("submits a verified-attempt battle answer by attempt id", async () => {
    const user = userEvent.setup();
    const verifiedBattle = { ...battle, challengeKind: "verified_attempt" as const };
    const verifiedBattles = { ...battles, battles: [verifiedBattle] };
    const submitBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/battles/${battleId}` && init?.method === "POST") {
        submitBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(discussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(verifiedBattles), { status: 200 });
      if (url === `/api/battles/${battleId}`) {
        return new Response(JSON.stringify({ battle: verifiedBattle, resultsRevealed: false, results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(screen.getByRole("tab", { name: "Battles" }));
    await user.click(screen.getByRole("button", { name: "View challenge" }));
    await screen.findByText("Results are sealed");
    await user.type(screen.getByLabelText("Independently graded attempt ID"), "11111111-1111-4111-8111-111111111111");
    await user.click(screen.getByRole("button", { name: "Submit once" }));

    await waitFor(() => expect(submitBodies).toHaveLength(1));
    expect(submitBodies[0]).toMatchObject({ action: "submit", attemptId: "11111111-1111-4111-8111-111111111111" });
  });

  it("restores hidden content and dismisses the report", async () => {
    const user = userEvent.setup();
    const adminDiscussion = { ...discussion, moderation: true };
    const report = {
      id: reportId, target: "post" as const, targetId: postId, reason: "spam",
      details: null, status: "open", excerpt: "Please review this content.", createdAt: "2026-07-14T12:05:00.000Z",
    };
    const moderationBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/community/moderation" && init?.method === "POST") {
        moderationBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      }
      if (url === "/api/admin/community/moderation") return new Response(JSON.stringify({ reports: [report] }), { status: 200 });
      if (url.startsWith("/api/community/discussions")) return new Response(JSON.stringify(adminDiscussion), { status: 200 });
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByText("Moderation queue");
    await user.click(screen.getByRole("button", { name: "Dismiss report" }));

    await waitFor(() => expect(moderationBodies).toHaveLength(1));
    expect(moderationBodies[0]).toMatchObject({ action: "restore", reportId });
    expect(await screen.findByText("Content restored and report dismissed.")).toBeInTheDocument();
  });

  it("appends older conversations fetched through the pagination cursor", async () => {
    const user = userEvent.setup();
    const olderPost = { ...discussion.posts[0]!, id: "cc000000-0000-4000-8000-000000000008", title: "Older question" };
    let sawCursorRequest = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/community/discussions")) {
        if (url.includes("cursor=cursor-1")) {
          sawCursorRequest = true;
          return new Response(JSON.stringify({ ...discussion, posts: [olderPost], nextCursor: null }), { status: 200 });
        }
        return new Response(JSON.stringify({ ...discussion, nextCursor: "cursor-1" }), { status: 200 });
      }
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });
    await user.click(await screen.findByRole("button", { name: "Load older conversations" }));

    await waitFor(() => expect(screen.getByText("Older question")).toBeInTheDocument());
    expect(screen.getByText("Why does assignment point left?")).toBeInTheDocument();
    expect(sawCursorRequest).toBe(true);
  });

  it("shows the empty-groups prompt when no group has been created yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/community/discussions")) {
        return new Response(JSON.stringify({ ...discussion, groups: [], posts: [] }), { status: 200 });
      }
      if (url === "/api/battles") return new Response(JSON.stringify(battles), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }));

    render(<CommunitySpaces people={[]} />);
    await screen.findByRole("heading", { name: "Community spaces & coding battles" });

    expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
  });
});
