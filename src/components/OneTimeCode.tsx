import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface OneTimeCodeProps {
  /** Heading of the box, for example "Invite code". */
  title: string;
  code: string;
  /** What the code is for and when it ends. */
  children?: ReactNode;
  onDismiss: () => void;
}

/**
 * Shows a secret the service returns only once (an invite code) with a copy button. The focus moves to the box when it
 * appears, so a screen reader reads it at once; once the box is closed the code cannot be shown again.
 */
export function OneTimeCode({ title, code, children, onDismiss }: OneTimeCodeProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <section className="card one-time" aria-labelledby="one-time-title">
      <h2 id="one-time-title" tabIndex={-1} ref={heading}>
        {title}
      </h2>
      <p>
        <strong>It is shown only once.</strong> Copy it now and hand it to the person who needs it; it cannot be shown again.
      </p>
      <p>
        <code className="code-value" data-testid="one-time-code">
          {code}
        </code>
      </p>
      {children}
      <div className="actions">
        <button type="button" className="button" onClick={() => void copyCode()}>
          Copy the code
        </button>
        <button type="button" className="button button-quiet" onClick={onDismiss}>
          I have saved it
        </button>
      </div>
      <p role="status" className="status">
        {copy === "copied" ? "Copied to the clipboard." : null}
        {copy === "failed" ? "The browser did not allow copying. Select the code and copy it by hand." : null}
      </p>
    </section>
  );
}
