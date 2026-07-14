import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import { adminJson, secureAdminResponse } from "../http";

describe("administrator response privacy", () => {
  it("marks successful JSON snapshots private and no-store", async () => {
    const response = adminJson({ ok: true });

    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("applies the same controls to authorization failures", () => {
    const response = secureAdminResponse(
      NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
