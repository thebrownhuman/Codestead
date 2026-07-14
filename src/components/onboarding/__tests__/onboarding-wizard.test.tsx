import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  enableMfa: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,fixture") } }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { twoFactor: { enable: mocks.enableMfa } },
}));

import { OnboardingWizard } from "../onboarding-wizard";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const emptyStatus = {
  requirements: { profileComplete: false, mfaEnabled: false, mfaFresh: false, nimActive: false },
  profile: null,
  account: { name: "Approved Learner" },
  consents: {},
};

const requiredDisclosureNames = [
  /I am at least 18/i,
  /administrator mentor visibility/i,
  /external AI routing/i,
  /allow NVIDIA NIM/i,
  /server code execution/i,
  /retention and backups/i,
  /generic inactivity notices/i,
];

async function completeRequiredProfile(
  user: ReturnType<typeof userEvent.setup>,
  options: { goal?: string; hobbies?: string } = {},
) {
  await user.type(screen.getByLabelText("Your first outcome"), options.goal ?? "Learn independently");
  if (options.hobbies) await user.type(screen.getByLabelText(/Interests or hobbies/i), options.hobbies);
  for (const name of requiredDisclosureNames) {
    const checkbox = screen.getByRole("checkbox", { name });
    if (!(checkbox as HTMLInputElement).checked) await user.click(checkbox);
  }
}

describe("resumable disclosed onboarding", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("requires disclosure, asks the learner to confirm inferred interests, then persists confirmed categories", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url === "/api/onboarding/status") return json(emptyStatus);
      if (url === "/api/onboarding/interests/preview") {
        return json({
          interests: [
            { label: "baking", suggestedCategory: "cooking" },
            { label: "formula racing", suggestedCategory: "cars" },
          ],
        });
      }
      if (url === "/api/onboarding/profile") {
        return json({ ok: true, disclosureVersion: "enrollment-disclosure-2026-07-12.v2" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(await screen.findByRole("heading", { name: /Tell Codestead how you want to learn/i })).toBeInTheDocument();
    expect(document.getElementById("main-content")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("progressbar", { name: "Onboarding step 1 of 3" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByText("Learning profile").parentElement?.parentElement).toHaveAttribute("aria-current", "step");
    expect(screen.getByDisplayValue("Approved Learner")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your first outcome"), "Learn Python independently");
    await user.type(screen.getByLabelText(/Interests or hobbies/i), "baking, formula racing");
    for (const name of [
      /I am at least 18/i,
      /administrator mentor visibility/i,
      /external AI routing/i,
      /allow NVIDIA NIM/i,
      /server code execution/i,
      /retention and backups/i,
      /generic inactivity notices/i,
    ]) await user.click(screen.getByRole("checkbox", { name }));
    await user.click(screen.getByRole("button", { name: /Save and secure account/i }));

    expect(await screen.findByRole("heading", { name: /Did Codestead understand your interests/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Category for baking")).toHaveValue("cooking");
    expect(screen.getByLabelText("Category for formula racing")).toHaveValue("cars");
    await user.selectOptions(screen.getByLabelText("Category for formula racing"), "sports");
    await user.click(screen.getByRole("checkbox", { name: /these categories describe what I meant/i }));
    await user.click(screen.getByRole("button", { name: /Confirm and secure account/i }));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/onboarding/profile")).toBe(true));
    expect(await screen.findByRole("heading", { name: /Protect your progress/i })).toBeInTheDocument();
    const preview = calls.find((call) => call.url === "/api/onboarding/interests/preview");
    expect(preview?.body).toEqual({ labels: ["baking", "formula racing"] });
    const profile = calls.find((call) => call.url === "/api/onboarding/profile");
    expect(profile?.body).toMatchObject({
      disclosureVersion: "enrollment-disclosure-2026-07-12.v2",
      acknowledgements: {
        adult18Plus: true,
        mentorVisibility: true,
        externalAiRouting: true,
        serverCodeExecution: true,
        retentionPolicy: true,
        inactivityMentorNotice: true,
        nvidiaNimProvider: true,
      },
      hobbies: [
        { label: "baking", category: "cooking", confirmed: true },
        { label: "formula racing", category: "sports", confirmed: true },
      ],
      preferredSessionMinutes: 30,
      weeklyGoalMinutes: 180,
      selectedTracks: ["programming-foundations", "python"],
    });
    expect(String(profile?.body?.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("resumes persisted profile values and current disclosure decisions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ...emptyStatus,
      profile: {
        selfReportedLevel: "intermediate",
        preferredSessionMinutes: 45,
        weeklyGoalMinutes: 300,
        analogyFrequency: "neutral",
        analogyInterests: [{ label: "cricket" }],
        learningGoals: ["Prepare for college exams"],
        selectedTracks: ["java", "dsa"],
        dsaLanguage: "java",
      },
      consents: {
        adult_18_plus: { decision: "accepted", policyVersion: "enrollment-disclosure-2026-07-12.v2" },
        mentor_visibility: { decision: "accepted", policyVersion: "enrollment-disclosure-2026-07-12.v2" },
      },
    })));
    render(<OnboardingWizard />);
    expect(await screen.findByDisplayValue("Prepare for college exams")).toBeInTheDocument();
    expect(screen.getByLabelText("Typical study session")).toHaveValue("45");
    expect(screen.getByLabelText("Weekly learning goal")).toHaveValue("300");
    await waitFor(() => expect(screen.getByText(/^Java$/, { selector: "strong" }).closest("button")).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByLabelText(/DSA implementation language/i)).toHaveValue("java");
    expect(screen.getByRole("checkbox", { name: /I am at least 18/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /administrator mentor visibility/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /external AI routing/i })).not.toBeChecked();
  });

  it("completes authenticator setup and validates the mandatory NIM credential", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    mocks.enableMfa.mockResolvedValue({
      data: {
        totpURI: "otpauth://totp/Codestead:learner?secret=TESTSECRET",
        backupCodes: ["backup-one", "backup-two"],
      },
      error: null,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url === "/api/onboarding/status") {
        return json({
          ...emptyStatus,
          requirements: { profileComplete: true, mfaEnabled: false, mfaFresh: false, nimActive: false },
        });
      }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === "/api/credentials") return json({ credential: { status: "active" } }, { status: 201 });
      if (url === "/api/onboarding/complete") return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<OnboardingWizard />);
    expect(await screen.findByRole("heading", { name: "Protect your progress." })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Current password/i), "current-password");
    await user.click(screen.getByRole("button", { name: /Set up authenticator/i }));
    expect(mocks.enableMfa).toHaveBeenCalledWith({ password: "current-password" });
    expect(await screen.findByAltText("Authenticator setup QR code")).toBeInTheDocument();
    expect(screen.getByText(/backup-one/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: /Verify authenticator/i }));

    expect(await screen.findByRole("heading", { name: "Connect NVIDIA NIM." })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Paste once; only the last four/i), "nvapi-test-key");
    await user.click(screen.getByRole("button", { name: /Connect NIM and start learning/i }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/learn"));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(calls.find((call) => call.url === "/api/security/fresh-mfa")?.body).toEqual({ code: "123456" });
    expect(calls.find((call) => call.url === "/api/credentials")?.body).toMatchObject({
      provider: "nvidia_nim",
      secret: "nvapi-test-key",
      preferred: true,
    });
  });

  it("requires a current authenticator code and refreshes MFA before storing a NIM credential", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url === "/api/onboarding/status") {
        return json({
          ...emptyStatus,
          requirements: { profileComplete: true, mfaEnabled: true, mfaFresh: false, nimActive: false },
        });
      }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === "/api/credentials") return json({ credential: { status: "active" } }, { status: 201 });
      if (url === "/api/onboarding/complete") return json({ ok: true, redirectTo: "/learn" });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<OnboardingWizard />);
    expect(await screen.findByRole("heading", { name: "Connect NVIDIA NIM." })).toBeInTheDocument();
    const mfaCode = screen.getByLabelText(/authenticator.*code/i);
    expect(mfaCode).toBeRequired();
    expect(mfaCode).toHaveAttribute("name", "mfaCode");
    await user.type(mfaCode, "654321");
    await user.type(screen.getByPlaceholderText(/Paste once; only the last four/i), "nvapi-test-key");
    await user.click(screen.getByRole("button", { name: /Connect NIM and start learning/i }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/learn"));
    const securityCall = calls.findIndex((call) => call.url === "/api/security/fresh-mfa");
    const credentialCall = calls.findIndex((call) => call.url === "/api/credentials");
    expect(securityCall).toBeGreaterThan(-1);
    expect(credentialCall).toBeGreaterThan(securityCall);
    expect(calls[securityCall]?.body).toEqual({ code: "654321" });
  });

  it("does not send the NIM credential when inline MFA verification fails", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/onboarding/status") {
        return json({
          ...emptyStatus,
          requirements: { profileComplete: true, mfaEnabled: true, mfaFresh: false, nimActive: false },
        });
      }
      if (url === "/api/security/fresh-mfa") {
        return json({ error: "That authenticator code was not accepted." }, { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<OnboardingWizard />);
    expect(await screen.findByRole("heading", { name: "Connect NVIDIA NIM." })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/authenticator.*code/i), "123456");
    await user.type(screen.getByPlaceholderText(/Paste once; only the last four/i), "nvapi-test-key");
    await user.click(screen.getByRole("button", { name: /Connect NIM and start learning/i }));

    expect(await screen.findByText("That authenticator code was not accepted.")).toBeInTheDocument();
    expect(calls).not.toContain("/api/credentials");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps the learner on NIM setup and requests a new code when MFA expires during credential storage", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/onboarding/status") {
        return json({
          ...emptyStatus,
          requirements: { profileComplete: true, mfaEnabled: true, mfaFresh: false, nimActive: false },
        });
      }
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === "/api/credentials") {
        return json({
          code: "FRESH_MFA_REQUIRED",
          error: "Verify your authenticator before changing provider credentials.",
        }, { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<OnboardingWizard />);
    expect(await screen.findByRole("heading", { name: "Connect NVIDIA NIM." })).toBeInTheDocument();
    const keyInput = screen.getByPlaceholderText(/Paste once; only the last four/i);
    await user.type(screen.getByLabelText(/authenticator.*code/i), "654321");
    await user.type(keyInput, "nvapi-test-key");
    await user.click(screen.getByRole("button", { name: /Connect NIM and start learning/i }));

    expect(await screen.findByText(/five-minute authenticator window expired/i)).toBeInTheDocument();
    expect(screen.getByText(/key was not stored/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connect NVIDIA NIM." })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Paste once; only the last four/i)).toHaveValue("nvapi-test-key");
    expect(screen.getByLabelText(/authenticator.*code/i)).toBeInTheDocument();
    expect(calls.filter((url) => url === "/api/credentials")).toHaveLength(1);
    expect(calls).not.toContain("/api/onboarding/complete");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("preserves every completed profile field when returning from interest confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/onboarding/status") return json(emptyStatus);
      if (url === "/api/onboarding/interests/preview") {
        return json({ interests: [{ label: "formula racing", suggestedCategory: "cars" }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(await screen.findByRole("heading", { name: /Tell Codestead how you want to learn/i })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Your name"));
    await user.type(screen.getByLabelText("Your name"), "Preserved Learner");
    await user.selectOptions(screen.getByLabelText("Starting point"), "intermediate");
    await user.selectOptions(screen.getByLabelText("Typical study session"), "45");
    await user.selectOptions(screen.getByLabelText("Weekly learning goal"), "300");
    await user.selectOptions(screen.getByLabelText("Analogy style"), "frequent");
    await completeRequiredProfile(user, { goal: "Master reliable systems", hobbies: "formula racing" });
    const dsaTrack = screen.getByText(/^DSA$/, { selector: "strong" }).closest("button");
    expect(dsaTrack).not.toBeNull();
    await user.click(dsaTrack!);
    await user.selectOptions(screen.getByLabelText(/DSA implementation language/i), "java");
    await user.click(screen.getByRole("button", { name: /Save and secure account/i }));

    expect(await screen.findByRole("heading", { name: /Did Codestead understand your interests/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Back and edit/i }));

    expect(screen.getByLabelText("Your name")).toHaveValue("Preserved Learner");
    expect(screen.getByLabelText("Starting point")).toHaveValue("intermediate");
    expect(screen.getByLabelText("Your first outcome")).toHaveValue("Master reliable systems");
    expect(screen.getByLabelText("Typical study session")).toHaveValue("45");
    expect(screen.getByLabelText("Weekly learning goal")).toHaveValue("300");
    expect(screen.getByLabelText(/Interests or hobbies/i)).toHaveValue("formula racing");
    expect(screen.getByLabelText("Analogy style")).toHaveValue("frequent");
    expect(screen.getByLabelText(/DSA implementation language/i)).toHaveValue("java");
    expect(screen.getByText(/^DSA$/, { selector: "strong" }).closest("button")).toHaveAttribute("aria-pressed", "true");
    for (const name of requiredDisclosureNames) expect(screen.getByRole("checkbox", { name })).toBeChecked();
  });

  it("gates the form behind an explicit retry when initial status loading fails", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/onboarding/status") throw new Error("Unexpected request");
      attempts += 1;
      if (attempts === 1) throw new TypeError("network unavailable");
      return json(emptyStatus);
    }));
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load your saved onboarding progress/i);
    expect(screen.queryByLabelText("Your first outcome")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Retry loading setup/i }));

    expect(await screen.findByRole("heading", { name: /Tell Codestead how you want to learn/i })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("releases the profile button after malformed preview and profile responses", async () => {
    let previewMalformed = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/onboarding/status") return json(emptyStatus);
      if (url === "/api/onboarding/interests/preview" && previewMalformed) {
        previewMalformed = false;
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/onboarding/profile") return json([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(await screen.findByRole("heading", { name: /Tell Codestead how you want to learn/i })).toBeInTheDocument();
    await completeRequiredProfile(user, { hobbies: "baking" });
    await user.click(screen.getByRole("button", { name: /Save and secure account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not categorize.*try again/i);
    expect(screen.getByRole("button", { name: /Save and secure account/i })).toBeEnabled();

    await user.clear(screen.getByLabelText(/Interests or hobbies/i));
    await user.click(screen.getByRole("button", { name: /Save and secure account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/profile could not be saved.*try again/i);
    expect(screen.getByRole("button", { name: /Save and secure account/i })).toBeEnabled();
  });

  it("releases authenticator actions after rejected and malformed operations", async () => {
    mocks.enableMfa.mockRejectedValueOnce(new TypeError("transport rejected"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/onboarding/status") {
        return json({
          ...emptyStatus,
          requirements: { profileComplete: true, mfaEnabled: false, mfaFresh: false, nimActive: false },
        });
      }
      if (url === "/api/security/fresh-mfa") {
        return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(await screen.findByRole("heading", { name: "Protect your progress." })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Set up authenticator/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not begin authenticator setup.*try again/i);
    expect(screen.getByRole("button", { name: /Set up authenticator/i })).toBeEnabled();

    mocks.enableMfa.mockResolvedValueOnce({
      data: { totpURI: "otpauth://totp/Codestead:learner?secret=TESTSECRET", backupCodes: [] },
      error: null,
    });
    await user.click(screen.getByRole("button", { name: /Set up authenticator/i }));
    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: /Verify authenticator/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be verified.*try again/i);
    expect(screen.getByRole("button", { name: /Verify authenticator/i })).toBeEnabled();
  });

  it("releases the NIM action when completion returns malformed data", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/onboarding/status") {
        return json({
          ...emptyStatus,
          requirements: { profileComplete: true, mfaEnabled: true, mfaFresh: true, nimActive: false },
        });
      }
      if (url === "/api/credentials") return json({ credential: { status: "active" } }, { status: 201 });
      if (url === "/api/onboarding/complete") {
        return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<OnboardingWizard />);

    expect(await screen.findByRole("heading", { name: "Connect NVIDIA NIM." })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Paste once; only the last four/i), "nvapi-test-key");
    await user.click(screen.getByRole("button", { name: /Connect NIM and start learning/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not continue.*try again/i);
    expect(screen.getByRole("button", { name: /Connect NIM and start learning/i })).toBeEnabled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
