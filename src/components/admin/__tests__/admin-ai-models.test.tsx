import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../step-up-request", () => ({ withStepUp: (run: () => Promise<Response>) => run() }));
import { AdminAiModels } from "../admin-ai-models";
import userEvent from "@testing-library/user-event";
import { selectOption } from "@/test/select-option";
const provider = { provider: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", version: 2, hasPlatformKey: true, model: "test/model", priority: 1, verification: "untested", source: "admin" };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
it("explains HTML gateway failures with their status", async () => {
 vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method ? new Response("<html>gateway</html>", { status: 502 }) : json({ providers: [provider] })));
 render(<AdminAiModels />); fireEvent.click(await screen.findByRole("button", { name: "Load models" }));
 expect(await screen.findByRole("alert")).toHaveTextContent("non-JSON response (HTTP 502)");
});
it("warns when a model's reasoning was removed", async () => {
 vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method ? json({ content: "Safe answer", reasoningDetected: true, latencyMs: 1, httpStatus: 200, proof: "proof", reportedModel: "model" }) : json({ providers: [provider] })));
 render(<AdminAiModels />); fireEvent.click(await screen.findByRole("button", { name: "Test" }));
 fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
 expect(await screen.findByText("This model returns reasoning text")).toBeInTheDocument();
});
it("shows today's authoritative platform usage and configured per-user daily limit", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ providers: [provider], platformUsage: { count: 17, date: "2026-10-05", dailyLimit: 25 } })));
  render(<AdminAiModels />);
  expect(await screen.findByText(/17 platform requests today/)).toBeInTheDocument();
  expect(screen.getByText(/25 per user per UTC day/)).toBeInTheDocument();
});
it("loads searchable models and labels free variants", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method === "POST" ? json({ models: [{ id: "qwen/model:free", name: "Qwen", free: true }, { id: "paid/model", name: "Paid", free: false }] }) : json({ providers: [provider] })));
  render(<AdminAiModels />);
  fireEvent.click(await screen.findByRole("button", { name: "Load models" }));
  expect(await screen.findByText("Free")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "qwen" } });
  expect(screen.queryByText("paid/model")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /qwen\/model:free/ }));
  expect(screen.getByLabelText("Model ID")).toHaveValue("qwen/model:free");
});
it("shows the real test reply, status and latency, then saves verified with its proof", async () => {
  const fetchMock = vi.fn(async (_url, init) => {
    if (!init?.method) return json({ providers: [provider] });
    const input = JSON.parse(init.body);
    return input.action === "test" ? json({ content: "Hello from the model", latencyMs: 680, httpStatus: 200, proof: "server-proof", reportedModel: "test/model" }) : json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock); render(<AdminAiModels />);
  fireEvent.click(await screen.findByRole("button", { name: "Test" }));
  const chat = screen.getByRole("dialog");
  fireEvent.change(within(chat).getByLabelText("Test message"), { target: { value: "hi there" } });
  fireEvent.click(within(chat).getByRole("button", { name: "Send test message" }));
  expect(await within(chat).findByText("Hello from the model")).toBeInTheDocument();
  expect(within(chat).getByText(/HTTP 200.*680 ms/)).toBeInTheDocument();
  fireEvent.click(within(chat).getByRole("button", { name: "Close test" }));
  await selectOption(userEvent.setup(), screen.getByLabelText("Save status"), "verified");
  fireEvent.click(screen.getByRole("button", { name: "Save default model" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/ai-models", expect.objectContaining({ body: expect.stringContaining('"proof":"server-proof"') })));
});
it("allows untested typed IDs without a key and requires saving endpoint edits before probing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ providers: [{ ...provider, hasPlatformKey: false }] })));
  render(<AdminAiModels />);
  const model = await screen.findByLabelText("Model ID");
  fireEvent.change(model, { target: { value: "typed/id" } });
  expect(screen.getByRole("button", { name: "Save default model" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
  await userEvent.click(screen.getByLabelText("Save status"));
  expect(screen.getByRole("option", { name: "Verified" })).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");
  fireEvent.change(screen.getByLabelText("HTTPS base URL"), { target: { value: "https://other.example/v1" } });
  expect(screen.getByRole("button", { name: "Load models" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save default model" })).toBeDisabled();
});

it("clears a transient platform key after saving its encrypted connection", async () => {
 let current = { ...provider, hasPlatformKey: false };
 const fetchMock = vi.fn(async (_url, init) => {
  if (!init?.method) return json({ providers: [current] });
  const command = JSON.parse(init.body); expect(command).toMatchObject({ action: "configure", platformKey: "typed-platform-key", version: 2 });
  current = { ...current, hasPlatformKey: true, version: 3 }; return json({ ok: true });
 });
 vi.stubGlobal("fetch", fetchMock); render(<AdminAiModels />);
 const input = await screen.findByLabelText("Platform API key");
 fireEvent.change(input, { target: { value: "typed-platform-key" } }); fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
 await waitFor(() => expect(screen.getByLabelText("Platform API key")).toHaveValue(""));
 expect(screen.getByLabelText("Platform API key")).toHaveAttribute("placeholder", "Stored securely; enter a replacement");
});
it("shows provider test failure status without enabling verification", async () => {
 vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method ? new Response(JSON.stringify({ error: "Model was retired", httpStatus: 410 }), { status: 502 }) : json({ providers: [provider] })));
 render(<AdminAiModels />); fireEvent.click(await screen.findByRole("button", { name: "Test" }));
 fireEvent.click(screen.getByRole("button", { name: "Send test message" })); expect(await screen.findByRole("alert")).toHaveTextContent("Model was retired (HTTP 410)");
 fireEvent.click(screen.getByRole("button", { name: "Close test" }));
 await userEvent.click(screen.getByLabelText("Save status"));
 expect(screen.getByRole("option", { name: "Verified" })).toHaveAttribute("aria-disabled", "true");
});
it("refuses fractional failover priorities in the UI", async () => {
 vi.stubGlobal("fetch", vi.fn(async () => json({ providers: [provider] }))); render(<AdminAiModels />);
 fireEvent.change(await screen.findByLabelText("Failover priority"), { target: { value: "1.5" } }); expect(screen.getByRole("button", { name: "Save default model" })).toBeDisabled();
});

it('preserves the non-JSON HTTP status when retrying settings', async () => {
 let status = 502;
 vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status })));
 render(<AdminAiModels />);
 expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502');
 status = 503;
 fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
 await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('HTTP 503'));
});
