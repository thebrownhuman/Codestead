import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LearnerModelChoice } from "../learner-model-choice";
const model = { key: "model-key", name: "Enabled model", provider: "Google Gemini" };
const settings = { models: [model], selectedKey: null, defaultModel: model, unavailable: false };
afterEach(() => vi.unstubAllGlobals());
it("shows model plus provider and saves an explicit model or use-default", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(settings)));
  vi.stubGlobal("fetch", fetch);
  render(<LearnerModelChoice />);
  const select = await screen.findByRole("combobox", { name: "Preferred AI model" });
  await waitFor(() => expect(select).toBeEnabled());
  expect(screen.getByRole("option", { name: "Enabled model (Google Gemini)" })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: model.key } });
  fireEvent.click(screen.getByRole("button", { name: "Save model preference" }));
  await screen.findByText("AI model preference saved.");
  expect(fetch).toHaveBeenCalledWith("/api/settings/ai-model", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ key: model.key }) }));
  fireEvent.change(select, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save model preference" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/settings/ai-model", expect.objectContaining({ body: JSON.stringify({ key: null }) })));
});
it("explains disabled-after-choice default fallback", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...settings, unavailable: true }))));
  render(<LearnerModelChoice />);
  expect(await screen.findByRole("status")).toHaveTextContent("no longer enabled");
});
