import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCESSIBILITY_PREFERENCES_STORAGE_KEY,
  readAccessibilityPreferences,
} from "@/lib/preferences/accessibility-preferences";

import { SettingsView } from "../settings-view";

describe("accessibility settings", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ credentials: [] }), {
      headers: { "content-type": "application/json" },
    })));
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps server-rendered preference controls inert until hydration attaches their handlers", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SettingsView initialTab="accessibility" />);

    const serverControls = Array.from(container.querySelectorAll("select[aria-label]"));
    expect(serverControls).toHaveLength(4);
    for (const control of serverControls) expect(control).toBeDisabled();

    const root = hydrateRoot(container, <SettingsView initialTab="accessibility" />);
    await waitFor(() => {
      for (const control of container.querySelectorAll("select[aria-label]")) {
        expect(control).toBeEnabled();
      }
    });
    await act(async () => root.unmount());
  });

  it("hydrates controlled selects from storage and persists all four applied effects", async () => {
    localStorage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      textSize: "130",
      motion: "system",
      interfaceTheme: "dark",
      codeEditorFont: "16",
    }));
    const user = userEvent.setup();

    render(<SettingsView initialTab="accessibility" />);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Text size" })).toHaveValue("130");
      expect(screen.getByRole("combobox", { name: "Text size" })).toBeEnabled();
      expect(screen.getByRole("combobox", { name: "Interface theme and contrast" })).toHaveValue("dark");
      expect(screen.getByRole("combobox", { name: "Code editor font" })).toHaveValue("16");
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "Text size" }), "200");
    await user.selectOptions(screen.getByRole("combobox", { name: "Motion" }), "reduce");
    await user.selectOptions(screen.getByRole("combobox", { name: "Interface theme and contrast" }), "contrast");
    await user.selectOptions(screen.getByRole("combobox", { name: "Code editor font" }), "18");

    expect(readAccessibilityPreferences()).toEqual({
      textSize: "200",
      motion: "reduce",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    });
    expect(document.documentElement.style.getPropertyValue("--user-root-font-size")).toBe("200%");
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
    expect(document.documentElement.dataset.contrast).toBe("more");
    expect(document.documentElement.style.getPropertyValue("--code-editor-font-size")).toBe("18px");
  });

  it("merges a change with the latest durable preferences before the store notification renders", async () => {
    render(<SettingsView initialTab="accessibility" />);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Text size" })).toHaveValue("100");
    });

    // A browser can deliver the next select event before React has committed
    // the external-store notification from the prior one. Model that window
    // by advancing durable storage without updating this render's snapshot.
    localStorage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      textSize: "200",
      motion: "system",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    }));

    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Motion" }), "reduce");

    expect(readAccessibilityPreferences()).toEqual({
      textSize: "200",
      motion: "reduce",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    });
  });

  it("marks unfinished security actions as disabled and explains their status", async () => {
    render(<SettingsView initialTab="security" />);

    const recovery = screen.getByRole("button", { name: "View recovery guidance" });
    const password = screen.getByRole("button", { name: "Change password" });
    expect(recovery).toBeDisabled();
    expect(password).toBeDisabled();
    expect(recovery).toHaveAccessibleDescription(/coming soon/i);
    expect(password).toHaveAccessibleDescription(/coming soon/i);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it("implements an arrow-key tab pattern for settings sections", async () => {
    const user = userEvent.setup();
    render(<SettingsView initialTab="accessibility" />);

    const accessibility = screen.getByRole("tab", { name: "Accessibility" });
    accessibility.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Notifications" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Notifications" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Notifications" })).toBeInTheDocument();
  });
});
