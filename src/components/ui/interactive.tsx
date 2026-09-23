"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { Button } from "./primitives";

/**
 * Client-only interactive pieces: things that need state, focus or the clipboard.
 *
 * Split from `primitives.tsx` on purpose - that file must stay importable from server
 * components, and a single "use client" directive would poison it. The rule is simple:
 * if it calls a hook or touches the DOM, it lives here.
 */

export function Modal({
  open,
  title,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-overlay flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : "Dialog"}
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-canvas/80"
      />
      <div className="panel relative w-full max-w-lg">
        <div className="panel-header">
          <span className="micro-label">{title}</span>
          <Button onClick={onClose} aria-label="Close">
            Esc
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer ? <div className="border-t border-border p-3">{footer}</div> : null}
      </div>
    </div>
  );
}
