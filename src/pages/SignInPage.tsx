import { useLocation } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { useDocumentTitle } from "../lib/use-document-title";

/** Shown without a session. The button starts the login at the identity provider and comes back to this address. */
export function SignInPage() {
  useDocumentTitle("Sign in");
  const { login, notice } = useAuth();
  const location = useLocation();
  return (
    <section className="card">
      <h1>Chance</h1>
      <p>Trade on the outcome of questions with credits. Sign in to see your tenant's markets, your wallet and your portfolio.</p>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <button type="button" className="button" onClick={() => void login(`${location.pathname}${location.search}`)}>
        Sign in
      </button>
    </section>
  );
}
