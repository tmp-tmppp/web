import { useCallback } from "react";
import { useApi } from "../../api/ApiContext";
import { listAudit } from "../../api/audit";
import type { AuditEntry, AuditFilters } from "../../api/audit";
import { ListFooter } from "../../components/ListFooter";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";
import { usePagedList } from "../../lib/use-paged-list";

function Details({ entry }: { entry: AuditEntry }) {
  return (
    <details>
      <summary>
        Details<span className="sr-only"> of entry {entry.seq}</span>
      </summary>
      <dl className="details">
        <dt>Source</dt>
        <dd>
          <code>{entry.source}</code>
        </dd>
        <dt>Event id</dt>
        <dd>
          <code>{entry.eventId}</code>
        </dd>
        <dt>Recorded</dt>
        <dd>
          <Time value={entry.recordedAt} />
        </dd>
        <dt>Cause</dt>
        <dd>{entry.causationId ? <code>{entry.causationId}</code> : "None"}</dd>
        <dt>Hash</dt>
        <dd>
          <code>{entry.hash}</code>
        </dd>
        <dt>Hash of the entry before</dt>
        <dd>
          <code>{entry.prevHash}</code>
        </dd>
        <dt>Data of the event</dt>
        <dd>
          <pre className="payload">{JSON.stringify(entry.payload, null, 2) ?? "null"}</pre>
        </dd>
      </dl>
    </details>
  );
}

/** The entries for one set of filters, newest first. The parent gives it a new key to start a new list. */
export function AuditList({ filters }: { filters: AuditFilters }) {
  const api = useApi();
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => listAudit(api, filters, cursor, signal), [api, filters]);
  const list = usePagedList(fetchPage);

  return (
    <div aria-busy={list.phase === "loading"}>
      {list.phase === "loading" ? <StatusMessage>Loading the entries...</StatusMessage> : null}
      {list.phase === "error" ? (
        <>
          <ProblemDisplay error={list.error} heading="The audit log could not be loaded" />
          <button type="button" className="button button-quiet" onClick={list.reload}>
            Try again
          </button>
        </>
      ) : null}
      {list.phase === "ready" && list.items.length === 0 ? <p>No entries match.</p> : null}
      {list.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Audit entries, newest first</caption>
            <thead>
              <tr>
                <th scope="col">No.</th>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col">Subject</th>
                <th scope="col">Actor</th>
                <th scope="col">Correlation id</th>
                <th scope="col">More</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((entry) => (
                <tr key={entry.seq}>
                  <th scope="row">{entry.seq}</th>
                  <td>
                    <Time value={entry.occurredAt} />
                  </td>
                  <td>
                    <code>{entry.eventType}</code>
                  </td>
                  <td>
                    <code>{entry.subject}</code>
                  </td>
                  <td>{entry.actor ? <code>{entry.actor}</code> : "-"}</td>
                  <td>{entry.correlationId ? <code>{entry.correlationId}</code> : "-"}</td>
                  <td>
                    <Details entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ListFooter list={list} more="older entries" />
    </div>
  );
}
