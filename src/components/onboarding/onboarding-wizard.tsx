"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { authClient } from "@/lib/auth-client";
import styles from "./onboarding.module.css";

const tracks = [
  ["programming-foundations", "Foundations", "How programs, values, logic, debugging, and tools work"],
  ["c", "C", "C23 fundamentals, memory, pointers, modular programs"],
  ["cpp", "C++", "Modern C++, RAII, STL, classes, generic programming"],
  ["java", "Java", "JDK 21, OOP, collections, generics, streams, testing"],
  ["python", "Python", "Python 3.14, data, functions, modules, OOP, async basics"],
  ["html", "HTML", "Semantic and accessible web documents and forms"],
  ["css", "CSS", "Cascade, layouts, responsive and accessible styling"],
  ["javascript", "JavaScript", "Language, browser, DOM, async, HTTP, testing"],
  ["react", "React", "Components, state, hooks, routing, data, tests"],
  ["dsa", "DSA", "Complexity through arrays, trees, graphs, DP, and more"],
  ["git-tooling", "Git & tooling", "Terminal, Git, debugging, builds, collaboration"],
  ["ai", "AI foundations", "ML, neural nets, GenAI, RAG, agents, evaluation, risk"],
] as const;

const disclosureVersion = "enrollment-disclosure-2026-07-12.v2";
const interestCategories = ["cooking", "cars", "games", "sports", "music", "art", "travel", "technology", "everyday-life"] as const;

type Requirements = { profileComplete: boolean; mfaEnabled: boolean; mfaFresh: boolean; nimActive: boolean };
type ExistingProfile = {
  selfReportedLevel: string;
  preferredSessionMinutes: number;
  weeklyGoalMinutes: number;
  analogyFrequency: string;
  analogyInterests: Array<{ label: string }>;
  learningGoals: string[];
  selectedTracks: string[];
  dsaLanguage: string | null;
};
type ConsentSnapshot = Record<string, { decision: string; policyVersion: string }>;
type InterestPreview = { label: string; category: string };
type ProfileDraft = {
  requestId: string;
  disclosureVersion: string;
  acknowledgements: {
    adult18Plus: boolean;
    mentorVisibility: boolean;
    externalAiRouting: boolean;
    serverCodeExecution: boolean;
    retentionPolicy: boolean;
    inactivityMentorNotice: boolean;
    nvidiaNimProvider: boolean;
  };
  optionalConsents: {
    cohortProfile: boolean;
    leaderboard: boolean;
    adminFallbackAi: boolean;
  };
  name: string;
  level: string;
  preferredSessionMinutes: number;
  weeklyGoalMinutes: number;
  goal: string;
  analogyFrequency: string;
  selectedTracks: string[];
  dsaLanguage?: string;
  timezone: string;
  hobbyLabels: string[];
};
type OnboardingStatus = {
  requirements: Requirements;
  profile: ExistingProfile | null;
  account: { name: string };
  consents: ConsentSnapshot;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRequirements(value: unknown): value is Requirements {
  return isRecord(value) &&
    typeof value.profileComplete === "boolean" &&
    typeof value.mfaEnabled === "boolean" &&
    typeof value.mfaFresh === "boolean" &&
    typeof value.nimActive === "boolean";
}

function isExistingProfile(value: unknown): value is ExistingProfile | null {
  if (value === null) return true;
  return isRecord(value) &&
    typeof value.selfReportedLevel === "string" &&
    typeof value.preferredSessionMinutes === "number" &&
    typeof value.weeklyGoalMinutes === "number" &&
    typeof value.analogyFrequency === "string" &&
    Array.isArray(value.analogyInterests) &&
    value.analogyInterests.every((interest) => isRecord(interest) && typeof interest.label === "string") &&
    Array.isArray(value.learningGoals) && value.learningGoals.every((goal) => typeof goal === "string") &&
    Array.isArray(value.selectedTracks) && value.selectedTracks.every((track) => typeof track === "string") &&
    (value.dsaLanguage === null || typeof value.dsaLanguage === "string");
}

function isConsentSnapshot(value: unknown): value is ConsentSnapshot {
  return isRecord(value) && Object.values(value).every((consent) =>
    isRecord(consent) && typeof consent.decision === "string" && typeof consent.policyVersion === "string");
}

function parseOnboardingStatus(value: unknown): OnboardingStatus | null {
  if (!isRecord(value) || !isRequirements(value.requirements) ||
      !isExistingProfile(value.profile) || !isRecord(value.account) ||
      typeof value.account.name !== "string" || !isConsentSnapshot(value.consents)) return null;
  return {
    requirements: value.requirements,
    profile: value.profile,
    account: { name: value.account.name },
    consents: value.consents,
  };
}

async function readJsonObject(response: Response) {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("Malformed response");
  return value;
}

function responseError(value: Record<string, unknown>, fallback: string) {
  return typeof value.error === "string" ? value.error : fallback;
}

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [statusState, setStatusState] = useState<"loading" | "ready" | "error" | "redirecting">("loading");
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(["programming-foundations", "python"]);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [requirements, setRequirements] = useState<Requirements>({ profileComplete: false, mfaEnabled: false, mfaFresh: false, nimActive: false });
  const [existingProfile, setExistingProfile] = useState<ExistingProfile | null>(null);
  const [accountName, setAccountName] = useState("");
  const [consents, setConsents] = useState<ConsentSnapshot>({});
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);
  const [interestPreview, setInterestPreview] = useState<InterestPreview[]>([]);
  const [interestConfirmationOpen, setInterestConfirmationOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      try {
        const response = await fetch("/api/onboarding/status", { cache: "no-store" });
        if (response.status === 401) {
          if (!cancelled) setStatusState("redirecting");
          router.replace("/login");
          return;
        }
        if (!response.ok) throw new Error("Status request failed");
        const result = parseOnboardingStatus(await response.json());
        if (!result) throw new Error("Malformed onboarding status");
        if (cancelled) return;
        setRequirements(result.requirements);
        setExistingProfile(result.profile);
        setAccountName(result.account.name);
        setConsents(result.consents);
        if (result.profile?.selectedTracks.length) setSelected(result.profile.selectedTracks);
        setStep(!result.requirements.profileComplete ? 1 : !result.requirements.mfaEnabled ? 2 : 3);
        setStatusState("ready");
      } catch {
        if (!cancelled) setStatusState("error");
      }
    }
    void loadStatus();
    return () => { cancelled = true; };
  }, [router, statusAttempt]);

  useEffect(() => {
    if (!totpUri) return;
    QRCode.toDataURL(totpUri, { width: 220, margin: 1, errorCorrectionLevel: "M" })
      .then(setQr)
      .catch(() => setError("Could not draw the authenticator QR code."));
  }, [totpUri]);

  const progress = useMemo(() => `${Math.round((step / 3) * 100)}%`, [step]);
  const accepted = (purpose: string) => consents[purpose]?.decision === "accepted" && consents[purpose]?.policyVersion === disclosureVersion;

  async function persistProfile(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await readJsonObject(response);
      if (!response.ok) {
        setError(responseError(result, "Please review your profile."));
        return;
      }
      if (result.ok !== true) throw new Error("Malformed profile response");
      setProfileDraft(null);
      setInterestPreview([]);
      setInterestConfirmationOpen(false);
      setRequirements((current) => ({ ...current, profileComplete: true }));
      setStep(2);
    } catch {
      setError("Your profile could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const labels = String(form.get("hobbies") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const draft: ProfileDraft = {
        requestId: crypto.randomUUID(),
        disclosureVersion,
        acknowledgements: {
          adult18Plus: form.get("adult18Plus") === "on",
          mentorVisibility: form.get("mentorVisibility") === "on",
          externalAiRouting: form.get("externalAiRouting") === "on",
          serverCodeExecution: form.get("serverCodeExecution") === "on",
          retentionPolicy: form.get("retentionPolicy") === "on",
          inactivityMentorNotice: form.get("inactivityMentorNotice") === "on",
          nvidiaNimProvider: form.get("nvidiaNimProvider") === "on",
        },
        optionalConsents: {
          cohortProfile: form.get("cohortProfile") === "on",
          leaderboard: form.get("leaderboard") === "on",
          adminFallbackAi: form.get("adminFallbackAi") === "on",
        },
        name: String(form.get("name") ?? ""),
        level: String(form.get("level") ?? "beginner"),
        preferredSessionMinutes: Number(form.get("preferredSessionMinutes")),
        weeklyGoalMinutes: Number(form.get("weeklyGoalMinutes")),
        goal: String(form.get("goal") ?? ""),
        analogyFrequency: String(form.get("analogyFrequency") ?? "helpful"),
        selectedTracks: [...selected],
        dsaLanguage: selected.includes("dsa") ? String(form.get("dsaLanguage") ?? "cpp") : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
        hobbyLabels: labels,
    };
    if (!labels.length) {
      const payload = { ...draft } as Record<string, unknown>;
      delete payload.hobbyLabels;
      await persistProfile({ ...payload, hobbies: [] });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/onboarding/interests/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels }),
      });
      const result = await readJsonObject(response);
      if (!response.ok) {
        setError(responseError(result, "Codestead could not categorize those interests."));
        return;
      }
      if (!Array.isArray(result.interests) || !result.interests.every((interest) =>
        isRecord(interest) && typeof interest.label === "string" &&
        typeof interest.suggestedCategory === "string" &&
        interestCategories.includes(interest.suggestedCategory as (typeof interestCategories)[number]))) {
        throw new Error("Malformed interest preview");
      }
      setProfileDraft(draft);
      setInterestPreview(result.interests.map((interest) => ({
        label: String(interest.label),
        category: String(interest.suggestedCategory),
      })));
      setInterestConfirmationOpen(true);
    } catch {
      setError("Codestead could not categorize those interests. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmInterests(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileDraft) return;
    const payload = { ...profileDraft } as Record<string, unknown>;
    delete payload.hobbyLabels;
    await persistProfile({
      ...payload,
      hobbies: interestPreview.map((interest) => ({ ...interest, confirmed: true })),
    });
  }

  async function beginMfa(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    try {
      const result = await authClient.twoFactor.enable(password ? { password } : {});
      if (result.error) {
        setError(result.error.message ?? "Could not begin authenticator setup.");
        return;
      }
      if (!result.data || typeof result.data.totpURI !== "string" ||
          !Array.isArray(result.data.backupCodes ?? [])) {
        throw new Error("Malformed authenticator response");
      }
      setTotpUri(result.data.totpURI);
      setBackupCodes(result.data.backupCodes ?? []);
    } catch {
      setError("Could not begin authenticator setup. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmMfa(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const code = String(new FormData(event.currentTarget).get("code")).replace(/\s/g, "");
    try {
      const response = await fetch("/api/security/fresh-mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await readJsonObject(response);
      if (!response.ok) {
        setError(responseError(result, "That code was not accepted."));
        return;
      }
      if (result.ok !== true && typeof result.validUntil !== "string") {
        throw new Error("Malformed authenticator verification response");
      }
      setRequirements((current) => ({ ...current, mfaEnabled: true, mfaFresh: true }));
      setStep(3);
    } catch {
      setError("The authenticator could not be verified. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveNim(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      if (!requirements.mfaFresh) {
        const code = String(form.get("mfaCode") ?? "").replace(/\s/g, "");
        if (!/^\d{6}$/.test(code)) {
          setError("Enter the current six-digit code from your authenticator before saving the key.");
          return;
        }
        const assertion = await fetch("/api/security/fresh-mfa", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const assertionResult = await readJsonObject(assertion);
        if (!assertion.ok) {
          setRequirements((current) => ({ ...current, mfaFresh: false }));
          setError(responseError(assertionResult, "That authenticator code was not accepted. Try the current code."));
          return;
        }
        if (assertionResult.ok !== true && typeof assertionResult.validUntil !== "string") {
          throw new Error("Malformed MFA assertion response");
        }
        setRequirements((current) => ({ ...current, mfaFresh: true }));
      }
      const response = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "nvidia_nim",
          label: "My NVIDIA NIM key",
          secret: form.get("key"),
          preferred: true,
        }),
      });
      const result = await readJsonObject(response);
      if (!response.ok) {
        if (result.code === "FRESH_MFA_REQUIRED") {
          setRequirements((current) => ({ ...current, mfaFresh: false }));
          setError("Your five-minute authenticator window expired. Enter a current code and submit again; the key was not stored.");
          return;
        }
        setError(responseError(result, "The key could not be stored."));
        return;
      }
      if (!isRecord(result.credential) || result.credential.status !== "active") {
        setError("The key was encrypted, but NVIDIA did not validate it. Check the key or try again later.");
        return;
      }
      setRequirements((current) => ({ ...current, nimActive: true }));
      const complete = await fetch("/api/onboarding/complete", { method: "POST" });
      const completion = await readJsonObject(complete);
      if (!complete.ok) {
        setError(responseError(completion, "One onboarding requirement is still incomplete."));
        return;
      }
      if (completion.ok !== true) throw new Error("Malformed completion response");
      router.push(typeof completion.redirectTo === "string" ? completion.redirectTo : "/learn");
      router.refresh();
    } catch {
      setError("Onboarding could not continue. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (statusState === "loading" || statusState === "redirecting") {
    return <main aria-live="polite" className={styles.loading} id="main-content" tabIndex={-1}><LoaderCircle className={styles.spin} /> {statusState === "redirecting" ? "Returning to sign in…" : "Preparing your learning space…"}</main>;
  }

  if (statusState === "error") {
    return <main className={styles.loading} id="main-content" tabIndex={-1}>
      <p role="alert">We could not load your saved onboarding progress. Your setup has not been changed.</p>
      <button
        className="button button-primary"
        onClick={() => {
          setStatusState("loading");
          setStatusAttempt((attempt) => attempt + 1);
        }}
        type="button"
      >
        Retry loading setup
      </button>
    </main>;
  }

  return (
    <main className={styles.page} id="main-content" tabIndex={-1}>
      <header className={styles.header}>
        <BrandMark />
        <div className={styles.progressMeta}><span>Setup {step} of 3</span><div aria-label={`Onboarding step ${step} of 3`} aria-valuemax={3} aria-valuemin={1} aria-valuenow={step} role="progressbar"><i style={{ width: progress }} /></div></div>
        <span className={styles.private}><ShieldCheck size={15} /> Private onboarding</span>
      </header>
      <div className={styles.layout}>
        <aside className={styles.steps} aria-label="Onboarding progress">
          <span aria-current={step === 1 ? "step" : undefined} className={step >= 1 ? styles.currentStep : ""}><b>{requirements.profileComplete ? <Check size={16} /> : "1"}</b><span><strong>Learning profile</strong><small>Goals, interests, starting point</small></span></span>
          <i />
          <span aria-current={step === 2 ? "step" : undefined} className={step >= 2 ? styles.currentStep : ""}><b>{requirements.mfaEnabled ? <Check size={16} /> : "2"}</b><span><strong>Secure your account</strong><small>Authenticator and recovery codes</small></span></span>
          <i />
          <span aria-current={step === 3 ? "step" : undefined} className={step >= 3 ? styles.currentStep : ""}><b>{requirements.nimActive ? <Check size={16} /> : "3"}</b><span><strong>Connect your tutor</strong><small>Your mandatory NVIDIA NIM key</small></span></span>
        </aside>

        <section className={styles.stage}>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {step === 1 && (interestConfirmationOpen && profileDraft ? (
            <form className={styles.form} onSubmit={confirmInterests}>
              <span className={styles.eyebrow}><Sparkles size={15} /> Confirm personalization</span>
              <h1>Did Codestead understand your interests?</h1>
              <p>Confirm or correct each category. These interests stay private by default and only shape optional analogies.</p>
              <div className={styles.interestConfirmList}>
                {interestPreview.map((interest, index) => (
                  <label key={`${interest.label}-${index}`}>
                    <span>{interest.label}</span>
                    <select
                      aria-label={`Category for ${interest.label}`}
                      onChange={(event) => setInterestPreview((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, category: event.target.value } : item))}
                      value={interest.category}
                    >
                      {interestCategories.map((category) => <option key={category} value={category}>{category.replaceAll("-", " ")}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <label className={styles.consentItem}><input required type="checkbox" /><span><strong>Yes, these categories describe what I meant.</strong><small>Nothing is confirmed until you submit this step. You can disable analogies later.</small></span></label>
              <div className={styles.confirmActions}>
                <button className="button button-secondary" disabled={busy} onClick={() => { setError(null); setInterestConfirmationOpen(false); }} type="button">Back and edit</button>
                <button className="button button-primary" disabled={busy} type="submit">{busy ? "Saving…" : "Confirm and secure account"}<ArrowRight size={17} /></button>
              </div>
            </form>
          ) : (
            <form className={styles.form} onSubmit={saveProfile}>
              <span className={styles.eyebrow}><Sparkles size={15} /> Make it yours</span>
              <h1>Tell Codestead how you want to learn.</h1>
              <p>These choices create your first roadmap. You can extend it later; prerequisites still protect the learning order.</p>
              <div className={styles.twoColumns}>
                <label><span>Your name</span><input name="name" autoComplete="name" defaultValue={profileDraft?.name ?? accountName} placeholder="Aarav Rao" required minLength={2} /></label>
                <label><span>Starting point</span><select name="level" defaultValue={profileDraft?.level ?? existingProfile?.selfReportedLevel ?? "beginner"}><option value="beginner">Complete beginner</option><option value="some_experience">I know a few basics</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced; place me by diagnostic</option></select></label>
              </div>
              <label><span>Your first outcome</span><textarea defaultValue={profileDraft?.goal ?? existingProfile?.learningGoals[0] ?? ""} name="goal" placeholder="For example: become confident in C++ and solve college DSA questions independently." required /></label>
              <div className={styles.twoColumns}>
                <label><span>Typical study session</span><select name="preferredSessionMinutes" defaultValue={String(profileDraft?.preferredSessionMinutes ?? existingProfile?.preferredSessionMinutes ?? 30)}><option value="10">10 minutes</option><option value="20">20 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option><option value="120">120 minutes</option></select></label>
                <label><span>Weekly learning goal</span><select name="weeklyGoalMinutes" defaultValue={String(profileDraft?.weeklyGoalMinutes ?? existingProfile?.weeklyGoalMinutes ?? 180)}><option value="60">1 hour</option><option value="120">2 hours</option><option value="180">3 hours</option><option value="300">5 hours</option><option value="420">7 hours</option><option value="600">10 hours</option><option value="900">15 hours</option></select></label>
              </div>
              <div className={styles.twoColumns}>
                <label><span>Interests or hobbies <small>comma separated</small></span><input defaultValue={profileDraft?.hobbyLabels.join(", ") ?? existingProfile?.analogyInterests.map((item) => item.label).join(", ") ?? ""} name="hobbies" placeholder="cooking, cars, cricket" /></label>
                <label><span>Analogy style</span><select name="analogyFrequency" defaultValue={profileDraft?.analogyFrequency ?? existingProfile?.analogyFrequency ?? "helpful"}><option value="neutral">Neutral explanations</option><option value="helpful">Analogies when helpful</option><option value="frequent">Frequent analogies</option></select></label>
              </div>
              <fieldset className={styles.disclosureFieldset}>
                <legend>Privacy and service disclosure <small>{disclosureVersion}</small></legend>
                <p>Read and acknowledge each core boundary before learning. Optional cohort and administrator-funded AI choices remain off until you opt in and can be withdrawn later.</p>
                <label className={styles.consentItem}><input defaultChecked={profileDraft?.acknowledgements.adult18Plus ?? accepted("adult_18_plus")} name="adult18Plus" required type="checkbox" /><span><strong>I am at least 18 years old.</strong><small>No date of birth is collected.</small></span></label>
                <label className={styles.consentItem}><input defaultChecked={profileDraft?.acknowledgements.mentorVisibility ?? accepted("mentor_visibility")} name="mentorVisibility" required type="checkbox" /><span><strong>I understand administrator mentor visibility.</strong><small>The administrator can inspect progress, attempts, projects, tutor history, and operational records for mentoring. Deliberate sensitive reads are audited.</small></span></label>
                <label className={styles.consentItem}><input defaultChecked={profileDraft?.acknowledgements.externalAiRouting ?? accepted("external_ai_routing")} name="externalAiRouting" required type="checkbox" /><span><strong>I understand external AI routing.</strong><small>Bounded lesson context, preferences, relevant chat, and code I choose to discuss may go to my selected provider. Email, keys, hidden tests, and other learners are excluded.</small></span></label>
                <label className={styles.consentItem}><input defaultChecked={profileDraft?.acknowledgements.nvidiaNimProvider ?? accepted("provider:nvidia_nim")} name="nvidiaNimProvider" required type="checkbox" /><span><strong>I allow NVIDIA NIM for tutor requests.</strong><small>I can withdraw future routing later; authored lessons and deterministic grading continue without AI.</small></span></label>
                <label className={styles.consentItem}><input defaultChecked={profileDraft?.acknowledgements.serverCodeExecution ?? accepted("server_code_execution")} name="serverCodeExecution" required type="checkbox" /><span><strong>I understand server code execution.</strong><small>Submitted code and input run in isolated, network-disabled containers. Formal hidden tests remain private.</small></span></label>
                <label className={styles.consentItem}><input defaultChecked={profileDraft?.acknowledgements.retentionPolicy ?? accepted("retention_policy")} name="retentionPolicy" required type="checkbox" /><span><strong>I understand retention and backups.</strong><small>Mastery persists until deletion; raw chat/code/AI metadata normally retain 12 months, security/admin records up to 24 months, and encrypted backups age out under 7 daily / 4 weekly / 12 monthly retention.</small></span></label>
                <label className={styles.consentItem}><input defaultChecked={profileDraft?.acknowledgements.inactivityMentorNotice ?? accepted("inactivity_mentor_notice")} name="inactivityMentorNotice" required type="checkbox" /><span><strong>I understand generic inactivity notices.</strong><small>A generic learner reminder and administrator notice may be sent after 24 hours, then one final learner reminder after 72 hours. The app stays silent until meaningful learning starts a future episode. Messages omit scores, mistakes, code, chat, provider details, keys, and raw study time.</small></span></label>
                <details className={styles.optionalConsents}>
                  <summary>Optional sharing and fallback choices</summary>
                  <label className={styles.consentItem}><input defaultChecked={profileDraft?.optionalConsents.cohortProfile ?? accepted("cohort_profile")} name="cohortProfile" type="checkbox" /><span><strong>Show a private-cohort profile.</strong><small>Only alias and fields I later select; never email, exact activity, mistakes, scores, raw code/chat, or provider data.</small></span></label>
                  <label className={styles.consentItem}><input defaultChecked={profileDraft?.optionalConsents.leaderboard ?? accepted("leaderboard")} name="leaderboard" type="checkbox" /><span><strong>Join the cohort leaderboard.</strong><small>Requires cohort profile opt-in and uses capped evidence-backed points, not time or token use.</small></span></label>
                  <label className={styles.consentItem}><input defaultChecked={profileDraft?.optionalConsents.adminFallbackAi ?? accepted("admin_fallback_ai")} name="adminFallbackAi" type="checkbox" /><span><strong>Allow a capped administrator-funded AI fallback.</strong><small>Only when separately granted, token-limited and time-limited; the provider used and usage are disclosed.</small></span></label>
                </details>
              </fieldset>
              <fieldset className={styles.trackFieldset}><legend>What would you like on your roadmap?</legend><p>Select any interests. Locked prerequisites are inserted automatically.</p><div className={styles.trackGrid}>{tracks.map(([id, title, description]) => { const active = selected.includes(id); return <button aria-pressed={active} className={active ? styles.trackSelected : ""} key={id} type="button" onClick={() => setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id])}><b>{active && <Check size={14} />}</b><span><strong>{title}</strong><small>{description}</small></span></button>; })}</div></fieldset>
              {selected.includes("dsa") && <label><span>DSA implementation language</span><select name="dsaLanguage" defaultValue={profileDraft?.dsaLanguage ?? existingProfile?.dsaLanguage ?? "cpp"}><option value="c">C</option><option value="cpp">C++</option><option value="java">Java</option><option value="python">Python</option></select><small>Concept mastery transfers if you switch later; syntax skills are retested.</small></label>}
              <button className="button button-primary" disabled={busy || selected.length === 0} type="submit">{busy ? "Saving…" : "Save and secure account"}<ArrowRight size={17} /></button>
            </form>
          ))}

          {step === 2 && (
            <div className={styles.form}>
              <span className={styles.eyebrow}><ShieldCheck size={15} /> Required for everyone</span>
              <h1>Protect your progress.</h1>
              <p>Use any TOTP authenticator. The QR is generated here in your browser; it is not sent to another service.</p>
              {!totpUri ? <form className={styles.innerForm} onSubmit={beginMfa}><label><span>Current password <small>leave empty for Google-only accounts</small></span><input name="password" type="password" autoComplete="current-password" /></label><button className="button button-primary" disabled={busy} type="submit"><KeyRound size={17} /> {busy ? "Preparing…" : "Set up authenticator"}</button></form> : <form className={styles.innerForm} onSubmit={confirmMfa}><div className={styles.mfaGrid}><div className={styles.qr}>{qr ? <Image alt="Authenticator setup QR code" src={qr} width={220} height={220} unoptimized /> : <LoaderCircle className={styles.spin} />}</div><div><h2>Scan, then verify</h2><ol><li>Open your authenticator.</li><li>Scan this QR or enter the setup URI manually.</li><li>Enter the new six-digit code below.</li></ol><label><span>Verification code</span><input className={styles.otp} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label></div></div>{backupCodes.length > 0 && <details className={styles.backup}><summary>Save your recovery codes</summary><p>Store these offline. Each is single-use.</p><code>{backupCodes.join("\n")}</code></details>}<button className="button button-primary" disabled={busy} type="submit"><ShieldCheck size={17} /> {busy ? "Verifying…" : "Verify authenticator"}</button></form>}
            </div>
          )}

          {step === 3 && (
            <form className={styles.form} onSubmit={saveNim}>
              <span className={styles.eyebrow}><Sparkles size={15} /> Bring your own AI</span>
              <h1>Connect NVIDIA NIM.</h1>
              <p>Your key is encrypted before storage and is only decrypted in memory for your provider request. Authored lessons, quizzes, exams, and progress still work if the provider is unavailable.</p>
              <div className={styles.providerCard}><span className={styles.nvidiaMark}>NV</span><span><strong>NVIDIA NIM</strong><small>Required primary tutor provider</small></span><a href="https://build.nvidia.com/" target="_blank" rel="noreferrer">Create a key <ExternalLink size={14} /></a></div>
              {!requirements.mfaFresh && <label key="nim-mfa-challenge"><span>Current authenticator code</span><input className={styles.otp} name="mfaCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /><small>Credential changes require a recent authenticator check. This approval lasts five minutes.</small></label>}
              <label key="nim-api-key"><span>NVIDIA API key</span><input name="key" type="password" autoComplete="off" placeholder="Paste once; only the last four will be shown later" required minLength={8} /><small>The app makes a tiny validation request. It never writes the key to logs.</small></label>
              <div className={styles.securityNote}><ShieldCheck size={20} /><span><strong>Protected by envelope encryption</strong><small>Full reveal later requires administrator MFA, a reason, an audit event, and a notification to you.</small></span></div>
              <button className="button button-primary" disabled={busy} type="submit">{busy ? "Encrypting and validating…" : "Connect NIM and start learning"}<ArrowRight size={17} /></button>
            </form>
          )}
        </section>
      </div>
      <footer><span><CheckCircle2 size={14} /> Your preferences can be changed later</span><span>English · Accessible by keyboard · Reduced-motion aware</span></footer>
    </main>
  );
}
