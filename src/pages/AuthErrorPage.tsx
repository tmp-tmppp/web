import { useAuth } from "../auth/AuthContext";
import { useDocumentTitle } from "../lib/use-document-title";

/** The login could not be completed (the identity provider refused it, or the answer was not valid). */
export function AuthErrorPage() {
  useDocumentTitle("Sign-in failed");
  const { error, login } = useAuth();
  return (
    <section className="card">
      <h1>Sign-in failed</h1>
      <div className="problem" role="alert">
        <p className="problem-title">We could not sign you in.</p>
        <p>{error?.message ? error.message : "The identity provider did not complete the login."}</p>
      </div>
      <button type="button" className="button" onClick={() => void login("/")}>
        Try again
      </button>
    </section>
  );
}
