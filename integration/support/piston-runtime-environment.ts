import { afterAll, beforeAll } from "vitest";

/** Disposable integration stand-in for the deployed Piston endpoint and
 * digest-pinned image. Application routing is Piston-only, so publishing an
 * exam form requires both; no request ever reaches this endpoint unless a
 * test stubs fetch for it.
 */
export const INTEGRATION_PISTON_URL = "http://piston.integration:2000";
export const INTEGRATION_PISTON_IMAGE = `ghcr.io/codestead/piston@sha256:${"d".repeat(64)}`;

export function usePistonRuntimeEnvironment() {
  const previous: Record<string, string | undefined> = {};
  const values: Record<string, string> = {
    CODE_RUNNER_PROVIDER: "piston",
    PISTON_URL: INTEGRATION_PISTON_URL,
    PISTON_IMAGE: INTEGRATION_PISTON_IMAGE,
  };
  beforeAll(() => {
    for (const [key, value] of Object.entries(values)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}
