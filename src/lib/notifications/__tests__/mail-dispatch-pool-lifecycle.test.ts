import { describe, expect, it, vi } from "vitest";

import {
  createMailDispatchDatabaseResources,
} from "../mail-dispatch-pool";

describe("dedicated mail pool startup lifecycle", () => {
  it("destroys the exact pool when startup inspection never resolves", async () => {
    vi.useFakeTimers();
    const end = vi.fn(async () => undefined);
    const pool = {
      options: {
        max: 3,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000,
      },
      query: vi.fn(() => new Promise<never>(() => undefined)),
      end,
    };
    const pending = createMailDispatchDatabaseResources(
      {
        createPool: vi.fn(() => pool) as never,
        createDatabase: vi.fn(() => ({})) as never,
      },
    );
    const rejection = expect(pending)
      .rejects.toThrow("Mail dispatch startup database inspection failed.");

    await vi.advanceTimersByTimeAsync(6_000);
    await rejection;
    expect(end).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
