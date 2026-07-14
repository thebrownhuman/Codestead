import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCESSIBILITY_PREFERENCES_CHANGED_EVENT,
  type AccessibilityPreferences,
} from "@/lib/preferences/accessibility-preferences";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  defineTheme: vi.fn(),
  init: vi.fn(),
  updateOptions: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange, beforeMount, onMount, theme }: { value?: string; onChange?: (value: string) => void; beforeMount?: (monaco: { editor: { defineTheme: typeof mocks.defineTheme } }) => void; onMount?: (editor: { updateOptions: typeof mocks.updateOptions }, monaco: object) => void; theme?: string }) => {
    const monaco = { editor: { defineTheme: mocks.defineTheme } };
    beforeMount?.(monaco);
    onMount?.({ updateOptions: mocks.updateOptions }, monaco);
    return <textarea aria-label="Rich practice editor" data-theme={theme} value={value} onChange={(event) => onChange?.(event.target.value)} />;
  },
  loader: { config: mocks.config, init: mocks.init },
}));

import SelfHostedMonacoEditor from "../self-hosted-monaco-editor";

function Harness() {
  const [value, setValue] = useState("print('ready')\n");
  return <SelfHostedMonacoEditor value={value} onChange={(next) => setValue(next ?? "")} />;
}

describe("self-hosted Monaco editor", () => {
  beforeEach(() => {
    mocks.init.mockReset();
    mocks.defineTheme.mockReset();
    mocks.updateOptions.mockReset();
    document.documentElement.dataset.codeEditorFont = "14";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.codeEditorFont;
  });

  it("configures the loader for same-origin assets before initialization", async () => {
    mocks.init.mockResolvedValue({});
    render(<Harness />);

    expect(mocks.config).toHaveBeenCalledWith({ paths: { vs: "/monaco/vs" } });
    expect(await screen.findByRole("textbox", { name: "Rich practice editor" })).toHaveValue("print('ready')\n");
  });

  it("uses an accessible dark theme when the caller requests Monaco dark mode", async () => {
    mocks.init.mockResolvedValue({});
    render(<SelfHostedMonacoEditor theme="vs-dark" value={"# readable comment\n"} />);

    const editor = await screen.findByRole("textbox", { name: "Rich practice editor" });
    expect(editor).toHaveAttribute("data-theme", "learncoding-dark");
    expect(mocks.defineTheme).toHaveBeenCalledWith("learncoding-dark", expect.objectContaining({
      base: "vs-dark",
      inherit: true,
      rules: [{ token: "comment", foreground: "6A9955" }],
    }));
  });

  it("falls back to an editable basic source editor when Monaco initialization fails", async () => {
    mocks.init.mockRejectedValue(new Error("loader blocked"));
    const user = userEvent.setup();
    render(<Harness />);

    expect(await screen.findByText(/reliable basic editor/i)).toBeInTheDocument();
    const fallback = screen.getByRole("textbox", { name: "Practice source code" });
    await user.clear(fallback);
    await user.type(fallback, "answer = 42");
    await waitFor(() => expect(fallback).toHaveValue("answer = 42"));
  });

  it("stops waiting for Monaco and preserves read-only state in the reliable editor", async () => {
    vi.useFakeTimers();
    mocks.init.mockReturnValue(new Promise(() => undefined));
    render(<SelfHostedMonacoEditor options={{ readOnly: true }} value={"print('safe')\n"} />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading editor/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.getByRole("status")).toHaveTextContent(/took too long.*reliable basic editor/i);
    expect(screen.getByRole("textbox", { name: "Practice source code" })).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Practice source code" })).toHaveValue("print('safe')\n");
  });

  it("applies the stored editor font and updates a mounted editor when the preference changes", async () => {
    mocks.init.mockResolvedValue({});
    document.documentElement.dataset.codeEditorFont = "18";
    render(<Harness />);

    expect(await screen.findByRole("textbox", { name: "Rich practice editor" })).toBeInTheDocument();
    expect(mocks.updateOptions).toHaveBeenCalledWith({ fontSize: 18 });

    const detail: AccessibilityPreferences = {
      textSize: "100",
      motion: "system",
      interfaceTheme: "system",
      codeEditorFont: "16",
    };
    window.dispatchEvent(new CustomEvent(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, { detail }));

    await waitFor(() => expect(mocks.updateOptions).toHaveBeenCalledWith({ fontSize: 16 }));
  });
});
