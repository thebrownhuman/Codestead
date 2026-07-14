import { describe, expect, it } from "vitest";

import { assertSupportedMonacoAmdVersion } from "../monaco-assets-policy";

describe("self-hosted Monaco asset policy", () => {
  it.each(["0.52.0", "0.52.2", "0.52.3-beta.1"])("accepts the supported AMD release line: %s", (version) => {
    expect(() => assertSupportedMonacoAmdVersion(version)).not.toThrow();
  });

  it.each(["0.53.0", "0.55.1", "1.0.0", "invalid"])("rejects an unsupported AMD bundle: %s", (version) => {
    expect(() => assertSupportedMonacoAmdVersion(version)).toThrow(/not approved for the self-hosted AMD loader/i);
  });
});
