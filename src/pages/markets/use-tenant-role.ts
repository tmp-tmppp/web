import { useAuth } from "../../auth/AuthContext";

export type TenantRole = "trader" | "tenant-admin";

/**
 * The role of the signed-in user in their tenant, read from the token: what decides whether a page shows the trading
 * forms or the admin's actions. A platform admin, a user without a tenant and a user without a tenant role get null, and
 * the pages show nothing of a tenant (the route guard keeps them out anyway; the services answer 403).
 */
export function useTenantRole(): TenantRole | null {
  const { user } = useAuth();
  if (!user?.tenantId) return null;
  if (user.roles.includes("tenant-admin")) return "tenant-admin";
  if (user.roles.includes("trader")) return "trader";
  return null;
}
