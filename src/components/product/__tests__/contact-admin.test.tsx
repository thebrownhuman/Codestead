import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactAdminButton } from "../contact-admin";
import userEvent from "@testing-library/user-event";
import { selectOption } from "@/test/select-option";
describe("contact admin form", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends bounded message and explicitly selected safe context only", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ request: { id: "saved" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    render(<ContactAdminButton provider="google" errorCode="MODEL_NOT_FOUND" httpStatus={404} />);
    fireEvent.click(screen.getByRole("button", { name: "Contact admin" }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Model fails" } });
    expect(screen.getByLabelText("Message")).toHaveAttribute("maxlength", "1000");
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Request sent. You can follow it in Requests.");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ kind: "support-ai", provider: "google", message: "Model fails", context: { provider: "google", errorCode: "MODEL_NOT_FOUND", httpStatus: 404 } });
    expect(Object.keys(body).sort()).toEqual(["context", "kind", "message", "provider", "requestId"]);
  });
  it("allows excluding diagnostics and preserves retry ID after failure", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Daily limit reached" }), { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    render(<ContactAdminButton provider="openai" errorCode="raw-private-provider-body" />);
    fireEvent.click(screen.getByRole("button", { name: "Contact admin" }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Please help" } });
    fireEvent.click(screen.getByLabelText(/Attach safe diagnostics/));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Daily limit reached");
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0].context).toBeUndefined();
    expect(bodies[0].requestId).toBe(bodies[1].requestId);
    expect(JSON.stringify(bodies)).not.toContain("raw-private");
  });
  it("supports other requests and prevents a second submit while busy", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<ContactAdminButton />);
    fireEvent.click(screen.getByRole("button", { name: "Contact admin" }));
    await selectOption(userEvent.setup(), screen.getByLabelText("Category"), "support-other");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Help with my account" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
  });
});
