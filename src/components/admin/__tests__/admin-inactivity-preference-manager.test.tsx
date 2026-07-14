import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestAdminJson: vi.fn() }));

vi.mock("../admin-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../admin-utils")>()),
  requestAdminJson: mocks.requestAdminJson,
}));

import { AdminInactivityPreferenceManager } from "../admin-inactivity-preference-manager";

const learnerId = "b1000000-0000-4000-8000-000000000001";
const activePreference = {
  learnerId,
  quietHoursEnabled: true,
  quietStartMinute: 1_320,
  quietEndMinute: 480,
  inactivityPausedUntil: null,
  rowVersion: 1,
};

describe("administrator inactivity reminder controls", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    mocks.requestAdminJson.mockResolvedValue(activePreference);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows the exact policy and submits a version-bound, reasoned pause", async () => {
    mocks.requestAdminJson
      .mockResolvedValueOnce(activePreference)
      .mockResolvedValueOnce({
        ...activePreference,
        inactivityPausedUntil: "2026-07-15T12:00:00.000Z",
        rowVersion: 2,
      });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AdminInactivityPreferenceManager learnerId={learnerId} />);

    expect(await screen.findByText("24h · 72h · then silence")).toBeInTheDocument();
    expect(screen.getByText("22:00–08:00")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Reason for temporary pause"), "Learner requested an examination pause.");
    await user.click(screen.getByRole("button", { name: /pause reminders/i }));

    await waitFor(() => expect(mocks.requestAdminJson).toHaveBeenCalledTimes(2));
    const [url, options] = mocks.requestAdminJson.mock.calls[1]!;
    expect(url).toContain(learnerId);
    expect(options.method).toBe("PATCH");
    const payload = JSON.parse(options.body) as { expectedVersion: number; pausedUntil: string; reason: string };
    expect(payload).toMatchObject({
      expectedVersion: 1,
      reason: "Learner requested an examination pause.",
    });
    expect(Math.abs(new Date(payload.pausedUntil).getTime() - new Date("2026-07-15T12:00:00.000Z").getTime()))
      .toBeLessThan(1_000);
    expect(await screen.findByText("Inactivity reminders paused.")).toBeInTheDocument();
  });

  it("does not expose the private administrator reason in the loaded preference view", async () => {
    render(<AdminInactivityPreferenceManager learnerId={learnerId} />);
    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.queryByText(/administrator-approved/i)).not.toBeInTheDocument();
  });
});
