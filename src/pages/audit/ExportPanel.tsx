import { useEffect, useId, useRef, useState } from "react";
import { requestAuditExport } from "../../api/auditExport";
import type { ExportFormat, ExportedFile } from "../../api/auditExport";
import type { AuditFilters } from "../../api/audit";
import { useAuth } from "../../auth/AuthContext";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { useConfig } from "../../config/ConfigContext";
import { saveBlob } from "../../lib/download";

type Done = Pick<ExportedFile, "fileName" | "rows" | "truncated">;

function entries(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/**
 * Downloads the audit log of the tenant as a file from the audit-export function: all entries that match the filters
 * applied above, not only the ones loaded in the list. Shown only when the runtime configuration names the function
 * (auditExportUrl). The page sends the user's own token; the function never keeps it.
 */
export function ExportPanel({ filters }: { filters: AuditFilters }) {
  const config = useConfig();
  const { getAccessToken, refreshSession, expireSession } = useAuth();
  const formatId = useId();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const running = useRef<AbortController | null>(null);

  // Leaving the page cancels an export that is still being read.
  useEffect(() => () => running.current?.abort(), []);

  const url = config.auditExportUrl;
  if (!url) return null;

  async function start(address: string) {
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setDone(null);
    setFailure(null);
    try {
      const file = await requestAuditExport({
        url: address,
        format,
        filters,
        getAccessToken,
        refreshSession,
        onUnauthorized: () => void expireSession(),
        signal: controller.signal,
      });
      saveBlob(file.blob, file.fileName);
      setDone({ fileName: file.fileName, rows: file.rows, truncated: file.truncated });
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error);
    } finally {
      if (running.current === controller) running.current = null;
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="export-title" aria-busy={busy}>
      <h2 id="export-title">Export the log</h2>
      <p>
        Download every entry that matches the filters you applied, not only the ones listed below, as one file. CSV opens in a spreadsheet; JSON Lines keeps every
        field, one entry per line. A long log can take a while.
      </p>
      <div>
        <label htmlFor={formatId}>File format</label>{" "}
        <select id={formatId} value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)} disabled={busy}>
          <option value="csv">CSV (spreadsheet)</option>
          <option value="jsonl">JSON Lines</option>
        </select>{" "}
        <button type="button" className="button" onClick={() => void start(url)} disabled={busy}>
          Export
        </button>
      </div>
      {busy ? <StatusMessage>Preparing the file...</StatusMessage> : null}
      {done?.truncated === false ? (
        <p className="success" role="status">
          Exported {done.rows === null ? "the entries" : entries(done.rows)} to <code>{done.fileName}</code>.
        </p>
      ) : null}
      {done?.truncated === null ? (
        <p className="problem" role="alert">
          <strong>The file was saved, but whether it is complete could not be confirmed.</strong> The browser could not read the header that says whether the export was cut at its limit, so a
          cut would not show here. <code>{done.fileName}</code> may hold the newest entries only. Narrow the filters (dates, event types) to be sure, or ask an administrator to let the function app
          expose <code>X-Export-Truncated</code> to this page (CORS).
        </p>
      ) : null}
      {done?.truncated === true ? (
        <p className="problem" role="alert">
          <strong>The file is not complete.</strong> The export was cut at {done.rows === null ? "its limit" : `${entries(done.rows)}, the limit of one export`}. <code>{done.fileName}</code> holds the
          newest entries only. Narrow the filters (dates, event types) and export again for the rest.
        </p>
      ) : null}
      {failure ? <ProblemDisplay error={failure} heading="The log could not be exported" /> : null}
    </section>
  );
}
