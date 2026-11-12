import type { AuditEntry } from "../../src/api/audit";
import type { Bucket, DataMarket, History } from "../../src/api/market-data";
import type { Deposit, Withdrawal } from "../../src/api/payments";
import type { Order, Portfolio, Quote, Sale, SaleQuote } from "../../src/api/trading";
import type { CreatedShareLink, Lookup, MarketForSharing, ShareLink, SharingPolicy } from "../../src/api/markets";
import type { Me, Member, Organization, Tenant } from "../../src/api/tenants";
import { contractHandler, reply } from "./contract";
import { oidcUser } from "./fake-oidc";

export const TENANT_ID = "3f2c1d3e-8a7b-4c1d-9e2f-5a6b7c8d9e0f";
export const OTHER_TENANT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const USER_ID = "b1c2d3e4-0000-4000-8000-000000000001";
export const NOW = "2026-11-11T10:00:00Z";
export const INVITE_CODE = "invite-code-0123456789abcdef";

export const traderOidc = () => oidcUser({ sub: USER_ID, roles: ["trader"], organization: [TENANT_ID] });
export const tenantAdminOidc = () => oidcUser({ sub: USER_ID, roles: ["tenant-admin"], organization: [TENANT_ID] });
export const platformAdminOidc = () => oidcUser({ sub: USER_ID, roles: ["platform-admin"] });
export const newcomerOidc = () => oidcUser({ sub: USER_ID });

export const me = (overrides: Partial<Me> = {}): Me => ({
  userId: USER_ID,
  tenantId: TENANT_ID,
  role: "trader",
  tokenTenantId: TENANT_ID,
  tokenNeedsRefresh: false,
  identityPending: false,
  ...overrides,
});

export const tenant = (overrides: Partial<Tenant> = {}): Tenant => ({
  id: TENANT_ID,
  name: "Acme Traders",
  slug: "acme-traders",
  status: "active",
  createdBy: USER_ID,
  createdAt: NOW,
  ...overrides,
});

export const member = (overrides: Partial<Member> = {}): Member => ({ userId: "member-1", role: "trader", joinedAt: NOW, ...overrides });

export const deposit = (overrides: Partial<Deposit> = {}): Deposit => ({
  id: "d1111111-1111-4111-8111-111111111111",
  userId: USER_ID,
  amount: 1250,
  status: "pending",
  checkoutUrl: "https://pay.example.test/checkout/cs_123",
  failureReason: null,
  expiresAt: "2026-11-11T10:30:00Z",
  createdAt: NOW,
  updatedAt: NOW,
  completedAt: null,
  ...overrides,
});

export const withdrawal = (overrides: Partial<Withdrawal> = {}): Withdrawal => ({
  id: "a2222222-2222-4222-8222-222222222222",
  userId: USER_ID,
  amount: 500,
  status: "debited",
  reason: null,
  createdAt: NOW,
  updatedAt: NOW,
  completedAt: null,
  ...overrides,
});

export const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  seq: 2,
  eventId: "evt-2",
  eventType: "si.chance.payments.DepositSucceeded.v1",
  source: "/chance/payments",
  subject: "d1111111-1111-4111-8111-111111111111",
  actor: USER_ID,
  occurredAt: NOW,
  recordedAt: NOW,
  correlationId: "corr-1",
  causationId: null,
  payload: { amount: 1250 },
  prevHash: "0".repeat(64),
  hash: "a".repeat(64),
  ...overrides,
});

export const MARKET_ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
/** A share token as the service makes it: 32 bytes, base64url, 43 characters. */
export const SHARE_TOKEN = "kT3vQ9xZ1mN7pL2sD5fG8hJ0wE4rY6uI-aB_cVnMoXq";
export const SHARE_LINK_ID = "0192f3a4-5b6c-7d8e-9f01-23456789ab00";

export const sharing = (overrides: Partial<SharingPolicy> = {}): SharingPolicy => ({ whoMayShare: "members", linkTypes: ["members"], ...overrides });

/** The answer of GET /v1/markets/{id}: the whole Market of the contract (the share dialog reads status and sharing). */
export const market = (overrides: Partial<MarketForSharing> & Record<string, unknown> = {}) => ({
  id: MARKET_ID,
  tenantId: TENANT_ID,
  question: "Will the shared market open before Friday?",
  description: "",
  closeTime: "2026-12-31T12:00:00Z",
  startingPrice: 0.5,
  fundingAmount: 1000,
  status: "open",
  outcome: null,
  version: 2,
  createdBy: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
  openedAt: NOW,
  closedAt: null,
  closedBy: null,
  resolvedAt: null,
  resolvedBy: null,
  sharing: sharing(),
  ...overrides,
});

export const shareLink = (overrides: Partial<ShareLink> = {}): ShareLink => ({
  id: SHARE_LINK_ID,
  marketId: MARKET_ID,
  type: "members",
  emails: [],
  createdBy: USER_ID,
  createdAt: NOW,
  expiresAt: null,
  revokedAt: null,
  status: "active",
  ...overrides,
});

export const createdShareLink = (overrides: Partial<CreatedShareLink> = {}): CreatedShareLink => ({
  ...shareLink(),
  token: SHARE_TOKEN,
  urlPath: `/share#${SHARE_TOKEN}`,
  ...overrides,
});

export const organization = (overrides: Partial<Organization> = {}): Organization => ({
  alias: TENANT_ID,
  tenantId: TENANT_ID,
  name: "Acme Traders",
  slug: "acme-traders",
  role: "trader",
  joinedAt: NOW,
  ...overrides,
});

export const lookup = (overrides: Partial<Lookup> = {}): Lookup => ({
  linkType: "everyone",
  market: { id: MARKET_ID, question: "Will the shared market open before Friday?", status: "open", closeTime: "2026-12-31T12:00:00Z" },
  organization: { alias: TENANT_ID, name: "Acme Traders" },
  next: ["sign_in"],
  ...overrides,
});

/** Answers every request a page may send on mount with an empty or settled result, for tests that are not about the data. */
export function quietHandlers() {
  return [
    contractHandler("getMe", () => reply(200, me())),
    contractHandler("listTenants", () => reply(200, { items: [], nextCursor: null })),
    contractHandler("listMembers", () => reply(200, { items: [], nextCursor: null })),
    contractHandler("listAuditEntries", () => reply(200, { items: [], nextCursor: null })),
    contractHandler("getMarket", () => reply(200, market())),
    contractHandler("listShareLinks", () => reply(200, { items: [], nextCursor: null })),
    // The market page also reads the price and chart (market-data) and, for a trader, the balance and position (trading).
    contractHandler("market-data:getMarket", () => reply(200, dataMarket())),
    contractHandler("getMarketHistory", () => reply(200, history())),
    contractHandler("getPortfolio", () => reply(200, portfolio({ positions: [], recentTrades: [] }))),
    contractHandler("market-data:listMarkets", () => reply(200, { items: [], nextCursor: null })),
  ];
}

export const MARKET_2 = "0192f3a4-5b6c-7d8e-9f01-23456789abce";
export const MARKET_3 = "0192f3a4-5b6c-7d8e-9f01-23456789abcf";
export const TRADE_ID = "0192f3a4-5b6c-7d8e-9f01-23456789ab11";

/** A market of market-data: open, YES at 0.55 after three trades. */
export const dataMarket = (overrides: Partial<DataMarket> = {}): DataMarket => ({
  marketId: MARKET_ID,
  question: "Will the shared market open before Friday?",
  status: "open",
  closeTime: "2026-12-31T12:00:00Z",
  openedAt: NOW,
  closedAt: null,
  resolvedAt: null,
  outcome: null,
  startingPriceYesMicro: 500_000,
  lastPriceYesMicro: 550_000,
  currentPriceYesMicro: 550_000,
  volumeMicro: 12_500_000,
  tradeCount: 3,
  lastTradeSequence: 3,
  lastTradeAt: NOW,
  version: 2,
  updatedAt: NOW,
  ...overrides,
});

export const bucket = (overrides: Partial<Bucket> = {}): Bucket => ({
  start: "2026-11-11T09:00:00Z",
  openYesMicro: 500_000,
  highYesMicro: 550_000,
  lowYesMicro: 500_000,
  closeYesMicro: 550_000,
  volumeMicro: 12_500_000,
  trades: 3,
  ...overrides,
});

export const history = (overrides: Partial<History> = {}): History => ({
  marketId: MARKET_ID,
  interval: "1h",
  from: "2026-11-11T09:00:00Z",
  to: "2026-11-11T10:00:00Z",
  previousCloseYesMicro: null,
  buckets: [bucket()],
  nextCursor: null,
  ...overrides,
});

/** 10 credits buy 18.181818 YES shares at 0.55. */
export const quote = (overrides: Partial<Quote> = {}): Quote => ({
  marketId: MARKET_ID,
  side: "YES",
  amount: 10,
  sharesMicro: 18_181_818,
  costMicro: 10_000_000,
  averagePriceMicro: 550_000,
  worstPriceMicro: 550_000,
  fills: [{ priceMicro: 550_000, sharesMicro: 18_181_818, costMicro: 10_000_000 }],
  tradeSequence: 3,
  quotedAt: NOW,
  ...overrides,
});

export const order = (overrides: Partial<Order> = {}): Order => ({
  tradeId: TRADE_ID,
  marketId: MARKET_ID,
  side: "YES",
  amount: 10,
  sharesMicro: 18_181_818,
  costMicro: 10_000_000,
  averagePriceMicro: 550_000,
  worstPriceMicro: 550_000,
  fills: [{ priceMicro: 550_000, sharesMicro: 18_181_818, costMicro: 10_000_000 }],
  tradeSequence: 4,
  executedAt: NOW,
  balanceMicro: 90_000_000,
  position: { marketId: MARKET_ID, yesMicro: 18_181_818, noMicro: 0 },
  ...overrides,
});

/** 10 YES shares are sold by buying 10 NO shares at 0.45 and redeeming the pairs: 5.5 credits come back. */
export const saleQuote = (overrides: Partial<SaleQuote> = {}): SaleQuote => ({
  marketId: MARKET_ID,
  side: "YES",
  sharesMicro: 10_000_000,
  proceedsMicro: 5_500_000,
  averagePriceMicro: 550_000,
  costMicro: 4_500_000,
  fills: [{ priceMicro: 450_000, sharesMicro: 10_000_000, costMicro: 4_500_000 }],
  tradeSequence: 3,
  quotedAt: NOW,
  ...overrides,
});

export const sale = (overrides: Partial<Sale> = {}): Sale => ({
  tradeId: TRADE_ID,
  marketId: MARKET_ID,
  side: "YES",
  sharesMicro: 10_000_000,
  proceedsMicro: 5_500_000,
  averagePriceMicro: 550_000,
  costMicro: 4_500_000,
  fills: [{ priceMicro: 450_000, sharesMicro: 10_000_000, costMicro: 4_500_000 }],
  tradeSequence: 5,
  executedAt: NOW,
  balanceMicro: 95_500_000,
  position: { marketId: MARKET_ID, yesMicro: 8_181_818, noMicro: 0 },
  ...overrides,
});

/** A trader's portfolio: 90 credits, 18.181818 YES shares of the market, one buy. */
export const portfolio = (overrides: Partial<Portfolio> = {}): Portfolio => ({
  balanceMicro: 90_000_000,
  withdrawableCredits: 90,
  positions: [{ marketId: MARKET_ID, yesMicro: 18_181_818, noMicro: 0, question: "Will the shared market open before Friday?", status: "open", closeTime: "2026-12-31T12:00:00Z" }],
  recentTrades: [
    { tradeId: TRADE_ID, marketId: MARKET_ID, kind: "buy", side: "YES", sharesMicro: 18_181_818, costMicro: 10_000_000, proceedsMicro: null, averagePriceMicro: 550_000, tradeSequence: 4, executedAt: NOW },
  ],
  payouts: [],
  fundedMarkets: null,
  ...overrides,
});
