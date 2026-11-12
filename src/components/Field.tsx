import type { ReactNode } from "react";

/** What an input needs to belong to its label, hint and error message. */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

interface FieldProps {
  id: string;
  label: string;
  /** Help shown under the field and read with it. */
  hint?: ReactNode;
  /** The reason the value is not accepted; shown in words, announced when it appears. */
  error?: string | null;
  /** The input, select or textarea: spread the props it is given. */
  children: (control: FieldControlProps) => ReactNode;
}

/** A form row: a visible label tied to its control, a hint and an error message that screen readers read with the field. */
export function Field({ id, label, hint, error, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
