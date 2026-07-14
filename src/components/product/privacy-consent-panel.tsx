"use client";

import { useCallback, useEffect, useState } from "react";

import styles from "./product-pages.module.css";

type ConsentDecision = "accepted" | "withdrawn";

type Disclosure = {
  purpose: string;
  title: string;
  summary: string;
};

type OptionalPurpose = {
  purpose: string;
  dataCategories: string[];
};

type CurrentConsent = {
  decision: ConsentDecision;
  policyVersion: string;
  dataCategories: string[];
  occurredAt: string;
  currentVersionAccepted: boolean;
};

type ConsentSnapshot = {
  policyVersion: string;
  requiredDisclosures: Disclosure[];
  optionalPurposes: OptionalPurpose[];
  current: Record<string, CurrentConsent>;
};

const purposeCopy: Record<string, { title: string; summary: string }> = {
  cohort_profile: {
    title: "Cohort profile",
    summary: "Share only your public alias, selected badges and projects, and streak with other learners.",
  },
  leaderboard: {
    title: "Leaderboard",
    summary: "Include your public alias, capped learning points, and streak in cohort rankings.",
  },
  admin_fallback_ai: {
    title: "Administrator-funded AI fallback",
    summary: "Allow future tutor requests to use a named-model administrator key only after your own providers fail, under a time, token, and rupee cap you can withdraw at any time.",
  },
  "provider:nvidia_nim": {
    title: "NVIDIA NIM routing",
    summary: "Allow future tutor requests to route the disclosed bounded context to NVIDIA NIM.",
  },
  "provider:openrouter": {
    title: "OpenRouter routing",
    summary: "Allow future tutor requests to route the disclosed bounded context through OpenRouter.",
  },
  "provider:google": {
    title: "Google Gemini routing",
    summary: "Allow future tutor requests to route the disclosed bounded context to Google Gemini.",
  },
  "provider:openai": {
    title: "OpenAI routing",
    summary: "Allow future tutor requests to route the disclosed bounded context to OpenAI.",
  },
  "provider:anthropic": {
    title: "Anthropic routing",
    summary: "Allow future tutor requests to route the disclosed bounded context to Anthropic.",
  },
  "provider:deepseek": {
    title: "DeepSeek routing",
    summary: "Allow future tutor requests to route the disclosed bounded context to DeepSeek.",
  },
  "provider:custom_openai_compatible": {
    title: "Custom compatible-provider routing",
    summary: "Allow future tutor requests to route the disclosed bounded context to the configured compatible provider.",
  },
};

function fallbackPurposeCopy(purpose: string) {
  const provider = purpose.startsWith("provider:")
    ? purpose.slice("provider:".length).replaceAll("_", " ")
    : purpose.replaceAll("_", " ");
  return {
    title: `${provider} consent`,
    summary: `Allow this purpose for future processing under the current disclosure version.`,
  };
}

function safeError(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

async function responseBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<unknown>;
}

export function PrivacyConsentPanel() {
  const [snapshot, setSnapshot] = useState<ConsentSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPurpose, setBusyPurpose] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/privacy/consents", {
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    const body = await responseBody(response);
    if (!response.ok) {
      throw new Error(safeError(body, "Privacy choices could not be loaded."));
    }
    setSnapshot(body as ConsentSnapshot);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/privacy/consents", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await responseBody(response);
        if (!response.ok) {
          throw new Error(safeError(body, "Privacy choices could not be loaded."));
        }
        return body as ConsentSnapshot;
      })
      .then((body) => setSnapshot(body))
      .catch((failure: unknown) => {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        setError(failure instanceof Error ? failure.message : "Privacy choices could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  function accepted(purpose: string, source = snapshot) {
    return source?.current[purpose]?.currentVersionAccepted === true &&
      source.current[purpose]?.decision === "accepted";
  }

  function applyDecision(purpose: string, decision: ConsentDecision) {
    setSnapshot((currentSnapshot) => {
      if (!currentSnapshot) return currentSnapshot;
      const occurredAt = new Date().toISOString();
      const next = {
        ...currentSnapshot,
        current: {
          ...currentSnapshot.current,
          [purpose]: {
            decision,
            policyVersion: currentSnapshot.policyVersion,
            dataCategories:
              currentSnapshot.optionalPurposes.find((item) => item.purpose === purpose)?.dataCategories ?? [],
            occurredAt,
            currentVersionAccepted: decision === "accepted",
          },
        },
      };
      if (purpose === "cohort_profile" && decision === "withdrawn") {
        next.current.leaderboard = {
          decision: "withdrawn",
          policyVersion: currentSnapshot.policyVersion,
          dataCategories:
            currentSnapshot.optionalPurposes.find((item) => item.purpose === "leaderboard")?.dataCategories ?? [],
          occurredAt,
          currentVersionAccepted: false,
        };
      }
      return next;
    });
  }

  async function updatePurpose(purpose: string, decision: ConsentDecision) {
    if (!snapshot || busyPurpose) return;
    if (purpose === "leaderboard" && decision === "accepted" && !accepted("cohort_profile")) {
      setError("Enable the cohort profile before joining the leaderboard.");
      return;
    }

    setBusyPurpose(purpose);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/privacy/consents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          purpose,
          decision,
          policyVersion: snapshot.policyVersion,
        }),
      });
      const body = await responseBody(response);
      if (!response.ok) {
        throw new Error(safeError(body, "The privacy choice could not be saved."));
      }

      applyDecision(purpose, decision);
      setStatus(
        purpose === "cohort_profile" && decision === "withdrawn"
          ? "Cohort profile and leaderboard consent were withdrawn for future processing."
          : `${purposeCopy[purpose]?.title ?? fallbackPurposeCopy(purpose).title} was ${decision} for future processing.`,
      );
      try {
        await load();
      } catch (refreshFailure) {
        setError(
          refreshFailure instanceof Error
            ? `The choice was saved, but its latest record could not be refreshed: ${refreshFailure.message}`
            : "The choice was saved, but its latest record could not be refreshed.",
        );
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The privacy choice could not be saved.");
    } finally {
      setBusyPurpose(null);
    }
  }

  if (loading) {
    return <p aria-live="polite" role="status">Loading privacy and consent choices…</p>;
  }

  if (!snapshot) {
    return (
      <div className={styles.form}>
        <h2>Privacy and consent</h2>
        <p className={styles.error} role="alert">{error ?? "Privacy choices could not be loaded."}</p>
        <button className="button button-secondary" onClick={() => {
          setLoading(true);
          setError(null);
          void load()
            .catch((failure: unknown) => setError(
              failure instanceof Error ? failure.message : "Privacy choices could not be loaded.",
            ))
            .finally(() => setLoading(false));
        }} type="button">Try again</button>
      </div>
    );
  }

  const cohortAccepted = accepted("cohort_profile");
  const sharing = snapshot.optionalPurposes.filter((item) =>
    item.purpose === "cohort_profile" || item.purpose === "leaderboard");
  const fallback = snapshot.optionalPurposes.filter((item) => item.purpose === "admin_fallback_ai");
  const providers = snapshot.optionalPurposes.filter((item) => item.purpose.startsWith("provider:"));

  function purposeControl(item: OptionalPurpose) {
    const copy = purposeCopy[item.purpose] ?? fallbackPurposeCopy(item.purpose);
    const isAccepted = accepted(item.purpose);
    const leaderboardBlocked = item.purpose === "leaderboard" && !cohortAccepted && !isAccepted;
    const descriptionId = `consent-${item.purpose.replaceAll(":", "-")}-description`;
    return (
      <label className={styles.consentRow} key={item.purpose}>
        <input
          aria-describedby={descriptionId}
          aria-label={copy.title}
          checked={isAccepted}
          disabled={busyPurpose !== null || leaderboardBlocked}
          onChange={(event) => void updatePurpose(
            item.purpose,
            event.currentTarget.checked ? "accepted" : "withdrawn",
          )}
          role="switch"
          type="checkbox"
        />
        <span>
          <strong>{copy.title}</strong>
          <small id={descriptionId}>{copy.summary}</small>
          <small>Data categories: {item.dataCategories.join(", ")}.</small>
          {leaderboardBlocked && <small className={styles.inlineError}>Enable the cohort profile first.</small>}
          {busyPurpose === item.purpose && <small role="status">Saving this choice…</small>}
        </span>
      </label>
    );
  }

  return (
    <>
      <div className={styles.sectionTitle}>
        <div>
          <h2>Privacy and consent</h2>
          <p>Current policy version: <code>{snapshot.policyVersion}</code></p>
        </div>
      </div>

      <div className={styles.privacyNotice}>
        <strong>Withdrawals apply to future processing.</strong>
        <span>
          Withdrawing a choice stops future optional sharing or routing. It does not erase requests already processed,
          records retained under the disclosed policy, or an encrypted provider key. Disable or delete a provider key
          separately in AI providers. No API key or secret is displayed here.
        </span>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {status && <p className={styles.success} role="status">{status}</p>}

      <section aria-labelledby="core-disclosures-title" className={styles.consentSection}>
        <h3 id="core-disclosures-title">Core service disclosures</h3>
        <p>These explain required service processing and are not optional switches.</p>
        <ul className={styles.disclosureList}>
          {snapshot.requiredDisclosures.map((disclosure) => (
            <li key={disclosure.purpose}>
              <span>
                <strong>{disclosure.title}</strong>
                <small>{disclosure.summary}</small>
              </span>
              <span className="pill">
                {snapshot.current[disclosure.purpose]?.currentVersionAccepted ? "acknowledged" : "review required"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <fieldset className={styles.consentSection}>
        <legend>Cohort sharing</legend>
        <p>Both choices are private by default. Leaderboard participation requires an enabled cohort profile.</p>
        <div className={styles.consentGrid}>{sharing.map(purposeControl)}</div>
      </fieldset>

      <fieldset className={styles.consentSection}>
        <legend>Administrator-funded AI</legend>
        <p>This does not grant unlimited use; administrator limits and revocation still apply.</p>
        <div className={styles.consentGrid}>{fallback.map(purposeControl)}</div>
      </fieldset>

      <fieldset className={styles.consentSection}>
        <legend>External AI providers</legend>
        <p>Each destination is independent. Stored key availability never overrides a withdrawn routing choice.</p>
        <div className={styles.consentGrid}>{providers.map(purposeControl)}</div>
      </fieldset>
    </>
  );
}
