import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { verifyKnownDependencyAdvisories } from "../verify-known-dependency-advisories";

const secureManifest = {
  overrides: {
    next: { postcss: "8.5.19" },
    "@esbuild-kit/core-utils": { esbuild: "0.25.12" },
  },
};

describe("known dependency advisory verifier", () => {
  it("accepts only lock entries outside both reviewed advisory ranges", () => {
    const errors = verifyKnownDependencyAdvisories(secureManifest, {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/esbuild": { version: "0.25.12" },
        "node_modules/tsx/node_modules/esbuild": { version: "0.28.1" },
        "node_modules/postcss": { version: "8.5.19" },
        "node_modules/vite/node_modules/postcss": { version: "8.5.17" },
      },
    });

    expect(errors).toEqual([]);
  });

  it("rejects every vulnerable nested copy with its advisory identifier", () => {
    const errors = verifyKnownDependencyAdvisories(secureManifest, {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/esbuild": { version: "0.25.12" },
        "node_modules/@esbuild-kit/core-utils/node_modules/esbuild": {
          version: "0.18.20",
        },
        "node_modules/postcss": { version: "8.5.19" },
        "node_modules/next/node_modules/postcss": { version: "8.4.31" },
      },
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("GHSA-67mh-4wv8-2f99"),
        expect.stringContaining("GHSA-qx2v-qp2m-jg93"),
      ]),
    );
  });

  it("fails closed when either reviewed override drifts", () => {
    const errors = verifyKnownDependencyAdvisories(
      { overrides: { next: { postcss: "8.5.10" } } },
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/esbuild": { version: "0.25.12" },
          "node_modules/postcss": { version: "8.5.19" },
        },
      },
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("next -> postcss override"),
        expect.stringContaining("@esbuild-kit/core-utils -> esbuild override"),
      ]),
    );
  });

  it.each(["latest", "8.5", "8.5.10-beta.1", ""])(
    "rejects the non-release package version %j",
    (version) => {
      const errors = verifyKnownDependencyAdvisories(secureManifest, {
        lockfileVersion: 3,
        packages: {
          "node_modules/esbuild": { version: "0.25.12" },
          "node_modules/postcss": { version },
        },
      });

      expect(errors).toEqual(
        expect.arrayContaining([expect.stringContaining("invalid version")]),
      );
    },
  );

  it.each(["00.25.00", "0.025.0", "08.05.010", "8.5.010"])(
    "rejects the non-canonical leading-zero package version %j",
    (version) => {
      const errors = verifyKnownDependencyAdvisories(secureManifest, {
        lockfileVersion: 3,
        packages: {
          "node_modules/esbuild": { version: "0.25.12" },
          "node_modules/postcss": { version },
        },
      });

      expect(errors).toEqual(
        expect.arrayContaining([expect.stringContaining("invalid version")]),
      );
    },
  );

  it("rejects a lock with no esbuild or PostCSS inventory", () => {
    const errors = verifyKnownDependencyAdvisories(secureManifest, {
      lockfileVersion: 3,
      packages: { "": {} },
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No esbuild package"),
        expect.stringContaining("No postcss package"),
      ]),
    );
  });

  it("passes against the checked-in manifest and lockfile", async () => {
    const [manifest, lock] = await Promise.all([
      readFile("package.json", "utf8").then(JSON.parse),
      readFile("package-lock.json", "utf8").then(JSON.parse),
    ]);

    expect(verifyKnownDependencyAdvisories(manifest, lock)).toEqual([]);
  });
});
