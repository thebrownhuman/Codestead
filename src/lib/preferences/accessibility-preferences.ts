export const ACCESSIBILITY_PREFERENCES_STORAGE_KEY =
  "learncoding.accessibility-preferences.v1";

export const ACCESSIBILITY_PREFERENCES_CHANGED_EVENT =
  "learncoding:accessibility-preferences-changed";

export const TEXT_SIZE_OPTIONS = ["100", "115", "130", "150", "200"] as const;
export const MOTION_OPTIONS = ["system", "reduce", "normal"] as const;
export const INTERFACE_THEME_OPTIONS = ["system", "light", "dark", "contrast"] as const;
export const CODE_EDITOR_FONT_OPTIONS = ["13", "14", "16", "18"] as const;

export type TextSizePreference = (typeof TEXT_SIZE_OPTIONS)[number];
export type MotionPreference = (typeof MOTION_OPTIONS)[number];
export type InterfaceThemePreference = (typeof INTERFACE_THEME_OPTIONS)[number];
export type CodeEditorFontPreference = (typeof CODE_EDITOR_FONT_OPTIONS)[number];

export type AccessibilityPreferences = {
  textSize: TextSizePreference;
  motion: MotionPreference;
  interfaceTheme: InterfaceThemePreference;
  codeEditorFont: CodeEditorFontPreference;
};

export const DEFAULT_ACCESSIBILITY_PREFERENCES: AccessibilityPreferences = Object.freeze({
  textSize: "100",
  motion: "system",
  interfaceTheme: "system",
  codeEditorFont: "14",
});

type StoredAccessibilityPreferences = AccessibilityPreferences & { version: 1 };

function includes<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && options.includes(value as T);
}

export function normalizeAccessibilityPreferences(value: unknown): AccessibilityPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
  }

  const candidate = value as Partial<AccessibilityPreferences>;
  return {
    textSize: includes(TEXT_SIZE_OPTIONS, candidate.textSize)
      ? candidate.textSize
      : DEFAULT_ACCESSIBILITY_PREFERENCES.textSize,
    motion: includes(MOTION_OPTIONS, candidate.motion)
      ? candidate.motion
      : DEFAULT_ACCESSIBILITY_PREFERENCES.motion,
    interfaceTheme: includes(INTERFACE_THEME_OPTIONS, candidate.interfaceTheme)
      ? candidate.interfaceTheme
      : DEFAULT_ACCESSIBILITY_PREFERENCES.interfaceTheme,
    codeEditorFont: includes(CODE_EDITOR_FONT_OPTIONS, candidate.codeEditorFont)
      ? candidate.codeEditorFont
      : DEFAULT_ACCESSIBILITY_PREFERENCES.codeEditorFont,
  };
}

export function parseAccessibilityPreferences(raw: string | null): AccessibilityPreferences {
  if (!raw) return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };

  try {
    return normalizeAccessibilityPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
  }
}

export function readAccessibilityPreferences(
  storage: Pick<Storage, "getItem"> | undefined =
    typeof window === "undefined" ? undefined : window.localStorage,
): AccessibilityPreferences {
  if (!storage) return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };

  try {
    return parseAccessibilityPreferences(storage.getItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
  }
}

let cachedStorageValue: string | null | undefined;
let cachedSnapshot: AccessibilityPreferences = DEFAULT_ACCESSIBILITY_PREFERENCES;

export function getAccessibilityPreferencesSnapshot(): AccessibilityPreferences {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY);
  } catch {
    raw = null;
  }

  if (raw !== cachedStorageValue) {
    cachedStorageValue = raw;
    cachedSnapshot = parseAccessibilityPreferences(raw);
  }
  return cachedSnapshot;
}

export function getServerAccessibilityPreferencesSnapshot(): AccessibilityPreferences {
  return DEFAULT_ACCESSIBILITY_PREFERENCES;
}

export function subscribeToAccessibilityPreferences(onChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ACCESSIBILITY_PREFERENCES_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, onChange);
  };
}

export function applyAccessibilityPreferences(
  preferences: AccessibilityPreferences,
  root: HTMLElement | undefined =
    typeof document === "undefined" ? undefined : document.documentElement,
) {
  if (!root) return;

  root.dataset.textSize = preferences.textSize;
  root.dataset.motion = preferences.motion;
  root.dataset.interfaceTheme = preferences.interfaceTheme;
  root.dataset.contrast = preferences.interfaceTheme === "contrast" ? "more" : "standard";
  root.dataset.codeEditorFont = preferences.codeEditorFont;
  root.style.setProperty("--user-root-font-size", `${preferences.textSize}%`);
  root.style.setProperty("--code-editor-font-size", `${preferences.codeEditorFont}px`);

  if (preferences.motion === "system") {
    delete root.dataset.reduceMotion;
  } else {
    root.dataset.reduceMotion = preferences.motion === "reduce" ? "true" : "false";
  }
}

export function writeAccessibilityPreferences(
  preferences: AccessibilityPreferences,
  storage: Pick<Storage, "setItem"> | undefined =
    typeof window === "undefined" ? undefined : window.localStorage,
) {
  if (!storage) return false;

  const stored: StoredAccessibilityPreferences = { version: 1, ...preferences };
  try {
    storage.setItem(ACCESSIBILITY_PREFERENCES_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function persistAndApplyAccessibilityPreferences(preferences: AccessibilityPreferences) {
  writeAccessibilityPreferences(preferences);
  applyAccessibilityPreferences(preferences);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AccessibilityPreferences>(ACCESSIBILITY_PREFERENCES_CHANGED_EVENT, {
        detail: preferences,
      }),
    );
  }
}

export function persistAndApplyAccessibilityPreference<
  K extends keyof AccessibilityPreferences,
>(key: K, value: AccessibilityPreferences[K]) {
  // Read at mutation time instead of merging with a React render snapshot.
  // Firefox and WebKit can deliver consecutive native select changes before
  // useSyncExternalStore has committed the prior storage notification.
  const preferences = normalizeAccessibilityPreferences({
    ...readAccessibilityPreferences(),
    [key]: value,
  });
  persistAndApplyAccessibilityPreferences(preferences);
  return preferences;
}

export function loadAndApplyAccessibilityPreferences() {
  const preferences = readAccessibilityPreferences();
  applyAccessibilityPreferences(preferences);
  return preferences;
}

export function getAppliedCodeEditorFontSize() {
  const applied = typeof document === "undefined"
    ? undefined
    : document.documentElement.dataset.codeEditorFont;
  return Number(
    includes(CODE_EDITOR_FONT_OPTIONS, applied)
      ? applied
      : readAccessibilityPreferences().codeEditorFont,
  );
}

const storageKey = JSON.stringify(ACCESSIBILITY_PREFERENCES_STORAGE_KEY);
const defaults = JSON.stringify(DEFAULT_ACCESSIBILITY_PREFERENCES);
const textSizes = JSON.stringify(TEXT_SIZE_OPTIONS);
const motions = JSON.stringify(MOTION_OPTIONS);
const themes = JSON.stringify(INTERFACE_THEME_OPTIONS);
const editorFonts = JSON.stringify(CODE_EDITOR_FONT_OPTIONS);

// This tiny, dependency-free bootstrap runs in <head> so text scale and theme
// are in place before the first paint. Every stored value is allow-listed.
export const ACCESSIBILITY_PREFERENCES_BOOTSTRAP_SCRIPT = `(() => {
  try {
    const defaults = ${defaults};
    const parsed = JSON.parse(localStorage.getItem(${storageKey}) || "null") || {};
    const pick = (allowed, value, fallback) => allowed.includes(value) ? value : fallback;
    const preferences = {
      textSize: pick(${textSizes}, parsed.textSize, defaults.textSize),
      motion: pick(${motions}, parsed.motion, defaults.motion),
      interfaceTheme: pick(${themes}, parsed.interfaceTheme, defaults.interfaceTheme),
      codeEditorFont: pick(${editorFonts}, parsed.codeEditorFont, defaults.codeEditorFont),
    };
    const root = document.documentElement;
    root.dataset.textSize = preferences.textSize;
    root.dataset.motion = preferences.motion;
    root.dataset.interfaceTheme = preferences.interfaceTheme;
    root.dataset.contrast = preferences.interfaceTheme === "contrast" ? "more" : "standard";
    root.dataset.codeEditorFont = preferences.codeEditorFont;
    root.style.setProperty("--user-root-font-size", preferences.textSize + "%");
    root.style.setProperty("--code-editor-font-size", preferences.codeEditorFont + "px");
    if (preferences.motion === "system") delete root.dataset.reduceMotion;
    else root.dataset.reduceMotion = preferences.motion === "reduce" ? "true" : "false";
  } catch {}
})();`;
