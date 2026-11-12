import type { ApiClient, Page } from "./types";

/** Requests and answers of the tenants service. The OpenAPI file of the service is the truth (contracts/tenants.openapi.yaml). */

export type MemberRole = "trader" | "tenant-admin";

export const MEMBER_ROLES: readonly MemberRole[] = ["trader", "tenant-admin"];

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = { trader: "Trader", "tenant-admin": "Tenant admin" };

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  createdBy: string;
  createdAt: string;
}

export interface Invite {
  /** Shown only once, in the answer that creates the invite. */
  code: string;
  role: MemberRole;
  maxUses: number;
  expiresAt: string;
}

export interface CreateTenantResponse {
  tenant: Tenant;
  adminInvite: Invite;
}

export interface Me {
  userId: string;
  tenantId: string | null;
  role: MemberRole | null;
  tokenTenantId: string | null;
  tokenNeedsRefresh: boolean;
  identityPending: boolean;
}

export interface Member {
  userId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface Membership {
  tenantId: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
  updatedAt: string;
}

export interface AcceptInviteResponse {
  tenantId: string;
  role: MemberRole;
}

export interface CreateInviteRequest {
  role: MemberRole;
  maxUses: number;
  expiresInHours: number;
}

/** Limits of the contract, checked in the forms before a request is sent. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const TENANT_NAME_MAX = 100;
export const INVITE_CODE_MIN = 16;
export const INVITE_CODE_MAX = 128;
export const INVITE_MAX_USES = { min: 1, max: 100, default: 1 } as const;
export const INVITE_EXPIRY_HOURS = { min: 1, max: 720, default: 168 } as const;

function cursorQuery(cursor: string | null): { cursor: string } | undefined {
  return cursor ? { cursor } : undefined;
}

export const getMe = (api: ApiClient, signal?: AbortSignal): Promise<Me> => api.get<Me>("/v1/me", undefined, signal);

export const listTenants = (api: ApiClient, cursor: string | null, signal?: AbortSignal): Promise<Page<Tenant>> =>
  api.get<Page<Tenant>>("/v1/tenants", cursorQuery(cursor), signal);

export const createTenant = (api: ApiClient, body: { name: string; slug: string }): Promise<CreateTenantResponse> =>
  api.post<CreateTenantResponse>("/v1/tenants", body);

export const acceptInvite = (api: ApiClient, code: string): Promise<AcceptInviteResponse> =>
  api.post<AcceptInviteResponse>(`/v1/invites/${encodeURIComponent(code)}/accept`);

export const createInvite = (api: ApiClient, tenantId: string, body: CreateInviteRequest): Promise<Invite> =>
  api.post<Invite>(`/v1/tenants/${encodeURIComponent(tenantId)}/invites`, body);

export const listMembers = (api: ApiClient, tenantId: string, cursor: string | null, signal?: AbortSignal): Promise<Page<Member>> =>
  api.get<Page<Member>>(`/v1/tenants/${encodeURIComponent(tenantId)}/members`, cursorQuery(cursor), signal);

export const changeMemberRole = (api: ApiClient, tenantId: string, userId: string, role: MemberRole): Promise<Membership> =>
  api.put<Membership>(`/v1/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}/role`, { role });

/** An organization (tenant) the caller belongs to, from GET /v1/me/organizations. alias is the value after "chance-organization:" in the sign-in scope. */
export interface Organization {
  alias: string;
  tenantId: string;
  name: string;
  slug: string;
  role: MemberRole;
  joinedAt: string;
}

export interface OrganizationPage extends Page<Organization> {
  /** True while the identity provider may not hold every membership yet: signing in to a new organization can fail until it is false. */
  identityPending: boolean;
}

export interface ShareJoinResponse {
  alias: string;
  tenantId: string;
  name: string;
  marketId: string;
  role: MemberRole;
  /** True when this call added the membership, false when the caller already was a member. */
  joined: boolean;
}

export const listMyOrganizations = (api: ApiClient, cursor: string | null, signal?: AbortSignal): Promise<OrganizationPage> =>
  api.get<OrganizationPage>("/v1/me/organizations", { limit: 100, ...(cursor ? { cursor } : {}) }, signal);

/** Joins the organization of a shared market with the token of a share link (in the body, never in an address). */
export const joinByShareLink = (api: ApiClient, token: string): Promise<ShareJoinResponse> =>
  api.post<ShareJoinResponse>("/v1/share-joins", { token });
