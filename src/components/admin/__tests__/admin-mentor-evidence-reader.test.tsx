import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminMentorEvidenceReader } from "../admin-mentor-evidence-reader";

const LEARNER_ID = "21000000-0000-4000-8000-000000000001";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function codeEvidence(item: Record<string, unknown>) {
  return {
    evidence: {
      category: "code_submissions",
      items: [item],
      page: { limit: 5, hasMore: false, nextCursor: null },
      safeguards: {
        responseBytes: 220,
        responseByteLimit: 131_072,
        perItemByteLimit: 49_152,
        truncatedItemCount: 0,
        hiddenAssessmentEvidenceIncluded: false,
        credentialOrSessionEvidenceIncluded: false,
        deviceOrIpEvidenceIncluded: false,
      },
    },
    purpose: "safety_review",
    autoClearSeconds: 300,
  };
}

describe("audited mentor evidence reader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it("does not read sensitive evidence on mount and presents an accessible privacy warning", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/private learner-authored/i);
    expect(screen.getByLabelText("Mentor evidence authenticator code")).toHaveAttribute("type", "password");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Audited learner evidence results")).not.toBeInTheDocument();
  });

  it("performs fresh MFA before a POST-body-only read, renders bounded evidence, and clears it", async () => {
    const calls: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("crypto", { randomUUID: () => "22000000-0000-4000-8000-000000000001" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, init, body });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/learners/${LEARNER_ID}/mentor-evidence`) return json({
        evidence: {
          category: "chats",
          items: [{ id: "23000000-0000-4000-8000-000000000001", role: "user", content: "I am confused about loop bounds." }],
          page: { limit: 5, hasMore: false, nextCursor: null },
          safeguards: {
            responseBytes: 120,
            responseByteLimit: 131_072,
            perItemByteLimit: 49_152,
            truncatedItemCount: 0,
            hiddenAssessmentEvidenceIncluded: false,
            credentialOrSessionEvidenceIncluded: false,
            deviceOrIpEvidenceIncluded: false,
          },
        },
        purpose: "learning_support",
        autoClearSeconds: 300,
      });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    await user.type(screen.getByLabelText("Mentor evidence reason"), "Review the loop misconception before assigning focused remediation.");
    await user.type(screen.getByLabelText("Mentor evidence authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: /Read and audit evidence/i }));

    expect(await screen.findByLabelText("Audited learner evidence results")).toBeInTheDocument();
    expect(screen.getByText(/I am confused about loop bounds/i)).toBeInTheDocument();
    const mfaIndex = calls.findIndex((call) => call.url === "/api/security/fresh-mfa");
    const readIndex = calls.findIndex((call) => call.url.endsWith("/mentor-evidence"));
    expect(mfaIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(mfaIndex);
    expect(calls[readIndex]?.url).not.toContain("?");
    expect(calls[readIndex]?.init?.method).toBe("POST");
    expect(calls[readIndex]?.body).toEqual({
      requestId: "22000000-0000-4000-8000-000000000001",
      category: "chats",
      purpose: "learning_support",
      reason: "Review the loop misconception before assigning focused remediation.",
      limit: 5,
    });
    expect(screen.getByText(/Hidden tests, blueprints, reference answers/i)).toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(0);
    await user.click(screen.getByRole("button", { name: /Clear now/i }));
    expect(screen.queryByText(/I am confused about loop bounds/i)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/cleared/i);
  });

  it("validates reason and MFA locally without contacting the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    fireEvent.change(screen.getByLabelText("Mentor evidence reason"), { target: { value: "too short" } });
    fireEvent.click(screen.getByRole("button", { name: /Read and audit evidence/i }));
    expect(await screen.findByText(/reason of at least 20 characters/i)).toHaveAttribute("role", "alert");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("resolves an active quarantine on the first response and clears its retry identity", async () => {
    const runnerJobId = "27000000-0000-4000-8000-000000000001";
    let resolveCalls = 0;
    vi.stubGlobal("crypto", { randomUUID: () => "27000000-0000-4000-8000-000000000002" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/learners/${LEARNER_ID}/mentor-evidence`) return json(codeEvidence({
        id: "27000000-0000-4000-8000-000000000003",
        runnerJobId,
        runnerRequestId: "practice-first-success-key",
        remoteRunnerJobId: "remote-first-success-job",
        submissionType: "server_run",
        submissionStatus: "leased",
        runnerStatus: "leased",
        recoveryState: "quarantined",
      }));
      if (url === `/api/admin/runner-recovery/${runnerJobId}/resolve`) {
        resolveCalls += 1;
        return json({ resolution: {
          runnerJobId,
          status: "cancelled",
          officialEvidenceChanged: false,
          replayed: false,
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    await user.selectOptions(screen.getByLabelText("Mentor evidence category"), "code_submissions");
    await user.selectOptions(screen.getByLabelText("Mentoring purpose"), "safety_review");
    await user.type(screen.getByLabelText("Mentor evidence reason"), "Review the active quarantine before a first-attempt operator resolution.");
    await user.type(screen.getByLabelText("Mentor evidence authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: /Read and audit evidence/i }));
    await user.click(await screen.findByRole("button", { name: /Resolve quarantined practice run/i }));
    expect(screen.getByLabelText("Quarantined practice recovery resolution")).toHaveTextContent(/remote-first-success-job/i);
    await user.type(screen.getByLabelText("Practice recovery resolution reason"), "Restarted the dedicated runner VM and reconciled the known remote binding.");
    await user.type(screen.getByLabelText("Practice recovery authenticator code"), "654321");
    await user.click(screen.getByLabelText(/stopped and restarted the dedicated runner VM/i));
    await user.click(screen.getByLabelText(/confirmed the durable journal/i));
    await user.click(screen.getByRole("button", { name: /Resolve and audit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/safely closed, audited, and reported/i);
    expect(resolveCalls).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("retains evidence and retry identity when a 200 response names the wrong runner job", async () => {
    const runnerJobId = "28000000-0000-4000-8000-000000000001";
    vi.stubGlobal("crypto", { randomUUID: () => "28000000-0000-4000-8000-000000000002" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/learners/${LEARNER_ID}/mentor-evidence`) return json(codeEvidence({
        id: "28000000-0000-4000-8000-000000000003",
        runnerJobId,
        runnerRequestId: "practice-malformed-response-key",
        remoteRunnerJobId: null,
        submissionType: "server_compile",
        submissionStatus: "running",
        runnerStatus: "running",
        recoveryState: "quarantined",
      }));
      if (url === `/api/admin/runner-recovery/${runnerJobId}/resolve`) return json({ resolution: {
        runnerJobId: "28000000-0000-4000-8000-000000000099",
        status: "cancelled",
        officialEvidenceChanged: false,
        replayed: false,
      } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    await user.selectOptions(screen.getByLabelText("Mentor evidence category"), "code_submissions");
    await user.selectOptions(screen.getByLabelText("Mentoring purpose"), "safety_review");
    await user.type(screen.getByLabelText("Mentor evidence reason"), "Review malformed recovery response handling without losing retry identity.");
    await user.type(screen.getByLabelText("Mentor evidence authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: /Read and audit evidence/i }));
    await user.click(await screen.findByRole("button", { name: /Resolve quarantined practice run/i }));
    await user.type(screen.getByLabelText("Practice recovery resolution reason"), "Restarted the runner VM and reconciled the malformed-response fixture safely.");
    await user.type(screen.getByLabelText("Practice recovery authenticator code"), "654321");
    await user.click(screen.getByLabelText(/stopped and restarted the dedicated runner VM/i));
    await user.click(screen.getByLabelText(/confirmed the durable journal/i));
    await user.click(screen.getByRole("button", { name: /Resolve and audit/i }));

    expect(await screen.findByText(/response identity or terminal status was invalid/i)).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("Audited learner evidence results")).toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(1);
  });

  it("shows quarantined recovery metadata and requires fresh MFA plus both operator attestations before resolution", async () => {
    const runnerJobId = "24000000-0000-4000-8000-000000000001";
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let requestId = 0;
    let resolutionCalls = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () => `25000000-0000-4000-8000-${String(++requestId).padStart(12, "0")}`,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/learners/${LEARNER_ID}/mentor-evidence`) return json({
        evidence: {
          category: "code_submissions",
          items: [{
            id: "24000000-0000-4000-8000-000000000002",
            runnerJobId,
            runnerRequestId: "practice-idempotency-key-1",
            remoteRunnerJobId: null,
            submissionType: "server_run",
            submissionStatus: "leased",
            runnerStatus: "leased",
            recoveryState: "quarantined",
            recoveryAttemptCount: 1,
            recoveryLastErrorCode: "PRACTICE_DISPATCH_SNAPSHOT_INVALID",
          }],
          page: { limit: 5, hasMore: false, nextCursor: null },
          safeguards: {
            responseBytes: 240,
            responseByteLimit: 131_072,
            perItemByteLimit: 49_152,
            truncatedItemCount: 0,
            hiddenAssessmentEvidenceIncluded: false,
            credentialOrSessionEvidenceIncluded: false,
            deviceOrIpEvidenceIncluded: false,
          },
        },
        purpose: "safety_review",
        autoClearSeconds: 300,
      });
      if (url === `/api/admin/runner-recovery/${runnerJobId}/resolve`) {
        resolutionCalls += 1;
        if (resolutionCalls === 1) throw new Error("response lost after the server committed");
        return json({
          resolution: { runnerJobId, status: "cancelled", officialEvidenceChanged: false, replayed: true },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const user = userEvent.setup();
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    await user.selectOptions(screen.getByLabelText("Mentor evidence category"), "code_submissions");
    await user.selectOptions(screen.getByLabelText("Mentoring purpose"), "safety_review");
    await user.type(screen.getByLabelText("Mentor evidence reason"), "Investigate the quarantined practice runner state before operator recovery.");
    await user.type(screen.getByLabelText("Mentor evidence authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: /Read and audit evidence/i }));

    expect(await screen.findByText(/PRACTICE_DISPATCH_SNAPSHOT_INVALID/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Resolve quarantined practice run/i }));
    const recoveryForm = screen.getByLabelText("Quarantined practice recovery resolution");
    expect(recoveryForm).toHaveTextContent(/dedicated runner VM/i);
    expect(recoveryForm).toHaveTextContent(/practice-idempotency-key-1/i);
    expect(recoveryForm).toHaveTextContent(/trusted application host deliberately has no Docker socket/i);
    await user.type(screen.getByLabelText("Practice recovery resolution reason"), "Restarted the isolated runner and reconciled its durable journal entry.");
    await user.type(screen.getByLabelText("Practice recovery authenticator code"), "654321");
    await user.click(screen.getByLabelText(/I stopped and restarted the dedicated runner VM/i));
    await user.click(screen.getByLabelText(/I confirmed the durable journal/i));
    await user.click(screen.getByRole("button", { name: /Resolve and audit/i }));

    expect(await screen.findByText(/response lost after the server committed/i)).toHaveAttribute("role", "alert");
    expect(screen.getByText(/prior network attempt exists/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Practice recovery resolution reason")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Clear now/i }));
    expect(screen.queryByLabelText("Quarantined practice recovery resolution")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Mentor evidence authenticator code"), "112233");
    await user.click(screen.getByRole("button", { name: /Read and audit evidence/i }));
    await user.click(await screen.findByRole("button", { name: /Resolve quarantined practice run/i }));
    expect(screen.getByText(/prior network attempt exists/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Practice recovery authenticator code"), "445566");
    await user.click(screen.getByRole("button", { name: /Resolve and audit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/safely closed, audited, and reported/i);
    expect(screen.queryByText(/PRACTICE_DISPATCH_SNAPSHOT_INVALID/i)).not.toBeInTheDocument();
    const resolveCalls = calls.filter((call) => call.url.endsWith(`/runner-recovery/${runnerJobId}/resolve`));
    expect(resolveCalls).toHaveLength(2);
    expect(resolveCalls[0]?.body).toMatchObject({
      reason: "Restarted the isolated runner and reconciled its durable journal entry.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    });
    expect(resolveCalls[1]?.body?.requestId).toBe(resolveCalls[0]?.body?.requestId);
    const resolveIndex = calls.findIndex((call) => call === resolveCalls[1]);
    expect(calls[resolveIndex - 1]?.url).toBe("/api/security/fresh-mfa");
  });

  it("explains item truncation and reaches the smaller record on the next audited page", async () => {
    let evidencePage = 0;
    let requestId = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () => `22000000-0000-4000-8000-${String(++requestId).padStart(12, "0")}`,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/learners/${LEARNER_ID}/mentor-evidence`) {
        evidencePage += 1;
        return evidencePage === 1
          ? json({
              evidence: {
                category: "exams",
                items: [{
                  id: "23000000-0000-4000-8000-000000000010",
                  attemptId: "large-attempt",
                  mentorPayloadTruncated: true,
                  mentorOriginalPayloadBytes: 420_000,
                  mentorPayloadByteLimit: 49_152,
                }],
                page: { limit: 5, hasMore: true, nextCursor: "safe-next-cursor" },
                safeguards: {
                  responseBytes: 220,
                  responseByteLimit: 131_072,
                  perItemByteLimit: 49_152,
                  truncatedItemCount: 1,
                  hiddenAssessmentEvidenceIncluded: false,
                  credentialOrSessionEvidenceIncluded: false,
                  deviceOrIpEvidenceIncluded: false,
                },
              },
              purpose: "learning_support",
              autoClearSeconds: 300,
            })
          : json({
              evidence: {
                category: "exams",
                items: [{
                  id: "23000000-0000-4000-8000-000000000011",
                  attemptId: "small-older-attempt",
                  result: { outcome: "PASSED", officialScorePercent: 88 },
                }],
                page: { limit: 5, hasMore: false, nextCursor: null },
                safeguards: {
                  responseBytes: 150,
                  responseByteLimit: 131_072,
                  perItemByteLimit: 49_152,
                  truncatedItemCount: 0,
                  hiddenAssessmentEvidenceIncluded: false,
                  credentialOrSessionEvidenceIncluded: false,
                  deviceOrIpEvidenceIncluded: false,
                },
              },
              purpose: "learning_support",
              autoClearSeconds: 300,
            });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const user = userEvent.setup();
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    await user.selectOptions(screen.getByLabelText("Mentor evidence category"), "exams");
    await user.type(screen.getByLabelText("Mentor evidence reason"), "Review the large exam record and its following smaller result safely.");
    await user.type(screen.getByLabelText("Mentor evidence authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: /Read and audit evidence/i }));

    expect(await screen.findByText(/1 evidence item was safely shortened/i)).toBeInTheDocument();
    expect(screen.getByText(/large-attempt/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Mentor evidence next-page authenticator code"), "654321");
    await user.click(screen.getByRole("button", { name: /Read next audited page/i }));

    expect(await screen.findByText(/small-older-attempt/i)).toBeInTheDocument();
    expect(screen.getByText(/large-attempt/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not provide a safe continuation cursor/i)).not.toBeInTheDocument();
    expect(evidencePage).toBe(2);
  });

  it("shows a terminal quarantine as resolved without offering a conflicting new recovery action", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "26000000-0000-4000-8000-000000000001" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/learners/${LEARNER_ID}/mentor-evidence`) return json({
        evidence: {
          category: "code_submissions",
          items: [{
            id: "26000000-0000-4000-8000-000000000002",
            runnerJobId: "26000000-0000-4000-8000-000000000003",
            runnerRequestId: "resolved-request-key",
            remoteRunnerJobId: null,
            submissionType: "server_run",
            submissionStatus: "cancelled",
            runnerStatus: "cancelled",
            recoveryState: "quarantined",
            recoveryLastErrorCode: "PRACTICE_QUARANTINE_OPERATOR_RESOLVED",
          }, {
            id: "26000000-0000-4000-8000-000000000004",
            runnerJobId: "26000000-0000-4000-8000-000000000005",
            runnerRequestId: "official-quarantine-key",
            remoteRunnerJobId: null,
            submissionType: "exam_final_test",
            submissionStatus: "leased",
            runnerStatus: "leased",
            recoveryState: "quarantined",
          }],
          page: { limit: 5, hasMore: false, nextCursor: null },
          safeguards: {
            responseBytes: 180,
            responseByteLimit: 131_072,
            perItemByteLimit: 49_152,
            truncatedItemCount: 0,
            hiddenAssessmentEvidenceIncluded: false,
            credentialOrSessionEvidenceIncluded: false,
            deviceOrIpEvidenceIncluded: false,
          },
        },
        purpose: "safety_review",
        autoClearSeconds: 300,
      });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AdminMentorEvidenceReader learnerId={LEARNER_ID} />);
    await user.selectOptions(screen.getByLabelText("Mentor evidence category"), "code_submissions");
    await user.selectOptions(screen.getByLabelText("Mentoring purpose"), "safety_review");
    await user.type(screen.getByLabelText("Mentor evidence reason"), "Confirm the prior quarantined practice recovery is already terminal.");
    await user.type(screen.getByLabelText("Mentor evidence authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: /Read and audit evidence/i }));

    expect(await screen.findByText(/Quarantine is terminally resolved/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resolve quarantined practice run/i })).not.toBeInTheDocument();
  });
});
