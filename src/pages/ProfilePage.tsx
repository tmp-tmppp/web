import { Link, useLocation } from "react-router";
import { MEMBER_ROLE_LABELS } from "../api/tenants";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABELS } from "../auth/roles";
import { ProblemDisplay } from "../components/ProblemDisplay";
import { StatusMessage } from "../components/StatusMessage";
import { useMe } from "./use-me";
import type { SyncPhase } from "./use-me";

function SyncNotice({ phase, onRecheck, onRefresh }: { phase: SyncPhase; onRecheck: () => void; onRefresh: () => void }) {
  switch (phase) {
    case "waiting":
      return (
        <StatusMessage>
          Your tenant or role is being set up at the identity provider. This page asks again every few seconds; there is nothing to do.
        </StatusMessage>
      );
    case "refreshing":
      return <StatusMessage>Refreshing your session so it carries your latest tenant and role...</StatusMessage>;
    case "gave-up":
      return (
        <div className="notice-box" role="status">
          <p>The identity provider has not caught up yet. This can take a minute.</p>
          <div className="actions">
            <button type="button" className="button" onClick={onRecheck}>
              Check again
            </button>
            <button type="button" className="button button-quiet" onClick={onRefresh}>
              Refresh your session
            </button>
          </div>
        </div>
      );
    case "stale":
      return (
        <div className="notice-box" role="status">
          <p>Your session does not show your latest tenant or role yet. Refresh your session; if that does not help, sign out and sign in again.</p>
          <div className="actions">
            <button type="button" className="button" onClick={onRefresh}>
              Refresh your session
            </button>
          </div>
        </div>
      );
    case "in-sync":
      return null;
  }
}

/** Who the user is, in which tenant and with which role (GET /v1/me), and the state of a tenant or role change that is still on its way. */
export function ProfilePage() {
  const { user } = useAuth();
  const location = useLocation();
  const { me, error, loading, phase, recheck, refreshNow } = useMe();
  const joined = (location.state as { joined?: { role?: string } } | null)?.joined;

  return (
    <section aria-busy={loading}>
      <h1>Profile</h1>
      {joined ? (
        <p className="success" role="status">
          You joined the organization{joined.role ? ` as ${joined.role}` : ""}.
        </p>
      ) : null}
      {error ? <ProblemDisplay error={error} heading="Your profile could not be loaded" /> : null}
      {error ? (
        <button type="button" className="button button-quiet" onClick={recheck}>
          Try again
        </button>
      ) : null}
      {loading && !me ? <StatusMessage>Loading your profile...</StatusMessage> : null}
      {me ? (
        <dl className="details">
          <dt>Name</dt>
          <dd>{user?.name}</dd>
          {user?.email ? (
            <>
              <dt>E-mail</dt>
              <dd>{user.email}</dd>
            </>
          ) : null}
          <dt>User id</dt>
          <dd>
            <code>{me.userId}</code>
          </dd>
          <dt>Tenant</dt>
          <dd>{me.tenantId ? <code>{me.tenantId}</code> : <>None yet. If you have an invite code, <Link to="/join">join an organization</Link>.</>}</dd>
          <dt>Role in the tenant</dt>
          <dd>{me.role ? MEMBER_ROLE_LABELS[me.role] : "None"}</dd>
          {user && user.roles.includes("platform-admin") ? (
            <>
              <dt>Platform role</dt>
              <dd>{ROLE_LABELS["platform-admin"]}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {me ? <SyncNotice phase={phase} onRecheck={recheck} onRefresh={refreshNow} /> : null}
    </section>
  );
}
