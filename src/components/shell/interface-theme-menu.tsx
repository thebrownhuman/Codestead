"use client";

import { Check, Contrast, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  getAccessibilityPreferencesSnapshot,
  getServerAccessibilityPreferencesSnapshot,
  persistAndApplyAccessibilityPreference,
  subscribeToAccessibilityPreferences,
  type InterfaceThemePreference,
} from "@/lib/preferences/accessibility-preferences";

import styles from "./app-shell.module.css";

const themeOptions: ReadonlyArray<{
  value: InterfaceThemePreference;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { value: "system", label: "System", description: "Match this device", icon: Monitor },
  { value: "light", label: "Light", description: "Paper and forest", icon: Sun },
  { value: "dark", label: "Dark", description: "Low-light studio", icon: Moon },
  { value: "contrast", label: "High contrast", description: "Maximum separation", icon: Contrast },
];

function focusMenuItem(menu: HTMLElement | null, index: number) {
  const items = Array.from(
    menu?.querySelectorAll<HTMLElement>("[role='menuitemradio'], [role='menuitem']") ?? [],
  );
  if (items.length === 0) return;
  items[(index + items.length) % items.length]?.focus();
}

export function InterfaceThemeMenu() {
  const preferences = useSyncExternalStore(
    subscribeToAccessibilityPreferences,
    getAccessibilityPreferencesSnapshot,
    getServerAccessibilityPreferencesSnapshot,
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = themeOptions.find((option) => option.value === preferences.interfaceTheme)
    ?? themeOptions[0];
  const CurrentIcon = current.icon;

  useEffect(() => {
    if (!open) return;

    const currentIndex = themeOptions.findIndex(
      (option) => option.value === preferences.interfaceTheme,
    );
    const frame = window.requestAnimationFrame(() => {
      focusMenuItem(menuRef.current, Math.max(0, currentIndex));
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open, preferences.interfaceTheme]);

  function closeAndRestoreFocus() {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }

  function chooseTheme(theme: InterfaceThemePreference) {
    persistAndApplyAccessibilityPreference("interfaceTheme", theme);
    closeAndRestoreFocus();
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitemradio'], [role='menuitem']") ?? [],
    );
    const activeIndex = items.findIndex((item) => item === document.activeElement);

    if (event.key === "Tab") {
      // Let the browser choose the normal forward/backward Tab destination,
      // then collapse the popup without pulling focus back to its trigger.
      window.requestAnimationFrame(() => setOpen(false));
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(menuRef.current, activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(menuRef.current, activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(menuRef.current, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(menuRef.current, items.length - 1);
    }
  }

  return (
    <div
      className={styles.themeMenu}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setOpen(false);
        }
      }}
      ref={rootRef}
    >
      <button
        aria-controls="interface-theme-menu"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Interface theme: ${current.label}`}
        className={styles.iconButton}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={triggerRef}
        title={`Interface theme: ${current.label}`}
        type="button"
      >
        <CurrentIcon aria-hidden="true" size={19} />
      </button>
      {open && (
        <div
          aria-label="Choose interface theme"
          className={styles.themeDropdown}
          id="interface-theme-menu"
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          role="menu"
        >
          <span className={styles.themeMenuHeading} role="presentation">Appearance</span>
          {themeOptions.map(({ value, label, description, icon: Icon }) => {
            const selected = preferences.interfaceTheme === value;
            return (
              <button
                aria-checked={selected}
                className={selected ? styles.themeOptionActive : undefined}
                key={value}
                onClick={() => chooseTheme(value)}
                role="menuitemradio"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                <Icon aria-hidden="true" size={18} />
                <span><strong>{label}</strong><small>{description}</small></span>
                <Check aria-hidden="true" className={styles.themeCheck} size={16} />
              </button>
            );
          })}
          <Link className={styles.themeSettingsLink} href="/settings?section=accessibility" onClick={() => setOpen(false)} role="menuitem" tabIndex={-1}>
            More accessibility settings
          </Link>
        </div>
      )}
    </div>
  );
}
