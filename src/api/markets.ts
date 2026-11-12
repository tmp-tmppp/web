import type { ApiClient, ApiResponse, Page } from "./types";

/**
 * Requests and answers of the markets service: the lifecycle of a market (list, read, create, open, close, resolve) and
 * sharing a market by link. The OpenAPI file of the service is the truth (contracts/markets.openapi.yaml). The token of
 * a share link is a secret: it travels in a request body, is never put into an address that a server sees, and is never
 * logged.
 */

export type LinkType = "members" | "profiles" | "everyone";
export const LINK_TYPES: readonly LinkType[] = ["members", "profiles", "everyone"];
export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  members: "Members of this organization",
  profiles: "Chosen profiles (by verified e-mail address)",
  everyone: "Everyone who has the link",
};

export type WhoMayShare = "none" | "admins" | "members";
export type NextAction = "sign_in" | "join" | "switch_organization" | "trade";
export type MarketStatus = "draft" | "opening" | "open" | "closed" | "resolved";
export type ShareLinkStatus = "active" | "revoked" | "expired";

/** Who may make share links of a market and of which types; fixed when the market is created. */
export interface SharingPolicy {
  whoMayShare: WhoMayShare;
  linkTypes: LinkType[];
}

/** The part of a market the share dialog needs (GET /v1/markets/{id} returns more). */
export interface MarketForSharing {
  id: string;
  question: string;
  status: MarketStatus;
  sharing: SharingPolicy;
}

/** `INVALID`: the question could not be answered; trading refunds every stake and returns the rest of the funding. */
export type Outcome = "YES" | "NO" | "INVALID";
export const OUTCOMES: readonly Outcome[] = ["YES", "NO", "INVALID"];

/** A market of the markets service (the lifecycle and its dates; prices come from market-data). */
export interface Market extends MarketForSharing {
  tenantId: string;
  description: string;
  closeTime: string;
  /** The YES price the creator set (0.01 to 0.99, two decimals): a quoted number, never computed with. */
  startingPrice: number;
  /** Whole credits the creator pays to open the market. */
  fundingAmount: number;
  outcome: Outcome | null;
  version: number;
  /** Subject of the tenant admin who created the market; only that admin can open it. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  openedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface CreateMarketRequest {
  question: string;
  description?: string;
  closeTime: string;
  /** The YES price with at most two decimals. */
  startingPrice: number;
  fundingAmount: number;
  sharing?: { whoMayShare?: WhoMayShare; linkTypes?: LinkType[] };
}

/** The statuses a market list can be filtered by. A trader may ask only for open, closed and resolved (else 403). */
export const MARKET_STATUSES: readonly MarketStatus[] = ["draft", "opening", "open", "closed", "resolved"];

export interface ListMarketsQuery {
  status?: MarketStatus;
  cursor?: string | null;
  limit?: number;
}

export const listMarkets = (api: ApiClient, query: ListMarketsQuery = {}, signal?: AbortSignal): Promise<Page<Market>> =>
  api.get<Page<Market>>("/v1/markets", { status: query.status, cursor: query.cursor, limit: query.limit }, signal);

export const getMarket = (api: ApiClient, marketId: string, signal?: AbortSignal): Promise<Market> =>
  api.get<Market>(`/v1/markets/${encodeURIComponent(marketId)}`, undefined, signal);

export const createMarket = (api: ApiClient, body: CreateMarketRequest): Promise<Market> => api.post<Market>("/v1/markets", body);

/** 200 when the funding went through (the market is open), 202 when its outcome is unknown (the market is "opening" and the service goes on in the background). */
export const openMarket = (api: ApiClient, marketId: string): Promise<ApiResponse<Market>> =>
  api.request<Market>(`/v1/markets/${encodeURIComponent(marketId)}/open`, { method: "POST" });

export const closeMarket = (api: ApiClient, marketId: string): Promise<Market> =>
  api.post<Market>(`/v1/markets/${encodeURIComponent(marketId)}/close`);

export const resolveMarket = (api: ApiClient, marketId: string, outcome: Outcome): Promise<Market> =>
  api.post<Market>(`/v1/markets/${encodeURIComponent(marketId)}/resolve`, { outcome });

export interface ShareLink {
  id: string;
  marketId: string;
  type: LinkType;
  emails: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ShareLinkStatus;
}

/** The answer that makes a link: the token and the share path are in this answer only. */
export interface CreatedShareLink extends ShareLink {
  token: string;
  /** "/share#<token>": the web puts its own origin in front. */
  urlPath: string;
}

export interface CreateShareLinkRequest {
  type: LinkType;
  emails?: string[];
  expiresAt?: string;
}

export interface Lookup {
  linkType: LinkType;
  market: { id: string; question: string; status: MarketStatus; closeTime: string };
  organization: { alias: string; name: string | null };
  next: NextAction[];
}

/** Limits of the contract, checked in the dialog before a request is sent. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_EMAILS_MAX = 50;
export const SHARE_PATH = "/share";

/** Only a market that is open, closed or resolved can be shared; a draft or a market that is opening answers 409. */
export function canShareStatus(status: MarketStatus): boolean {
  return status === "open" || status === "closed" || status === "resolved";
}

/** The link types the policy allows this caller to make (none when the policy lets nobody, or admins only and the caller is a trader). */
export function linkTypesFor(policy: SharingPolicy, role: "trader" | "tenant-admin"): LinkType[] {
  if (policy.whoMayShare === "none") return [];
  if (policy.whoMayShare === "admins" && role !== "tenant-admin") return [];
  return LINK_TYPES.filter((type) => policy.linkTypes.includes(type));
}

/** The address to hand out: the origin of this app, the share path and the token after "#", so no server ever sees it. */
export function shareUrl(origin: string, urlPath: string): string {
  return `${origin}${urlPath}`;
}

export const getMarketForSharing = (api: ApiClient, marketId: string, signal?: AbortSignal): Promise<MarketForSharing> =>
  api.get<MarketForSharing>(`/v1/markets/${encodeURIComponent(marketId)}`, undefined, signal);

export const createShareLink = (api: ApiClient, marketId: string, body: CreateShareLinkRequest): Promise<CreatedShareLink> =>
  api.post<CreatedShareLink>(`/v1/markets/${encodeURIComponent(marketId)}/share-links`, body);

export const listShareLinks = (api: ApiClient, marketId: string, cursor: string | null, signal?: AbortSignal): Promise<Page<ShareLink>> =>
  api.get<Page<ShareLink>>(`/v1/markets/${encodeURIComponent(marketId)}/share-links`, cursor ? { cursor } : undefined, signal);

export async function revokeShareLink(api: ApiClient, marketId: string, linkId: string): Promise<void> {
  await api.request<void>(`/v1/markets/${encodeURIComponent(marketId)}/share-links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
}

/** Public: works without a session (a bearer token is sent when there is one, so markets can tell a member from a stranger). */
export const lookupSharedMarket = (api: ApiClient, token: string, signal?: AbortSignal): Promise<Lookup> =>
  api.post<Lookup>("/v1/shared-markets/lookup", { token }, signal ? { signal } : {});
