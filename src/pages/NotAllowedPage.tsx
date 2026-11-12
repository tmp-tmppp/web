import { Link } from "react-router";
import type { Denial } from "../auth/access";
import { useAuth } from "../auth/AuthContext";
import { useDocumentTitle } from "../lib/use-document-title";

const EXPLANATION: Record<Denial, string> = {
  role: "Your role does not allow this page.",
  "tenant-required": "This page is only for members of a tenant.",
  "tenant-present": "You already belong to a tenant.",
};

/**
 * Shown in place of a page the user's role or tenant does not allow, also when the address is typed in by hand.
 * The menu hides such pages too; the API checks every request again, so this is a courtesy, not the security.
 */
export function NotAllowedPage({ reason }: { reason: Denial }) {
  useDocumentTitle("Not allowed");
  const { user } = useAuth();
  const canJoin = reason === "tenant-required" && user !== null && !user.roles.includes("platform-admin");
  return (
    <section>
      <h1>Not allowed</h1>
      <p role="alert">{EXPLANATION[reason]}</p>
      {canJoin ? (
        <p>
          If you have an invite code, <Link to="/join">join your tenant with it</Link>.
        </p>
      ) : null}
      <p>
        <Link to="/">Back to the start page</Link>
      </p>
    </section>
  );
}
