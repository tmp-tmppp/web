import { useState } from "react";
import { useApi } from "../../api/ApiContext";
import { verifyAudit } from "../../api/audit";
import type { VerifyResult } from "../../api/audit";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";

/** Recomputes the hash chain of the tenant's log (GET /v1/audit/verify) and says whether it is intact or where it first breaks. */
export function VerifyPanel() {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  async function verify() {
    setBusy(true);
    setResult(null);
    setFailure(null);
    try {
      setResult(await verifyAudit(api));
    } catch (error) {
      // 503 verify_busy: the service runs as many checks as it allows; the problem carries the wait.
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="verify-title" aria-busy={busy}>
      <h2 id="verify-title">Verify the log</h2>
      <p>Every entry is chained to the one before it by a hash. Verifying recomputes the whole chain of your tenant, so it can take a moment.</p>
      <button type="button" className="button" onClick={() => void verify()} disabled={busy}>
        Verify
      </button>
      {busy ? <StatusMessage>Checking the chain...</StatusMessage> : null}
      {result?.valid ? (
        <p className="success" role="status">
          Valid: the chain is intact. {result.entries} {result.entries === 1 ? "entry was" : "entries were"} checked.
        </p>
      ) : null}
      {result && !result.valid ? (
        <p className="problem" role="alert">
          <strong>The log is broken.</strong> The first wrong entry is number {result.brokenAtSeq}. {result.entries} {result.entries === 1 ? "entry was" : "entries were"} checked.
        </p>
      ) : null}
      {failure ? <ProblemDisplay error={failure} heading="The log could not be verified" /> : null}
    </section>
  );
}
