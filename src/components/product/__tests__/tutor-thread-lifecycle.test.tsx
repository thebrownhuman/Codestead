import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TutorView } from "../tutor-view";

const ACTIVE = "10000000-0000-4000-8000-000000000001";
const ARCHIVED = "10000000-0000-4000-8000-000000000002";
const SECOND_ACTIVE = "10000000-0000-4000-8000-000000000003";
const UPDATED = "2026-07-12T10:00:00.000Z";
const contextManifest = {
  promptVersion: "buddy-tutor-v3",
  contextPolicyVersion: "tutor-context-v2",
  included: ["concept_mastery.current_skill", "chat_message.selected_thread_tail"],
  provenance: {
    "concept_mastery.current_skill": "latest owner/current-concept mastery row; absent row defaults to unseen and zero",
    "chat_message.selected_thread_tail": "last owner-active selected-thread user/assistant messages only",
  },
  caps: { evidenceRows: 40, selectedThreadMessages: 6, selectedThreadTotalChars: 4_800 },
  explicitlyExcluded: ["provider_credentials", "hidden_tests", "other_learners", "raw_unbounded_chat_history"],
};

const mentorRecommendation = {
  state: "ready",
  policyVersion: "personalized-mentor-v1",
  dailyChallenge: {
    skillId: "python.values.scalars",
    skillTitle: "Scalar values",
    reason: "confirmed_misconception",
    reasonText: "Verified work still shows the assignment equality misconception.",
    instruction: "Trace one small example, then solve one fresh practice item.",
    targetMinutes: 10,
    source: "stored_verified_evidence",
  },
  learningSignal: {
    pace: "steady",
    confidence: "developing",
    evidence: { verifiedMasteryRows: 2, verifiedRecentAttempts: 4, lookbackDays: 30 },
  },
  encouragement: "One focused, evidence-based rep is enough for today.",
  planSuggestion: {
    kind: "request_admin_plan_review",
    skillId: "python.values.scalars",
    reason: "Repeated verified struggle suggests that an administrator should review pacing.",
  },
  authority: {
    officialPlanChanged: false,
    officialPlanRevisionId: "plan-7",
    statement: "Codestead may adapt this daily challenge, but only an administrator can change the official roadmap.",
  },
  contextPolicy: {
    ownerBound: true,
    included: ["verified concept mastery", "recent deterministic attempts"],
    explicitlyExcluded: ["provider keys", "hidden tests", "other learners"],
    caps: { masteryRows: 40, recentAttempts: 20 },
  },
} as const;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const summaries = [
  {
    id: ACTIVE,
    title: "Python: Loop bounds",
    status: "active",
    messageCount: 2,
    provider: "nvidia_nim",
    model: "meta/test",
    credentialSource: "learner",
    createdAt: UPDATED,
    updatedAt: UPDATED,
  },
  {
    id: ARCHIVED,
    title: "Python: Archived strings",
    status: "archived",
    messageCount: 1,
    provider: "openrouter",
    model: "open/test",
    credentialSource: "admin_fallback",
    createdAt: UPDATED,
    updatedAt: UPDATED,
  },
] as const;

describe("TutorView server-owned thread lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads owned history, shows per-message provenance, and archives/reopens without browser storage", async () => {
    let status: "active" | "archived" = "active";
    let statusUpdatedAt = UPDATED;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: summaries, nextCursor: null });
      if (url === `/api/ai/threads/${ACTIVE}?limit=100`) {
        return response({
          thread: { id: ACTIVE, title: summaries[0].title, status, createdAt: UPDATED, updatedAt: statusUpdatedAt },
          messages: [
            { id: "20000000-0000-4000-8000-000000000001", role: "user", content: "Why does range stop early?", createdAt: UPDATED },
            {
              id: "20000000-0000-4000-8000-000000000002",
              role: "assistant",
              content: "The stop value is exclusive.",
              provider: "nvidia_nim",
              model: "meta/test",
              credentialSource: "learner",
              contextManifest,
              callId: null,
              createdAt: UPDATED,
            },
          ],
          nextCursor: null,
        });
      }
      if (url === `/api/ai/threads/${ARCHIVED}?limit=100`) {
        return response({
          thread: { id: ARCHIVED, title: summaries[1].title, status: "archived", createdAt: UPDATED, updatedAt: UPDATED },
          messages: [{
            id: "20000000-0000-4000-8000-000000000003",
            role: "assistant",
            content: "Archived answer",
            provider: "openrouter",
            model: "open/test",
            credentialSource: "admin_fallback",
            createdAt: UPDATED,
          }],
          nextCursor: null,
        });
      }
      if (url === `/api/ai/threads/${ACTIVE}` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { status: "active" | "archived" };
        status = body.status;
        statusUpdatedAt = status === "archived" ? "2026-07-12T10:01:00.000Z" : "2026-07-12T10:02:00.000Z";
        return response({ thread: { status, updatedAt: statusUpdatedAt, replayed: false } });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<TutorView />);

    await user.click(await screen.findByRole("button", { name: /Python: Loop bounds/ }));
    const answer = await screen.findByText("The stop value is exclusive.");
    expect(within(answer.closest("div")!).getByText("Nvidia Nim · meta/test · your key")).toBeInTheDocument();
    expect(screen.getByText("Selected conversation's bounded tail")).toBeInTheDocument();
    expect(screen.getByText("last owner-active selected-thread user/assistant messages only")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText(/This thread is archived/)).toBeInTheDocument();
    expect(screen.getByLabelText("Message Codestead")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).not.toBeDisabled());

    await user.click(screen.getByRole("button", { name: /Python: Archived strings/ }));
    const archivedAnswer = await screen.findByText("Archived answer");
    expect(within(archivedAnswer.closest("div")!).getByText("Openrouter · open/test · admin-funded fallback")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Codestead")).toBeDisabled();
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it("continues a newly persisted thread and displays the provider source on every new assistant message", async () => {
    let tutorCalls = 0;
    const requestIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: [], nextCursor: null });
      if (url === "/api/ai/tutor") {
        tutorCalls += 1;
        const body = JSON.parse(String(init?.body)) as { threadId?: string; requestId: string };
        requestIds.push(body.requestId);
        if (tutorCalls === 1) expect(body.threadId).toBeUndefined();
        else expect(body.threadId).toBe(ACTIVE);
        return response({
          content: tutorCalls === 1 ? "First answer" : "Second answer",
          provider: "openrouter",
          model: "open/test",
          source: "admin_fallback",
          callId: `30000000-0000-4000-8000-00000000000${tutorCalls}`,
          threadId: ACTIVE,
          thread: { id: ACTIVE, title: "Python: Scalar values", status: "active", updatedAt: `2026-07-12T10:0${tutorCalls}:00.000Z` },
          contextManifest,
          mentorRecommendation,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TutorView />);

    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toBeEnabled());
    await user.type(screen.getByLabelText("Message Codestead"), "First question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const firstAnswer = await screen.findByText("First answer");
    const mentor = screen.getByRole("region", { name: "Personalized daily mentor challenge" });
    expect(mentor).toHaveTextContent(/evidence-based challenge/i);
    expect(mentor).toHaveTextContent("Scalar values");
    expect(mentor).toHaveTextContent(/steady/i);
    expect(mentor).toHaveTextContent(/developing/i);
    expect(mentor).toHaveTextContent(/no roadmap change was made/i);
    await user.click(within(mentor).getByText("Why this recommendation is bounded"));
    expect(mentor).toHaveTextContent(/provider keys.*hidden tests.*other learners/i);
    expect(within(firstAnswer.closest("div")!).getByText("Openrouter · open/test · admin-funded fallback")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message Codestead"), "Second question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const secondAnswer = await screen.findByText("Second answer");
    expect(within(secondAnswer.closest("div")!).getByText("Openrouter · open/test · admin-funded fallback")).toBeInTheDocument();
    expect(tutorCalls).toBe(2);
    expect(requestIds.every((requestId) => /^[0-9a-f-]{36}$/i.test(requestId))).toBe(true);
    expect(new Set(requestIds)).toHaveProperty("size", 2);
  });

  it("reuses one tutor UUID when an indeterminate transport failure is retried", async () => {
    const tutorBodies: Array<{ requestId: string; message: string }> = [];
    let tutorAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: [], nextCursor: null });
      if (url === "/api/ai/tutor") {
        tutorAttempts += 1;
        tutorBodies.push(JSON.parse(String(init?.body)) as { requestId: string; message: string });
        if (tutorAttempts === 1) throw new TypeError("synthetic lost response");
        return response({
          content: "Recovered original answer",
          provider: "nvidia_nim",
          model: "meta/test",
          source: "learner",
          callId: "30000000-0000-4000-8000-000000000010",
          threadId: ACTIVE,
          thread: { id: ACTIVE, title: "Python: Scalar values", status: "active", updatedAt: UPDATED },
          contextManifest,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TutorView />);
    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toBeEnabled());
    await user.type(screen.getByLabelText("Message Codestead"), "Retry this once");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Recovered original answer")).toBeInTheDocument();
    expect(tutorBodies).toHaveLength(2);
    expect(tutorBodies[0]).toEqual(tutorBodies[1]);
    expect(tutorBodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("honors a server-side archive race and removes the unpersisted optimistic message", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: summaries.slice(0, 1), nextCursor: null });
      if (url === `/api/ai/threads/${ACTIVE}?limit=100`) {
        return response({
          thread: { id: ACTIVE, title: summaries[0].title, status: "active", createdAt: UPDATED, updatedAt: UPDATED },
          messages: [],
          nextCursor: null,
        });
      }
      if (url === "/api/ai/tutor") {
        return response({ error: "This tutor thread was archived in another tab.", code: "THREAD_ARCHIVED" }, 409);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TutorView />);

    await user.click(await screen.findByRole("button", { name: /Python: Loop bounds/ }));
    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toBeEnabled());
    await user.type(screen.getByLabelText("Message Codestead"), "This must not be persisted");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("archived in another tab");
    expect(screen.queryByText("This must not be persisted", { selector: "span" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Codestead")).toBeDisabled();
  });

  it("replaces the optimistic message with the server-sanitized value and discloses redaction", async () => {
    const secret = ["nvapi", "-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: [], nextCursor: null });
      if (url === "/api/ai/tutor") return response({
        content: "Please keep credentials out of learning chat.",
        provider: "nvidia_nim",
        model: "meta/test",
        source: "learner",
        callId: "30000000-0000-4000-8000-000000000009",
        threadId: ACTIVE,
        thread: { id: ACTIVE, title: "Python: Scalar values", status: "active", updatedAt: UPDATED },
        acceptedMessage: "Can you inspect [REDACTED]",
        messageSanitized: true,
        contextManifest,
      });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TutorView />);
    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toBeEnabled());
    await user.type(screen.getByLabelText("Message Codestead"), `Can you inspect ${secret}`);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Can you inspect [REDACTED]")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(secret))).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("redacted before this message was sent or saved");
  });

  it("guards the composer during thread selection and ignores a superseded thread response", async () => {
    let resolveActive!: (value: Response) => void;
    let resolveArchived!: (value: Response) => void;
    const activeRead = new Promise<Response>((resolve) => { resolveActive = resolve; });
    const archivedRead = new Promise<Response>((resolve) => { resolveArchived = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: summaries, nextCursor: null });
      if (url === `/api/ai/threads/${ACTIVE}?limit=100`) return activeRead;
      if (url === `/api/ai/threads/${ARCHIVED}?limit=100`) return archivedRead;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TutorView />);

    await user.click(await screen.findByRole("button", { name: /Python: Loop bounds/ }));
    expect(screen.getByLabelText("Message Codestead")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start a new conversation" })).toBeDisabled();

    // A newer selection is allowed to supersede the slow read, but no message
    // can be sent until that newer selection becomes authoritative.
    await user.click(screen.getByRole("button", { name: /Python: Archived strings/ }));
    await act(async () => {
      resolveArchived(response({
        thread: { id: ARCHIVED, title: summaries[1].title, status: "archived", createdAt: UPDATED, updatedAt: UPDATED },
        messages: [{ id: "latest-message", role: "assistant", content: "Latest selected answer" }],
        nextCursor: null,
      }));
      await archivedRead;
    });
    expect(await screen.findByText("Latest selected answer")).toBeInTheDocument();

    await act(async () => {
      resolveActive(response({
        thread: { id: ACTIVE, title: summaries[0].title, status: "active", createdAt: UPDATED, updatedAt: UPDATED },
        messages: [{ id: "stale-message", role: "assistant", content: "Stale late answer" }],
        nextCursor: null,
      }));
      await activeRead;
    });
    expect(screen.queryByText("Stale late answer")).not.toBeInTheDocument();
    expect(screen.getByText("Latest selected answer")).toBeInTheDocument();
  });

  it("keeps an independent unsent composer draft for each thread and the new-conversation slot", async () => {
    const activeSummaries = [
      summaries[0],
      {
        ...summaries[0],
        id: SECOND_ACTIVE,
        title: "Python: Function arguments",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: activeSummaries, nextCursor: null });
      const thread = activeSummaries.find((candidate) => url === `/api/ai/threads/${candidate.id}?limit=100`);
      if (thread) return response({
        thread: { id: thread.id, title: thread.title, status: "active", createdAt: UPDATED, updatedAt: UPDATED },
        messages: [],
        nextCursor: null,
      });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TutorView />);

    const composer = screen.getByLabelText("Message Codestead");
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, "Unsent new-thread draft");
    await user.click(await screen.findByRole("button", { name: /Python: Loop bounds/ }));
    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toBeEnabled());
    expect(screen.getByLabelText("Message Codestead")).toHaveValue("");
    await user.type(screen.getByLabelText("Message Codestead"), "Draft for loop bounds");

    await user.click(screen.getByRole("button", { name: /Python: Function arguments/ }));
    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toBeEnabled());
    expect(screen.getByLabelText("Message Codestead")).toHaveValue("");
    await user.type(screen.getByLabelText("Message Codestead"), "Draft for function arguments");

    await user.click(screen.getByRole("button", { name: /Python: Loop bounds/ }));
    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toHaveValue("Draft for loop bounds"));
    await user.click(screen.getByRole("button", { name: "Start a new conversation" }));
    expect(screen.getByLabelText("Message Codestead")).toHaveValue("Unsent new-thread draft");
  });

  it("restores a failed message and reuses its request id for an explicit safe retry", async () => {
    const tutorBodies: Array<{ requestId: string; message: string }> = [];
    let tutorAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) return response({ threads: [], nextCursor: null });
      if (url === "/api/ai/tutor") {
        tutorAttempts += 1;
        tutorBodies.push(JSON.parse(String(init?.body)) as { requestId: string; message: string });
        if (tutorAttempts <= 2) throw new TypeError("synthetic provider transport loss");
        return response({
          content: "Recovered after explicit retry",
          provider: "nvidia_nim",
          model: "meta/test",
          source: "learner",
          callId: "30000000-0000-4000-8000-000000000099",
          threadId: ACTIVE,
          thread: { id: ACTIVE, title: "Python: Scalar values", status: "active", updatedAt: UPDATED },
          contextManifest,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TutorView />);

    await waitFor(() => expect(screen.getByLabelText("Message Codestead")).toBeEnabled());
    await user.type(screen.getByLabelText("Message Codestead"), "Please preserve this exact question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("message was restored");
    expect(screen.getByLabelText("Message Codestead")).toHaveValue("Please preserve this exact question");
    expect(screen.queryByText("Please preserve this exact question", { selector: "span" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Recovered after explicit retry")).toBeInTheDocument();
    expect(tutorBodies).toHaveLength(3);
    expect(new Set(tutorBodies.map((body) => body.requestId))).toHaveProperty("size", 1);
    expect(tutorBodies.every((body) => body.message === "Please preserve this exact question")).toBe(true);
  });
});
