import { useState } from "react";
import { EMPTY_FILTERS } from "../../api/audit";
import type { AuditFilters } from "../../api/audit";
import { AuditFilterForm } from "./AuditFilterForm";
import { AuditList } from "./AuditList";
import { ExportPanel } from "./ExportPanel";
import { VerifyPanel } from "./VerifyPanel";

/** Tenant admin: the audit log of the own tenant, newest first, with filters, cursor pagination and a chain check. */
export function AuditPage() {
  // Every application of the filters is a new list: the counter in the key makes the list start clean, also for the same filters.
  const [applied, setApplied] = useState<{ filters: AuditFilters; round: number }>({ filters: EMPTY_FILTERS, round: 0 });
  return (
    <section>
      <h1>Audit log</h1>
      <p>Every business event of your tenant is recorded once and never changed. Entries are listed newest first.</p>
      <VerifyPanel />
      <AuditFilterForm onApply={(filters) => setApplied((previous) => ({ filters, round: previous.round + 1 }))} />
      <ExportPanel filters={applied.filters} />
      <h2>Entries</h2>
      <AuditList key={applied.round} filters={applied.filters} />
    </section>
  );
}
