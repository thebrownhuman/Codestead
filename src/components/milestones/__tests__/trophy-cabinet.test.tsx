import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TrophyCabinet } from "../trophy-cabinet";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TrophyCabinet", () => {
  it("shows active and revoked evidence honestly without creating coins", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cabinet: {
          summary: { earned: 1, revoked: 1, shared: 0 },
          rewards: { coinsEnabled: false, coins: 0, notice: "Trophies mirror authoritative evidence." },
          trophies: [
            {
              id: "mastery-1",
              kind: "module_mastery",
              title: "Variables mastered",
              description: "Independent evidence for Variables.",
              icon: "award",
              earnedAt: "2026-07-14T00:00:00.000Z",
              status: "earned",
              visibility: "private",
              evidenceLabel: "95% independent mastery",
              verificationPath: null,
            },
            {
              id: "certificate-1",
              kind: "course_completion",
              title: "Python certificate",
              description: "Certificate evidence was revoked.",
              icon: "trophy",
              earnedAt: "2026-07-13T00:00:00.000Z",
              status: "revoked",
              visibility: "private",
              evidenceLabel: "Revoked certificate",
              verificationPath: null,
            },
          ],
        },
      }),
    }));

    render(<TrophyCabinet />);

    expect(await screen.findByRole("heading", { name: "Variables mastered" })).toBeInTheDocument();
    expect(screen.getByText("Python certificate")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText(/coins stay disabled at 0/i)).toBeInTheDocument();
    expect(screen.getByText("95% independent mastery")).toBeInTheDocument();
  });
});
