import { evaluateAccess } from "../auth/access";
import { useAuth } from "../auth/AuthContext";
import { useDocumentTitle } from "../lib/use-document-title";
import { NotAllowedPage } from "../pages/NotAllowedPage";
import type { AppRoute } from "./route-table";

function Titled({ route }: { route: AppRoute }) {
  useDocumentTitle(route.title);
  return route.element;
}

/** Shows the page of a route when the user's role and tenant allow it, and "not allowed" otherwise (also for a typed-in address). */
export function RouteView({ route }: { route: AppRoute }) {
  const { user } = useAuth();
  if (!user) return null;
  const decision = evaluateAccess(user, route.access);
  if (!decision.allowed) return <NotAllowedPage reason={decision.reason} />;
  return <Titled route={route} />;
}
