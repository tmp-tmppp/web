import { useMemo } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { SHARE_PATH } from "../api/markets";
import { landingPath } from "../auth/access";
import { useAuth } from "../auth/AuthContext";
import { CALLBACK_PATH } from "../auth/oidc";
import { Layout } from "../components/Layout";
import { PublicFrame } from "../components/PublicFrame";
import { StatusMessage } from "../components/StatusMessage";
import { useConfig } from "../config/ConfigContext";
import { AuthErrorPage } from "../pages/AuthErrorPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { SharePage } from "../pages/share/SharePage";
import { SignInPage } from "../pages/SignInPage";
import { RouteView } from "./RouteView";
import { buildRoutes } from "./route-table";

/** Without a session only the sign-in page and the landing page of a share link exist; with one, the routes of the route table inside the layout. */
export function AppRoutes() {
  const { status, user } = useAuth();
  const config = useConfig();
  const location = useLocation();
  const routes = useMemo(() => buildRoutes(config), [config]);

  if (status === "loading") {
    return (
      <PublicFrame>
        <StatusMessage>Signing you in...</StatusMessage>
      </PublicFrame>
    );
  }
  if (status === "error") {
    return (
      <PublicFrame>
        <AuthErrorPage />
      </PublicFrame>
    );
  }
  if (status === "unauthenticated" || !user) {
    return (
      <PublicFrame>
        {/* The landing page of a share link works without a session: a link for everyone shows the market, the page offers the sign-in. */}
        {location.pathname === SHARE_PATH ? <SharePage /> : <SignInPage />}
      </PublicFrame>
    );
  }

  return (
    <Routes>
      {/*
        The callback address only waits: AuthProvider moves the browser to the page the user asked for as soon as it has
        the session. A redirect to the start page here would race with that move and win it, and a deep link would be lost.
      */}
      <Route
        path={CALLBACK_PATH}
        element={
          <PublicFrame>
            <StatusMessage>Signing you in...</StatusMessage>
          </PublicFrame>
        }
      />
      <Route element={<Layout user={user} routes={routes} />}>
        <Route index element={<Navigate to={landingPath(user)} replace />} />
        {routes.map((route) => (
          <Route key={route.path} path={route.path} element={<RouteView route={route} />} />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
