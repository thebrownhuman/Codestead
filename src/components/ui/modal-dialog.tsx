"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { usePathname } from "next/navigation";
import { Children, cloneElement, isValidElement, useEffect, useRef, type ReactNode } from "react";

type ModalDialogProps = {
  readonly backdropClassName: string;
  readonly children: ReactNode;
  readonly describedBy?: string;
  readonly dialogClassName: string;
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly role?: "alertdialog" | "dialog";
  /** Session/exam gates remain server-locked and cannot be dismissed. */
  readonly dismissible?: boolean;
  readonly asChild?: boolean;
};

// Reuse existing visible headings and descriptions as Radix's labels.
function labels(children: ReactNode, title: string, description?: string): ReactNode {
  const labelled = Children.map(children, (child) => {
    if (!isValidElement<{ id?: string; children?: ReactNode }>(child)) return child;
    const content = cloneElement(child, { children: labels(child.props.children, title, description) });
    if (child.props.id === title) return <Dialog.Title asChild>{content}</Dialog.Title>;
    if (description && child.props.id === description) return <Dialog.Description asChild>{content}</Dialog.Description>;
    return content;
  });
  // Components such as Field accept one element rather than an array. Keep
  // that child shape when decorating their existing visible labels.
  return Array.isArray(children) ? labelled : labelled?.[0] ?? null;
}

export function ModalDialog({ backdropClassName, children, describedBy, dialogClassName, labelledBy, onClose, role = "dialog", dismissible = true, asChild = false }: ModalDialogProps) {
  const labelled = labels(asChild ? Children.only(children) : children, labelledBy, describedBy);
  const pathname = usePathname();
  const initialPath = useRef(pathname);
  const trigger = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (pathname !== initialPath.current) closeRef.current();
  }, [pathname]);
  useEffect(() => {
    const close = () => closeRef.current();
    // Also accept app-wide Escape dispatches; ordinary focused key events are
    // handled by Radix's topmost dismissable layer.
    const escape = (event: KeyboardEvent) => {
      if (dismissible && event.key === "Escape" && !(event.target instanceof Node) && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("pagehide", close);
    window.addEventListener("popstate", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pagehide", close);
      window.removeEventListener("popstate", close);
      window.removeEventListener("keydown", escape);
    };
  }, [dismissible]);

  return <Dialog.Root key={labelledBy} open onOpenChange={(open) => { if (!open && dismissible) closeRef.current(); }}>
    <Dialog.Portal>
      <Dialog.Overlay asChild>
        <div className={backdropClassName} role="presentation" onMouseDown={(event) => {
          if (dismissible && event.currentTarget === event.target) closeRef.current();
        }}>
          <Dialog.Content
            asChild={asChild}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            aria-modal="true"
            className={dialogClassName}
            role={role}
            onOpenAutoFocus={(event) => {
              trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              const target = (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-dialog-initial-focus]");
              if (target) { event.preventDefault(); target.focus(); }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (trigger.current?.isConnected) trigger.current.focus();
            }}
            onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault(); }}
            onInteractOutside={(event) => { if (!dismissible) event.preventDefault(); }}
          >
            {asChild ? Children.toArray(labelled)[0] : labelled}
          </Dialog.Content>
        </div>
      </Dialog.Overlay>
    </Dialog.Portal>
  </Dialog.Root>;
}
