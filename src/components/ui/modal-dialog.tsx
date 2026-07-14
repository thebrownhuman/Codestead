"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type ModalDialogProps = {
  readonly backdropClassName: string;
  readonly children: React.ReactNode;
  readonly describedBy?: string;
  readonly dialogClassName: string;
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly role?: "alertdialog" | "dialog";
};

export function ModalDialog({
  backdropClassName,
  children,
  describedBy,
  dialogClassName,
  labelledBy,
  onClose,
  role = "dialog",
}: ModalDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(backdrop.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({
        element,
        ariaHidden: element.getAttribute("aria-hidden"),
        inert: element.hasAttribute("inert"),
      }));
    for (const { element } of siblings) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }

    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const initialTarget = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      ?? dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ?? dialog;
    initialTarget.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = oldOverflow;
      for (const { ariaHidden, element, inert } of siblings) {
        if (inert) element.setAttribute("inert", "");
        else element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <div
      className={backdropClassName}
      ref={backdropRef}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeRef.current();
      }}
    >
      <section
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={dialogClassName}
        ref={dialogRef}
        role={role}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}
