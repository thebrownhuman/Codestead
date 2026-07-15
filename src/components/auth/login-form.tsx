"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { openBrowserOutbox } from "@/lib/browser-durability/indexed-db";
import {
  purgeBrowserRecoveryData,
  withBrowserRecoveryRepository,
} from "@/lib/browser-durability/lifecycle";
import styles from "./auth.module.css";

type LoginGateState = "checking" | "cleaning" | "ready" | "session-error" | "cleanup-error";

export function LoginForm() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<LoginGateState>("checking");
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const gateGenerationRef = useRef(0);

  const resumeExistingSession = useCallback(async () => {
    try {
      const current = await authClient.getSession();
      if (current.error || !current.data?.session) return false;
      // The protected layout sends pending accounts to onboarding and
      // incomplete MFA sessions to their challenge, so this is the one safe
      // resume target for every authenticated account state.
      router.replace("/learn");
      return true;
    } catch {
      return false;
    }
  }, [router]);

  const cleanAnonymousRecovery = useCallback(async (generation: number) => {
    if (gateGenerationRef.current !== generation) return;
    setGate("cleaning");
    try {
      await withBrowserRecoveryRepository(openBrowserOutbox, (repository) => (
        purgeBrowserRecoveryData({
          sessionStorage: window.sessionStorage,
          localStorage: window.localStorage,
          repository,
        })
      ));
      if (gateGenerationRef.current === generation) setGate("ready");
    } catch {
      if (gateGenerationRef.current === generation) setGate("cleanup-error");
    }
  }, []);

  const decideLoginGate = useCallback(async () => {
    const generation = gateGenerationRef.current + 1;
    gateGenerationRef.current = generation;
    setGate("checking");
    try {
      const current = await authClient.getSession();
      if (gateGenerationRef.current !== generation) return;
      if (current.error) {
        setGate("session-error");
        return;
      }
      if (current.data?.session) {
        router.replace("/learn");
        return;
      }
      await cleanAnonymousRecovery(generation);
    } catch {
      if (gateGenerationRef.current === generation) setGate("session-error");
    }
  }, [cleanAnonymousRecovery, router]);

  const retryCleanup = useCallback(() => {
    const generation = gateGenerationRef.current + 1;
    gateGenerationRef.current = generation;
    void cleanAnonymousRecovery(generation);
  }, [cleanAnonymousRecovery]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void decideLoginGate();
    });

    // Back/forward cache restores do not remount React, so check again when a
    // signed-in user returns to this page with the browser Back button.
    const handlePageShow = () => {
      void decideLoginGate();
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      active = false;
      gateGenerationRef.current += 1;
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [decideLoginGate]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const result = await authClient.signIn.email({
        email: String(data.get("email")),
        password: String(data.get("password")),
        rememberMe: data.get("remember") === "on",
      });
      if (result.error) {
        const duplicateSession =
          result.error.code === "FAILED_TO_CREATE_SESSION" ||
          result.error.message === "Failed to create session";
        if (duplicateSession && await resumeExistingSession()) return;
        setError(result.error.message ?? "We could not sign you in.");
        return;
      }
      if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        router.push("/two-factor");
        return;
      }
      router.push("/onboarding");
      router.refresh();
    } catch {
      setError("Sign-in is temporarily unavailable. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  async function google() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({ provider: "google", callbackURL: "/two-factor" });
      if (result?.error) {
        setError(result.error.message ?? "Google sign-in is not available.");
      }
    } catch {
      setError("Google sign-in is temporarily unavailable. Check your connection and try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  if (gate === "checking" || gate === "cleaning") {
    return (
      <div className={styles.form} role="status">
        {gate === "checking"
          ? "Checking this browser's session..."
          : "Cleaning private browser recovery storage..."}
      </div>
    );
  }
  if (gate === "session-error") {
    return (
      <div className={styles.form} role="alert">
        <p>Codestead could not confirm whether this browser is signed in. Saved browser work was kept.</p>
        <button className="button button-secondary" onClick={() => void decideLoginGate()} type="button">Retry session check</button>
      </div>
    );
  }
  if (gate === "cleanup-error") {
    return (
      <div className={styles.form} role="alert">
        <p>Codestead could not clean private browser recovery storage. Retry, or clear this site&apos;s browser data before signing in.</p>
        <button className="button button-secondary" onClick={retryCleanup} type="button">Retry browser storage cleanup</button>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.field}>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
      </div>
      <div className={styles.field}>
        <div className={styles.formRow}><label htmlFor="password">Password</label><Link className={styles.link} href="/forgot-password">Forgot password?</Link></div>
        <div className={styles.passwordWrap}>
          <input id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" required minLength={12} />
          <button type="button" aria-label={visible ? "Hide password" : "Show password"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
        </div>
      </div>
      <label className={styles.check}><input name="remember" type="checkbox" defaultChecked /> Keep me signed in on this device for 30 days</label>
      <button className={`button button-primary ${styles.submit}`} disabled={busy} type="submit"><LogIn size={18} /> {busy ? "Signing in…" : "Sign in"}</button>
      <div className={styles.divider}>or</div>
      <button className={`button button-secondary ${styles.googleButton}`} disabled={busy} type="button" onClick={google}>G&nbsp; Continue with Google</button>
      <p className={styles.footLink}>Cannot reach the only approved browser profile? <Link href="/lost-device">Request lost-device help</Link></p>
      <p className={styles.footLink}>New to this private cohort? <Link href="/request-access">Request access</Link></p>
    </form>
  );
}
