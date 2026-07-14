"use client";

import MonacoEditor, { loader, type EditorProps } from "@monaco-editor/react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  ACCESSIBILITY_PREFERENCES_CHANGED_EVENT,
  getAppliedCodeEditorFontSize,
  type AccessibilityPreferences,
} from "@/lib/preferences/accessibility-preferences";

import styles from "./lesson-workspace.module.css";

// The loader package otherwise pulls executable code from jsDelivr. Codestead
// deliberately keeps a same-origin CSP and ships the installed Monaco version.
loader.config({ paths: { vs: "/monaco/vs" } });

const EDITOR_LOAD_TIMEOUT_MS = 8_000;
const LEARNCODING_DARK_THEME = "learncoding-dark";

export default function SelfHostedMonacoEditor(props: EditorProps) {
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading");
  const [fallbackReason, setFallbackReason] = useState<"failed" | "timeout">("failed");
  const editorRef = useRef<Parameters<NonNullable<EditorProps["onMount"]>>[0] | null>(null);

  useEffect(() => {
    let mounted = true;
    let finished = false;
    const timeoutId = window.setTimeout(() => {
      if (!mounted || finished) return;
      finished = true;
      setFallbackReason("timeout");
      setState("fallback");
    }, EDITOR_LOAD_TIMEOUT_MS);
    loader.init().then(
      () => {
        if (!mounted || finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        setState("ready");
      },
      () => {
        if (!mounted || finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        setFallbackReason("failed");
        setState("fallback");
      },
    );
    return () => {
      mounted = false;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    const applyEditorFont = (event?: Event) => {
      const changed = event as CustomEvent<AccessibilityPreferences> | undefined;
      const fontSize = changed?.detail?.codeEditorFont
        ? Number(changed.detail.codeEditorFont)
        : getAppliedCodeEditorFontSize();
      editorRef.current?.updateOptions({ fontSize });
    };
    window.addEventListener(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, applyEditorFont);
    return () => window.removeEventListener(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, applyEditorFont);
  }, []);

  if (state === "loading") {
    return <div aria-live="polite" className={styles.editorLoading} role="status"><LoaderCircle className={styles.spin} /> Loading editor…</div>;
  }

  if (state === "fallback") {
    return <div className={styles.editorFallback}>
      <p aria-live="polite" role="status"><AlertTriangle size={16} /> {fallbackReason === "timeout" ? "The rich editor took too long to start" : "The rich editor could not start"}, so Codestead opened the reliable basic editor instead.</p>
      <textarea
        aria-label="Practice source code"
        onChange={(event) => props.onChange?.(event.target.value, {} as Parameters<NonNullable<EditorProps["onChange"]>>[1])}
        readOnly={Boolean(props.options?.readOnly)}
        spellCheck={false}
        style={{ fontSize: "var(--code-editor-font-size)" }}
        value={props.value ?? props.defaultValue ?? ""}
      />
    </div>;
  }

  return <MonacoEditor
    {...props}
    beforeMount={(monaco) => {
      monaco.editor.defineTheme(LEARNCODING_DARK_THEME, {
        base: "vs-dark",
        inherit: true,
        rules: [{ token: "comment", foreground: "6A9955" }],
        colors: {},
      });
      props.beforeMount?.(monaco);
    }}
    onMount={(editor, monaco) => {
      editorRef.current = editor;
      editor.updateOptions({ fontSize: getAppliedCodeEditorFontSize() });
      props.onMount?.(editor, monaco);
    }}
    theme={props.theme === "vs-dark" ? LEARNCODING_DARK_THEME : props.theme}
  />;
}
