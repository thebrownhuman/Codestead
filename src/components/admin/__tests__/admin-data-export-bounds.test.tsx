import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AdminDataLifecycleControls } from "../admin-data-lifecycle-controls";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows a stream deadline error and never creates a partial download", async () => {
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/security/fresh-mfa") return Response.json({ ok: true });
    return {
      ok: true, status: 200,
      blob: async () => { throw new Error("stream aborted"); },
    };
  }));
  const user = userEvent.setup();
  render(<AdminDataLifecycleControls learnerId="learner" />);
  await user.type(screen.getByLabelText(/authenticator code/i), "123456");
  await user.type(screen.getByLabelText("Recorded reason"), "Learner requested export");
  await user.click(screen.getByRole("button", { name: /Export bounded NDJSON/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/deadline.*No file was saved.*retry/i);
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});
