import type { ApiClient, Page } from "./types";

/** Requests and answers of the audit service. The OpenAPI file of the service is the truth (contracts/audit.openapi.yaml). */

export interface AuditEntry {
  seq: number;
  eventId: string;
  eventType: string;
  source: string;
  subject: string;
  actor: string | null;
  occurredAt: string;
  recordedAt: string;
  correlationId: string | null;
  causationId: string | null;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface VerifyResult {
  valid: boolean;
  entries: number;
  brokenAtSeq: number | null;
}

/** The filters of the list; an empty text means "no filter". "type" holds one or more event types separated by commas. */
export interface AuditFilters {
  type: string;
  from: string;
  to: string;
  correlationId: string;
  actor: string;
  subject: string;
}

export const EMPTY_FILTERS: AuditFilters = { type: "", from: "", to: "", correlationId: "", actor: "", subject: "" };

/** The contract allows at most 20 event types in one request. */
export const AUDIT_TYPES_MAX = 20;

/** The event types of a filter text: split at commas and spaces, empty parts dropped. */
export function typesOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** The query of the filters, as GET /v1/audit and the audit-export function take them (empty values are left out later). */
export const auditQuery = (filters: AuditFilters): Record<string, string> => ({
  type: typesOf(filters.type).join(","),
  from: filters.from,
  to: filters.to,
  correlationId: filters.correlationId.trim(),
  actor: filters.actor.trim(),
  subject: filters.subject.trim(),
});

export const listAudit = (api: ApiClient, filters: AuditFilters, cursor: string | null, signal?: AbortSignal): Promise<Page<AuditEntry>> =>
  api.get<Page<AuditEntry>>("/v1/audit", { ...auditQuery(filters), cursor }, signal);

export const verifyAudit = (api: ApiClient): Promise<VerifyResult> => api.get<VerifyResult>("/v1/audit/verify");
