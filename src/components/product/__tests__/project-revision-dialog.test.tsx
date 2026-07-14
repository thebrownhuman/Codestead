import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectRevisionDialog } from "../project-revision-dialog";

const projectId = "14000000-0000-4000-8000-000000000001";
const requestId = "14000000-0000-4000-8000-000000000002";
const fileId = "14000000-0000-4000-8000-000000000003";

function history(latestSequence = 1) {
  return {
    latestSequence,
    nextBeforeSequence: null,
    revisions: latestSequence ? [{
      id: "14000000-0000-4000-8000-000000000004",
      projectId,
      sequence: 1,
      changeSummary: "Created the first independently built workflow.",
      reflection: "I still need to test malformed input.",
      createdAt: "2026-07-12T10:00:00.000Z",
      files: [{
        objectId: null,
        originalName: "old-main.py",
        mediaType: "text/x-python",
        sizeBytes: 321,
        sha256: "a".repeat(64),
        available: false,
        downloadUrl: null,
      }],
    }] : [],
  };
}

describe("learner project revision dialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
  });

  it("shows immutable history, safe-file choices, and creates the next owner checkpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/files") {
        return new Response(JSON.stringify({ files: [
          { id: fileId, name: "main.py", mediaType: "text/x-python", sizeBytes: 512, scanStatus: "safe", createdAt: "2026-07-12T10:00:00Z" },
          { id: "14000000-0000-4000-8000-000000000099", name: "pending.py", mediaType: "text/x-python", sizeBytes: 1, scanStatus: "pending", createdAt: "2026-07-12T10:00:00Z" },
        ] }), { status: 200 });
      }
      if (url.includes("/revisions?") && !init?.method) {
        return new Response(JSON.stringify(history()), { status: 200 });
      }
      if (url.endsWith("/revisions") && init?.method === "POST") {
        return new Response(JSON.stringify({
          duplicate: false,
          revision: {
            id: "14000000-0000-4000-8000-000000000005",
            projectId,
            sequence: 2,
            changeSummary: "Added malformed-input and failure-path tests.",
            reflection: "I can now explain the validation boundary.",
            createdAt: "2026-07-12T11:00:00.000Z",
            files: [{
              objectId: fileId,
              originalName: "main.py",
              mediaType: "text/x-python",
              sizeBytes: 512,
              sha256: "b".repeat(64),
              available: true,
              downloadUrl: `/api/files/${fileId}`,
            }],
          },
        }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: `Unexpected ${url}` }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectRevisionDialog onClose={vi.fn()} projectId={projectId} projectTitle="Portfolio API" />);

    expect(await screen.findByText("Revision 1")).toBeInTheDocument();
    expect(screen.getByText(/Historical metadata · file unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/does not copy a file or consume quota again/i)).toBeInTheDocument();
    expect(screen.getByText("main.py")).toBeInTheDocument();
    expect(screen.queryByText("pending.py")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("What changed?"), {
      target: { value: "Added malformed-input and failure-path tests." },
    });
    fireEvent.change(screen.getByLabelText("Reflection (optional)"), {
      target: { value: "I can now explain the validation boundary." },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /main.py/i }));
    fireEvent.click(screen.getByRole("button", { name: "Record checkpoint" }));

    expect(await screen.findByText("Revision 2 was recorded.")).toBeInTheDocument();
    expect(screen.getByText("Revision 2")).toBeInTheDocument();
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/revisions") && init?.method === "POST");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        clientRequestId: requestId,
        expectedLatestRevision: 1,
        changeSummary: "Added malformed-input and failure-path tests.",
        reflection: "I can now explain the validation boundary.",
        fileIds: [fileId],
      });
    });
  });

  it("reloads the authoritative sequence on a write conflict", async () => {
    let historyReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/files") return new Response(JSON.stringify({ files: [] }), { status: 200 });
      if (url.includes("/revisions?") && !init?.method) {
        historyReads += 1;
        return new Response(JSON.stringify(history(historyReads === 1 ? 1 : 2)), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: "VERSION_CONFLICT",
        currentLatestRevision: 2,
        error: "Project revision history changed. Reload before saving a new checkpoint.",
      }), { status: 409 });
    }));
    render(<ProjectRevisionDialog onClose={vi.fn()} projectId={projectId} projectTitle="Portfolio API" />);
    await screen.findByText("Revision 1");
    fireEvent.change(screen.getByLabelText("What changed?"), {
      target: { value: "Added another independently written checkpoint." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record checkpoint" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("history changed");
    expect(historyReads).toBe(2);
    expect(screen.getByText("2 recorded checkpoints")).toBeInTheDocument();
  });

  it("closes with Escape from the accessible modal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/files"
      ? new Response(JSON.stringify({ files: [] }), { status: 200 })
      : new Response(JSON.stringify(history(0)), { status: 200 })));
    const onClose = vi.fn();
    render(<ProjectRevisionDialog onClose={onClose} projectId={projectId} projectTitle="Portfolio API" />);
    expect(await screen.findByRole("dialog", { name: /Revision history/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
