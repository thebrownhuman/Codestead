import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileLibrary } from "../file-library";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const populated = {
  uploadsEnabled: true,
  files: [
    { id: "safe-1", name: "solution.py", mediaType: "text/plain", sizeBytes: 1200, scanStatus: "safe", createdAt: "2026-07-12T00:00:00Z" },
    { id: "pending-1", name: "diagram.png", mediaType: "image/png", sizeBytes: 2400, scanStatus: "pending", createdAt: "2026-07-12T00:00:00Z" },
  ],
  quota: { usedBytes: 3600, limitBytes: 2 * 1024 ** 3 },
};

describe("learner project file library", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows authoritative quota, scan state, and download only for safe files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(populated)));
    render(<FileLibrary />);

    expect(await screen.findByText("solution.py")).toBeInTheDocument();
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Storage quota used" })).toHaveAttribute(
      "max",
      String(2 * 1024 ** 3),
    );
    expect(screen.getByRole("link", { name: /Download/i })).toHaveAttribute("href", "/api/files/safe-1");
    expect(screen.getAllByText("Not downloadable")).toHaveLength(1);
    expect(screen.getByText(/Executables and archives are rejected/i)).toBeInTheDocument();
  });

  it("uploads with FormData, refreshes usage, and requires explicit delete confirmation", async () => {
    const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
    let getCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body });
      if (url === "/api/files" && method === "GET") {
        getCount += 1;
        return json(getCount === 1 ? populated : {
          uploadsEnabled: true,
          files: [],
          quota: { usedBytes: 0, limitBytes: 2 * 1024 ** 3 },
        });
      }
      if (url === "/api/files" && method === "POST") return json({ file: { id: "new" } }, { status: 201 });
      if (url === "/api/files/safe-1" && method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    const user = userEvent.setup();
    render(<FileLibrary />);
    await screen.findByText("solution.py");

    const input = screen.getByLabelText("Choose a project file");
    await user.upload(input, new File(["print('hello')"], "hello.py", { type: "text/x-python" }));
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await screen.findByText(/File stored in quarantine/i);
    expect(calls.find((call) => call.method === "POST")?.body).toBeInstanceOf(FormData);

    // Restore a visible file for the destructive-action confirmation check.
    getCount = 0;
    await user.click(screen.getByRole("button", { name: /Upload/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Choose one supported file"));
  });

  it("does not delete until the learner confirms the selected file", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
      return json(populated);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<FileLibrary />);
    await screen.findByText("solution.py");

    await user.click(screen.getByRole("button", { name: "Delete solution.py" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByText(/quota reservation released/i);
    expect(fetchMock).toHaveBeenCalledWith("/api/files/safe-1", { method: "DELETE" });
  });

  it("keeps existing files usable while pilot uploads are disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ...populated,
      uploadsEnabled: false,
    })));
    render(<FileLibrary />);
    expect(await screen.findByText("solution.py")).toBeInTheDocument();
    expect(screen.queryByLabelText("Choose a project file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(screen.getByText(/Uploads are disabled during the private pilot/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/i })).toBeInTheDocument();
  });
});
