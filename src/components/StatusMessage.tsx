import type { ReactNode } from "react";

/** A polite status line for work in progress; a screen reader announces it without moving the focus. */
export function StatusMessage({ children }: { children: ReactNode }) {
  return (
    <p className="status" role="status">
      {children}
    </p>
  );
}
