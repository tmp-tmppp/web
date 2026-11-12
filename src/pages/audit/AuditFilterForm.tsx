import { useState } from "react";
import type { FormEvent } from "react";
import { AUDIT_TYPES_MAX, EMPTY_FILTERS, typesOf } from "../../api/audit";
import type { AuditFilters } from "../../api/audit";
import { Field } from "../../components/Field";

interface Errors {
  type?: string;
  from?: string;
  to?: string;
}

/** A value of a datetime-local input (the reader's time zone) as a moment with a zone, or null when it is not a date. */
function toIsoMoment(local: string): string | null {
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Checks the form and turns it into the filters of the request; the errors say what to correct. */
export function filtersFromForm(form: AuditFilters): { filters: AuditFilters; errors: Errors } {
  const errors: Errors = {};
  if (typesOf(form.type).length > AUDIT_TYPES_MAX) errors.type = `Give at most ${AUDIT_TYPES_MAX} event types.`;
  const from = form.from === "" ? "" : toIsoMoment(form.from);
  const to = form.to === "" ? "" : toIsoMoment(form.to);
  if (from === null) errors.from = "Enter a valid date and time.";
  if (to === null) errors.to = "Enter a valid date and time.";
  if (from && to && from > to) errors.to = "The end must not be before the start.";
  return { filters: { ...form, from: from ?? "", to: to ?? "" }, errors };
}

interface AuditFilterFormProps {
  onApply: (filters: AuditFilters) => void;
}

/** The filters of the audit list: all that are filled in apply together. */
export function AuditFilterForm({ onApply }: AuditFilterFormProps) {
  const [form, setForm] = useState<AuditFilters>(EMPTY_FILTERS);
  const [errors, setErrors] = useState<Errors>({});

  function set(name: keyof AuditFilters, value: string) {
    setForm((previous) => ({ ...previous, [name]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const checked = filtersFromForm(form);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length === 0) onApply(checked.filters);
  }

  function clear() {
    setForm(EMPTY_FILTERS);
    setErrors({});
    onApply(EMPTY_FILTERS);
  }

  return (
    <form className="card filters" onSubmit={submit} noValidate aria-labelledby="audit-filters-title">
      <h2 id="audit-filters-title">Filters</h2>
      <div className="filter-grid">
        <Field id="audit-type" label="Event types" hint="One or more, separated by commas, for example si.chance.payments.DepositSucceeded.v1" error={errors.type ?? null}>
          {(control) => <input {...control} type="text" value={form.type} onChange={(event) => set("type", event.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field id="audit-from" label="From" error={errors.from ?? null}>
          {(control) => <input {...control} type="datetime-local" value={form.from} onChange={(event) => set("from", event.target.value)} />}
        </Field>
        <Field id="audit-to" label="To" error={errors.to ?? null}>
          {(control) => <input {...control} type="datetime-local" value={form.to} onChange={(event) => set("to", event.target.value)} />}
        </Field>
        <Field id="audit-correlation" label="Correlation id" hint="All entries of one business operation.">
          {(control) => <input {...control} type="text" value={form.correlationId} onChange={(event) => set("correlationId", event.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field id="audit-actor" label="Actor" hint="The user who caused the event.">
          {(control) => <input {...control} type="text" value={form.actor} onChange={(event) => set("actor", event.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field id="audit-subject" label="Subject" hint="The market, deposit, withdrawal, user or tenant the event is about.">
          {(control) => <input {...control} type="text" value={form.subject} onChange={(event) => set("subject", event.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
      </div>
      <div className="actions">
        <button type="submit" className="button">
          Apply the filters
        </button>
        <button type="button" className="button button-quiet" onClick={clear}>
          Clear the filters
        </button>
      </div>
    </form>
  );
}
