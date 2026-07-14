import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCESSIBILITY_PREFERENCES_CHANGED_EVENT,
  ACCESSIBILITY_PREFERENCES_STORAGE_KEY,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  applyAccessibilityPreferences,
  getAccessibilityPreferencesSnapshot,
  getAppliedCodeEditorFontSize,
  loadAndApplyAccessibilityPreferences,
  normalizeAccessibilityPreferences,
  parseAccessibilityPreferences,
  persistAndApplyAccessibilityPreference,
  persistAndApplyAccessibilityPreferences,
  readAccessibilityPreferences,
  subscribeToAccessibilityPreferences,
  writeAccessibilityPreferences,
} from "../accessibility-preferences";

function resetRoot() {
  const root = document.documentElement;
  delete root.dataset.textSize;
  delete root.dataset.motion;
  delete root.dataset.reduceMotion;
  delete root.dataset.interfaceTheme;
  delete root.dataset.contrast;
  delete root.dataset.codeEditorFont;
  root.style.removeProperty("--user-root-font-size");
  root.style.removeProperty("--code-editor-font-size");
}

describe("accessibility preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetRoot();
    vi.restoreAllMocks();
  });

  it("uses safe defaults for malformed and unsupported stored values", () => {
    expect(parseAccessibilityPreferences("not json")).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
    expect(parseAccessibilityPreferences(JSON.stringify({
      textSize: "500",
      motion: "spin",
      interfaceTheme: "neon",
      codeEditorFont: "72",
    }))).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
  });

  it("persists every preference and applies semantic root attributes and variables", () => {
    const changed = vi.fn();
    window.addEventListener(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, changed);

    persistAndApplyAccessibilityPreferences({
      textSize: "200",
      motion: "reduce",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    });

    expect(readAccessibilityPreferences()).toEqual({
      textSize: "200",
      motion: "reduce",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    });
    expect(JSON.parse(localStorage.getItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY) ?? "null"))
      .toMatchObject({ version: 1, textSize: "200", motion: "reduce", interfaceTheme: "contrast", codeEditorFont: "18" });
    expect(document.documentElement).toHaveAttribute("data-text-size", "200");
    expect(document.documentElement).toHaveAttribute("data-motion", "reduce");
    expect(document.documentElement).toHaveAttribute("data-reduce-motion", "true");
    expect(document.documentElement).toHaveAttribute("data-interface-theme", "contrast");
    expect(document.documentElement).toHaveAttribute("data-contrast", "more");
    expect(document.documentElement).toHaveAttribute("data-code-editor-font", "18");
    expect(document.documentElement.style.getPropertyValue("--user-root-font-size")).toBe("200%");
    expect(document.documentElement.style.getPropertyValue("--code-editor-font-size")).toBe("18px");
    expect(changed).toHaveBeenCalledTimes(1);

    window.removeEventListener(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, changed);
  });

  it("restores persisted preferences after root state is cleared", () => {
    localStorage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      textSize: "150",
      motion: "normal",
      interfaceTheme: "dark",
      codeEditorFont: "16",
    }));
    resetRoot();

    expect(loadAndApplyAccessibilityPreferences()).toEqual({
      textSize: "150",
      motion: "normal",
      interfaceTheme: "dark",
      codeEditorFont: "16",
    });
    expect(document.documentElement.dataset.textSize).toBe("150");
    expect(document.documentElement.dataset.reduceMotion).toBe("false");
    expect(document.documentElement.dataset.interfaceTheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--code-editor-font-size")).toBe("16px");
  });

  it("merges individual mutations with the latest durable preferences", () => {
    localStorage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      textSize: "200",
      motion: "system",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    }));

    expect(persistAndApplyAccessibilityPreference("motion", "reduce")).toEqual({
      textSize: "200",
      motion: "reduce",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    });
    expect(readAccessibilityPreferences()).toEqual({
      textSize: "200",
      motion: "reduce",
      interfaceTheme: "contrast",
      codeEditorFont: "18",
    });
  });

  it("does not throw when browser storage is unavailable", () => {
    const unavailableStorage = {
      getItem: () => { throw new DOMException("blocked"); },
      setItem: () => { throw new DOMException("blocked"); },
    };

    expect(readAccessibilityPreferences(unavailableStorage)).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
    expect(() => applyAccessibilityPreferences({ ...DEFAULT_ACCESSIBILITY_PREFERENCES })).not.toThrow();
    expect(writeAccessibilityPreferences(
      { ...DEFAULT_ACCESSIBILITY_PREFERENCES },
      unavailableStorage,
    )).toBe(false);
  });

  it("fails closed for invalid values and explicitly unavailable browser boundaries", () => {
    expect(normalizeAccessibilityPreferences(null)).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
    expect(normalizeAccessibilityPreferences([])).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
    expect(readAccessibilityPreferences(null as unknown as Storage)).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
    expect(writeAccessibilityPreferences(
      { ...DEFAULT_ACCESSIBILITY_PREFERENCES },
      null as unknown as Storage,
    )).toBe(false);
    expect(() => applyAccessibilityPreferences(
      { ...DEFAULT_ACCESSIBILITY_PREFERENCES },
      null as unknown as HTMLElement,
    )).not.toThrow();
  });

  it("ignores unrelated storage changes and observes matching or cleared preferences", () => {
    const changed = vi.fn();
    const unsubscribe = subscribeToAccessibilityPreferences(changed);

    window.dispatchEvent(new StorageEvent("storage", { key: "another.preference" }));
    expect(changed).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: ACCESSIBILITY_PREFERENCES_STORAGE_KEY }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(changed).toHaveBeenCalledTimes(2);

    unsubscribe();
    window.dispatchEvent(new StorageEvent("storage", { key: ACCESSIBILITY_PREFERENCES_STORAGE_KEY }));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("uses a valid applied editor font and falls back to durable storage", () => {
    document.documentElement.dataset.codeEditorFont = "18";
    expect(getAppliedCodeEditorFontSize()).toBe(18);

    document.documentElement.dataset.codeEditorFont = "99";
    localStorage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      textSize: "100",
      motion: "system",
      interfaceTheme: "system",
      codeEditorFont: "16",
    }));
    expect(getAppliedCodeEditorFontSize()).toBe(16);
  });

  it("keeps server-side preference helpers inert when browser globals do not exist", () => {
    const preferences = { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
    vi.stubGlobal("window", undefined);

    expect(readAccessibilityPreferences()).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
    expect(writeAccessibilityPreferences(preferences)).toBe(false);
    expect(() => persistAndApplyAccessibilityPreferences(preferences)).not.toThrow();
  });

  it("keeps document-dependent helpers inert during server rendering", () => {
    localStorage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      textSize: "115",
      motion: "system",
      interfaceTheme: "light",
      codeEditorFont: "13",
    }));
    vi.stubGlobal("document", undefined);

    expect(() => applyAccessibilityPreferences({ ...DEFAULT_ACCESSIBILITY_PREFERENCES })).not.toThrow();
    expect(getAppliedCodeEditorFontSize()).toBe(13);
  });

  it("returns a safe cached snapshot when storage access throws", () => {
    localStorage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      textSize: "150",
      motion: "normal",
      interfaceTheme: "dark",
      codeEditorFont: "16",
    }));
    expect(getAccessibilityPreferencesSnapshot().textSize).toBe("150");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });

    expect(getAccessibilityPreferencesSnapshot()).toEqual(DEFAULT_ACCESSIBILITY_PREFERENCES);
  });
});
