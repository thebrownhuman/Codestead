import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMailFrom } from "../mail-from";

describe("resolveMailFrom", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to Codestead with the default address when nothing is configured", () => {
    expect(resolveMailFrom()).toBe("Codestead <noreply@example.com>");
  });

  it("keeps the address from legacy MAIL_FROM but forces the Codestead display name", () => {
    vi.stubEnv("MAIL_FROM", "Shivansh mail server <shivanshmailserver@gmail.com>");
    expect(resolveMailFrom()).toBe("Codestead <shivanshmailserver@gmail.com>");
  });

  it("keeps a bare-address legacy MAIL_FROM and applies the default display name", () => {
    vi.stubEnv("MAIL_FROM", "shivanshmailserver@gmail.com");
    expect(resolveMailFrom()).toBe("Codestead <shivanshmailserver@gmail.com>");
  });

  it("prefers MAIL_FROM_ADDRESS over legacy MAIL_FROM", () => {
    vi.stubEnv("MAIL_FROM", "Someone <old@example.com>");
    vi.stubEnv("MAIL_FROM_ADDRESS", "new@example.com");
    expect(resolveMailFrom()).toBe("Codestead <new@example.com>");
  });

  it("allows overriding the display name via MAIL_FROM_NAME", () => {
    vi.stubEnv("MAIL_FROM_ADDRESS", "hello@example.com");
    vi.stubEnv("MAIL_FROM_NAME", "Codestead Beta");
    expect(resolveMailFrom()).toBe("Codestead Beta <hello@example.com>");
  });

  it("quotes a display name containing special characters", () => {
    vi.stubEnv("MAIL_FROM_ADDRESS", "hello@example.com");
    vi.stubEnv("MAIL_FROM_NAME", 'Code"stead, Inc.');
    expect(resolveMailFrom()).toBe('"Code\\"stead, Inc." <hello@example.com>');
  });

  it("rejects an address containing header-injection characters", () => {
    vi.stubEnv("MAIL_FROM_ADDRESS", "evil@example.com>\r\nBcc: attacker@example.com");
    expect(() => resolveMailFrom()).toThrow();
  });
});
