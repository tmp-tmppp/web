import { Link } from "react-router";
import { useDocumentTitle } from "../lib/use-document-title";

export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <section>
      <h1>Page not found</h1>
      <p>There is no page at this address.</p>
      <p>
        <Link to="/">Back to the start page</Link>
      </p>
    </section>
  );
}
