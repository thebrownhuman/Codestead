import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSupportRequestQueue } from "../support-request-queue";
import userEvent from "@testing-library/user-event";
import { selectOption } from "@/test/select-option";
const item = { id: "10000000-0000-4000-8000-000000000001", kind: "support-ai", subject: "AI model/key problem · google", details: JSON.stringify({ message: "Model fails", context: { provider: "google", errorCode: "MODEL_NOT_FOUND", httpStatus: 404 } }), status: "pending", learnerName: "Learner", learnerEmail: "learner@example.test", createdAt: "2026-10-04T12:00:00Z", decidedAt: null, decisionReason: null };
describe("admin support queue", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shows details, filters resolved, and marks fixed with an optional reply", async () => {
    const fetch = vi.fn(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? { ok: true } : { requests: [item] })));
    vi.stubGlobal("fetch", fetch);
    render(<AdminSupportRequestQueue />);
    await screen.findByText("Model fails");
    expect(screen.getByText(/MODEL_NOT_FOUND/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Optional reply"), { target: { value: "Fixed the model" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith("/decision") && init?.body === JSON.stringify({ decision: "fixed", reply: "Fixed the model" }))).toBe(true));
    await selectOption(userEvent.setup(), screen.getByLabelText("Request status"), "resolved");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/admin/learning-requests?queue=support&status=resolved", expect.anything()));
  });
  it("renders a recoverable fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection failed")));
    render(<AdminSupportRequestQueue />);
    await screen.findByText("Connection failed");
    expect(screen.getByRole("button", { name: /Retry|Try again/i })).toBeInTheDocument();
  });
});
