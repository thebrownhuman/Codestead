import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivacyConsentPanel } from "../privacy-consent-panel";
import { SettingsView } from "../settings-view";

const policyVersion = "enrollment-disclosure-2026-07-12.v2";
const disclosures = [
  ["adult_18_plus", "Adult-only pilot"],
  ["mentor_visibility", "Administrator mentor visibility"],
  ["external_ai_routing", "External AI providers"],
  ["server_code_execution", "Server code execution"],
  ["retention_policy", "Retention and backups"],
  ["inactivity_mentor_notice", "Inactivity notices"],
].map(([purpose, title]) => ({ purpose, title, summary: `${title} disclosure summary.` }));

const optionalPurposes = [
  "cohort_profile",
  "leaderboard",
  "admin_fallback_ai",
  "provider:nvidia_nim",
  "provider:openrouter",
  "provider:google",
  "provider:openai",
  "provider:anthropic",
  "provider:deepseek",
  "provider:custom_openai_compatible",
  "provider:future_lab",
].map((purpose) => ({ purpose, dataCategories: [`category-for-${purpose}`] }));

function record(decision: "accepted" | "withdrawn", currentVersionAccepted = decision === "accepted") {
  return {
    decision,
    policyVersion,
    dataCategories: ["bounded-context"],
    occurredAt: "2026-07-12T08:00:00.000Z",
    currentVersionAccepted,
  };
}

function snapshot(current: Record<string, ReturnType<typeof record>> = {}) {
  return {
    policyVersion,
    requiredDisclosures: disclosures,
    optionalPurposes,
    current: {
      ...Object.fromEntries(disclosures.map(({ purpose }) => [purpose, record("accepted")])),
      ...current,
    },
  };
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function switchNamed(name: RegExp) {
  return screen.getByRole("switch", { name });
}

describe("privacy and consent settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the current policy, immutable core disclosures, and every independent optional purpose", async () => {
    const body = snapshot({
      cohort_profile: record("accepted"),
      leaderboard: record("accepted"),
      admin_fallback_ai: record("withdrawn"),
      "provider:nvidia_nim": {
        ...record("accepted"),
        secret: "must-never-render",
      } as ReturnType<typeof record>,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));

    render(<PrivacyConsentPanel />);

    expect(await screen.findByRole("heading", { name: "Privacy and consent" })).toBeInTheDocument();
    expect(screen.getByText(policyVersion)).toBeInTheDocument();
    for (const disclosure of disclosures) {
      expect(screen.getByText(disclosure.title, { selector: "strong" })).toBeInTheDocument();
    }
    expect(screen.getAllByText("acknowledged")).toHaveLength(disclosures.length);
    expect(screen.getAllByRole("switch")).toHaveLength(optionalPurposes.length);
    expect(switchNamed(/^Cohort profile\b/i)).toBeChecked();
    expect(switchNamed(/^Leaderboard\b/i)).toBeChecked();
    expect(switchNamed(/^Administrator-funded AI fallback\b/i)).not.toBeChecked();
    expect(switchNamed(/^NVIDIA NIM routing\b/i)).toBeChecked();
    expect(switchNamed(/^future lab consent\b/i)).not.toBeChecked();
    expect(screen.getByText(/withdrawals apply to future processing/i)).toBeInTheDocument();
    expect(screen.getByText(/does not erase requests already processed/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("must-never-render");
  });

  it("blocks leaderboard opt-in until cohort sharing is accepted and uses unique UUID requests", async () => {
    let cohort = false;
    let leaderboard = false;
    const posts: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) {
        return json(snapshot({
          cohort_profile: record(cohort ? "accepted" : "withdrawn"),
          leaderboard: record(leaderboard ? "accepted" : "withdrawn"),
        }));
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (body.purpose === "cohort_profile") cohort = body.decision === "accepted";
      if (body.purpose === "leaderboard") leaderboard = body.decision === "accepted";
      return json({ ok: true, effectiveForFutureProcessing: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<PrivacyConsentPanel />);
    expect(await screen.findByText("Enable the cohort profile first.")).toBeInTheDocument();
    expect(switchNamed(/^Leaderboard\b/i)).toBeDisabled();

    await user.click(switchNamed(/^Cohort profile\b/i));
    await waitFor(() => expect(switchNamed(/^Cohort profile\b/i)).toBeChecked());
    expect(switchNamed(/^Leaderboard\b/i)).toBeEnabled();

    await user.click(switchNamed(/^Leaderboard\b/i));
    await waitFor(() => expect(switchNamed(/^Leaderboard\b/i)).toBeChecked());

    expect(posts).toHaveLength(2);
    expect(posts.map((body) => body.purpose)).toEqual(["cohort_profile", "leaderboard"]);
    expect(posts.every((body) => body.policyVersion === policyVersion)).toBe(true);
    const requestIds = posts.map((body) => String(body.requestId));
    expect(requestIds.every((requestId) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))).toBe(true);
    expect(new Set(requestIds).size).toBe(2);
    expect(JSON.stringify(posts)).not.toMatch(/secret|apiKey|credential/i);
  });

  it("propagates cohort withdrawal to leaderboard state for future processing", async () => {
    let cohort = true;
    let leaderboard = true;
    const posts: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        cohort = false;
        leaderboard = false;
        return json({ ok: true, effectiveForFutureProcessing: true });
      }
      return json(snapshot({
        cohort_profile: record(cohort ? "accepted" : "withdrawn"),
        leaderboard: record(leaderboard ? "accepted" : "withdrawn"),
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<PrivacyConsentPanel />);
    expect(await screen.findByRole("switch", { name: /^Cohort profile\b/i })).toBeChecked();
    await user.click(switchNamed(/^Cohort profile\b/i));

    expect(await screen.findByText(/cohort profile and leaderboard consent were withdrawn for future processing/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(switchNamed(/^Cohort profile\b/i)).not.toBeChecked();
      expect(switchNamed(/^Leaderboard\b/i)).not.toBeChecked();
      expect(switchNamed(/^Leaderboard\b/i)).toBeDisabled();
    });
    expect(posts).toEqual([expect.objectContaining({
      purpose: "cohort_profile",
      decision: "withdrawn",
    })]);
  });

  it("withdraws one provider without changing other provider or fallback choices", async () => {
    let deepseek = true;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { purpose: string; decision: string };
        if (body.purpose === "provider:deepseek") deepseek = body.decision === "accepted";
        return json({ ok: true, effectiveForFutureProcessing: true });
      }
      return json(snapshot({
        admin_fallback_ai: record("accepted"),
        "provider:nvidia_nim": record("accepted"),
        "provider:deepseek": record(deepseek ? "accepted" : "withdrawn"),
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<PrivacyConsentPanel />);
    expect(await screen.findByRole("switch", { name: /^DeepSeek routing\b/i })).toBeChecked();
    await user.click(switchNamed(/^DeepSeek routing\b/i));

    await waitFor(() => expect(switchNamed(/^DeepSeek routing\b/i)).not.toBeChecked());
    expect(switchNamed(/^NVIDIA NIM routing\b/i)).toBeChecked();
    expect(switchNamed(/^Administrator-funded AI fallback\b/i)).toBeChecked();
  });

  it("surfaces load errors and recovers through the explicit retry action", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: "Consent service is temporarily unavailable." }, { status: 503 }))
      .mockResolvedValueOnce(json(snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<PrivacyConsentPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading privacy/i);
    expect(await screen.findByRole("alert")).toHaveTextContent("Consent service is temporarily unavailable.");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(policyVersion)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [json({ error: "The policy version changed. Reload and review it." }, { status: 409 }), "The policy version changed. Reload and review it."],
    [new Response("not-json", { status: 503 }), "The privacy choice could not be saved."],
  ])("keeps the prior choice when a consent mutation fails", async (failureResponse, message) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(snapshot({ cohort_profile: record("accepted") })))
      .mockResolvedValueOnce(failureResponse);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<PrivacyConsentPanel />);
    const cohortSwitch = await screen.findByRole("switch", { name: /^Cohort profile\b/i });
    expect(cohortSwitch).toBeChecked();
    await user.click(cohortSwitch);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(cohortSwitch).toBeChecked();
    expect(cohortSwitch).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an acknowledged mutation visible when the authoritative refresh fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(snapshot({ admin_fallback_ai: record("withdrawn") })))
      .mockResolvedValueOnce(json({ ok: true, effectiveForFutureProcessing: true }))
      .mockRejectedValueOnce(new Error("refresh offline"));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<PrivacyConsentPanel />);
    const fallbackSwitch = await screen.findByRole("switch", { name: /^Administrator-funded AI fallback\b/i });
    await user.click(fallbackSwitch);

    await waitFor(() => expect(fallbackSwitch).toBeChecked());
    expect(await screen.findByRole("alert")).toHaveTextContent(/choice was saved.*refresh offline/i);
    expect(screen.getByRole("status")).toHaveTextContent(/was accepted for future processing/i);
  });

  it("exposes privacy as a first-class SettingsView tab", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/credentials") return json({ credentials: [] });
      if (String(input) === "/api/privacy/consents") return json(snapshot());
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SettingsView initialTab="privacy" />);

    expect(await screen.findByRole("heading", { name: "Privacy and consent" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Privacy & consent/i })).toBeInTheDocument();
  });
});
