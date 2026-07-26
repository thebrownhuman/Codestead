import { describe, expect, it, vi } from "vitest";

import {
  parsePostgresServerVersionNum,
  requireMailDeliveryAuthorityRuntime,
  requireMailDispatchPostgresRuntime,
} from "../mail-dispatch-runtime-startup";

describe("mail dispatch PostgreSQL runtime authority", () => {
  it.each([
    ["170000", 17],
    ["170012", 17],
    ["180000", 18],
  ])("accepts server_version_num %s as major %i", (versionNum, major) => {
    expect(parsePostgresServerVersionNum(versionNum)).toEqual({
      major,
      versionNum: Number(versionNum),
    });
  });

  it.each([
    "",
    "17",
    "17.5",
    " 170000",
    "170000 ",
    "0160000",
    "not-a-version",
  ])("rejects malformed server_version_num %j", (versionNum) => {
    expect(() => parsePostgresServerVersionNum(versionNum)).toThrow(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it("accepts targeted PostgreSQL 18 while rejecting runtime majors below 17", async () => {
    const pg18 = {
      query: vi.fn(async () => ({
        rows: [{ server_version_num: "180000" }],
      })),
    };
    await expect(requireMailDispatchPostgresRuntime(pg18)).resolves.toEqual({
      major: 18,
      versionNum: 180000,
    });

    const pg16 = {
      query: vi.fn(async () => ({
        rows: [{ server_version_num: "160011" }],
      })),
    };
    await expect(requireMailDispatchPostgresRuntime(pg16)).rejects.toEqual(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it.each([
    ["zero rows", []],
    [
      "multiple rows",
      [
        { server_version_num: "170000" },
        { server_version_num: "170000" },
      ],
    ],
    ["null value", [{ server_version_num: null }]],
    ["numeric value", [{ server_version_num: 170000 }]],
  ])("fails closed for %s", async (_label, rows) => {
    const database = { query: vi.fn(async () => ({ rows })) };

    await expect(requireMailDispatchPostgresRuntime(database)).rejects.toEqual(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it("normalizes query failures to the fixed operational error", async () => {
    const database = {
      query: vi.fn(async () => {
        throw new Error("private connection detail");
      }),
    };

    await expect(requireMailDispatchPostgresRuntime(database)).rejects.toEqual(
      expect.objectContaining({
        name: "POSTGRES_RUNTIME_UNSUPPORTED",
        message: "Mail dispatch requires PostgreSQL 17 or newer.",
      }),
    );
  });
});

describe("mail delivery authority runtime gate", () => {
  it("allows the pre-0067 catalog while exposing no release capability", async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [{
          hold_catalog_present: false,
          hold_catalog_exact: false,
          delivery_release_capability_exact: false,
        }],
      })),
    };

    await expect(
      requireMailDeliveryAuthorityRuntime(database),
    ).resolves.toEqual({
      holdCatalogExact: false,
      deliveryReleaseCapabilityExact: false,
    });
  });

  it("detects the exact Task 5 hold but cannot authorize Task 7 delivery", async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [{
          hold_catalog_present: true,
          hold_catalog_exact: true,
          delivery_release_capability_exact: false,
        }],
      })),
    };

    await expect(
      requireMailDeliveryAuthorityRuntime(database),
    ).resolves.toEqual({
      holdCatalogExact: true,
      deliveryReleaseCapabilityExact: false,
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("delivery_hold_version"),
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("drizzle.__drizzle_migrations"),
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("1784997273087"),
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("1785002172253"),
    );
  });

  it.each([
    [
      "partial hold catalog",
      {
        hold_catalog_present: true,
        hold_catalog_exact: false,
        delivery_release_capability_exact: false,
      },
    ],
    [
      "release without its hold",
      {
        hold_catalog_present: false,
        hold_catalog_exact: false,
        delivery_release_capability_exact: true,
      },
    ],
    [
      "malformed value",
      {
        hold_catalog_present: "true",
        hold_catalog_exact: true,
        delivery_release_capability_exact: false,
      },
    ],
  ])("normalizes %s to the fixed operational error", async (_label, row) => {
    const database = {
      query: vi.fn(async () => ({ rows: [row] })),
    };

    await expect(requireMailDeliveryAuthorityRuntime(database)).rejects.toEqual(
      expect.objectContaining({
        name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
        message: "Mail delivery authority is unavailable.",
      }),
    );
  });
});
