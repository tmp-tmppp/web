/** The roles of the realm that the app knows. Other realm roles (default-roles-chance, offline_access) are ignored. */
export const APP_ROLES = ["trader", "tenant-admin", "platform-admin"] as const;

export type Role = (typeof APP_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  trader: "Trader",
  "tenant-admin": "Tenant admin",
  "platform-admin": "Platform admin",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}
