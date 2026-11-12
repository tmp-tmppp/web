# web

The web UI of **Chance**: a React single-page app (Vite, TypeScript) that signs users in with OpenID Connect and calls
the services through the gateway on the same origin ([ADR-024](../private/Docs/docs/adr/0024-react-vite-spa-with-oidc.md),
requirement 15). The gateway serves it as the backend of `/` (Service `web`); every API call goes to `/v1/...` on the
same origin with the user's access token.

## What it holds

| Area | Pages | Status |
|---|---|---|
| Shell | sign-in, role-filtered menu, "not allowed", "page not found", login callback, API client | done |
| Tenants | profile, join with an invite code (also for a user who already has an organization), organization switcher, platform admin (tenants), tenant admin (invites, members, roles) | done |
| Sharing | share dialog for a market (mounted by the market page), landing page `/share` of a share link, `/share/ready` after joining | done |
| Payments | wallet: deposit, the two return pages of the payment provider, withdraw | done |
| Audit | audit log with filters, cursor pagination and the hash-chain check | done |
| Markets, trading, market-data | market list with prices and the form that makes a market, one market (price chart, buy, sell, the admin's lifecycle actions, share dialog), portfolio | done; `/market-data` is the market overview, the web client of requirement 17 (one table of the markets with prices, change and a sparkline, read through market-data's GraphQL endpoint); no placeholder is left in the route table (`src/pages/OwnedElsewherePage.tsx` is unused) |

A page replaces a placeholder by changing the `element` of its route in `src/routes/route-table.tsx`; nothing else in the
shell changes. How the pages of the tenants, payments and audit services work: [Pages](#pages); the markets, trading and
market-data pages: [Markets, trading and market-data](#markets-trading-and-market-data).

## Run locally

Needs Node.js 24 or newer. The local setup is the one of the other repositories: Keycloak from
[`identity`](../identity) (`docker compose up -d --build`, port 8081, imported with `CHANCE_WEB_URL=http://localhost:5173`)
and a gateway on `http://localhost:8000` that routes `/v1/...` to the services.

```bash
npm ci
npm run dev        # http://localhost:5173 (the port is fixed: the realm and payments expect it)
```

`npm run dev` forwards `/v1` and `/checkout` to the gateway, so the browser sees one origin as in the cluster. Another
gateway: `GATEWAY_URL=http://host:port npm run dev`. The login talks to Keycloak directly, at the `issuer` of
`public/config.json` (default `http://localhost:8081/realms/chance`). PKCE needs a secure context: https, or `localhost`.

The checks (each is also a CI step):

```bash
npm run lint          # ESLint, type-aware, with the React hooks rules
npm run typecheck     # tsc --noEmit, strict
npm test              # Vitest + Testing Library + MSW; add -- --coverage for the 80 % gate on src
npm run build         # type check, then Vite build into dist/
npm run preview       # serves dist/ on :4173 with the same proxy
```

Tests need no network, Keycloak or Docker: the API is mocked with MSW and the OIDC client is a fake. Coverage is
checked on `src` (lines, functions and statements at 80 %), except the entry file `src/main.tsx` and files that hold
only types. Every mock handler is made with `contractHandler` (`tests/support/contract.ts`), which checks each request
the pages send and each answer the handler gives against the OpenAPI files in `contracts/`; a violation fails the test
(`tests/setup.ts`). `tests/contract-validator.test.ts` feeds the checker requests and answers the contracts forbid, so
it cannot pass everything. Polling is tested with fake `setTimeout` (`tests/support/clock.ts`).

## Contracts

`contracts/{tenants,payments,audit,markets,trading,market-data}.openapi.yaml` are copies of the `contracts/openapi.yaml` of the six services;
the services' files are the truth. When the sibling folders `../tenants`, `../payments`, `../audit`, `../markets`, `../trading` and
`../market-data` exist, a test fails if a copy differs from the original; update a copy by copying the file again. `markets` and
`market-data` both have an operation `listMarkets` and `getMarket`: a test handler names the first file's by the plain id and
the other by `"<file>:<operationId>"` (`contractHandler("market-data:listMarkets", ...)`).

`contracts/market-data.graphql` is the copy of `market-data/contracts/graphql/schema.graphql`, the contract of the GraphQL endpoint
(`POST /v1/market-data/graphql`, requirement 17), which the OpenAPI file does not describe. The same drift test compares the two files byte for byte
(`tests/contract-validator.test.ts`); update the copy by copying the file again. The `graphql` package is a dev dependency only
(exact version of market-data's, 16.14.2): the tests build a mock endpoint from the schema file (`tests/support/graphql.ts`: it parses and
validates each request, applies the service's limits on body size, query length, depth and complexity, and runs the test's resolvers),
and `tests/market-data-graphql.test.ts` validates the page's query documents against it. The app itself sends a plain `{ query, variables }` body
and ships no GraphQL library.

## Runtime configuration

One image fits every environment: the app reads `/config.json`, served next to the files, before it starts
(`src/config/runtime-config.ts`). Nothing in it is secret. A missing or wrong setting stops the app with a message
that names the setting.

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `issuer` | yes | none | Address of the Keycloak realm, also the issuer of the tokens, e.g. `https://chance.example/realms/chance` |
| `clientId` | no | `web` | The public OIDC client of the realm |
| `apiBase` | no | `""` | Prefix of every API call; empty means the same origin, which is the normal case |
| `depositSuccessPath` | no | `/deposits/success` | Where the payment page sends the buyer after paying; must equal payments' `DEPOSIT_SUCCESS_URL` path |
| `depositCancelPath` | no | `/deposits/cancelled` | Same after declining; payments' `DEPOSIT_CANCEL_URL` path |
| `auditExportUrl` | no | none | Address of the audit-export function (proposed serverless export, built locally, not deployed), e.g. `https://chance-audit-export.example/api/audit-export`, without a query. Only when it is set does the audit page show the **Export** control; its origin is added to `connect-src` when the container starts. `public/config.json` leaves it out |

## Sign-in and roles

- **Flow.** Authorization code with PKCE (S256) against the realm `chance`, client `web`, through
  [oidc-client-ts](https://github.com/authts/oidc-client-ts) 3.5.0. Checked in its source (`dist/esm/oidc-client-ts.js`):
  the sign-in request carries `code_challenge_method=S256`, `signinSilent` uses the refresh token when there is one,
  `signoutRedirect` removes the user and sends `id_token_hint` and `post_logout_redirect_uri`. A test builds the real
  sign-in request from our settings and checks the challenge.
- **Redirect addresses.** `<origin>/auth/callback` after the login and `<origin>/` after the logout; the realm allows
  `${CHANCE_WEB_URL}/*`. Only a path of this app is accepted as the page to return to.
- **Where tokens live.** In `sessionStorage` (the library's user store and its short-lived login state), never in
  `localStorage`: a lint rule forbids the name, and a test checks where the library writes. The access token lives
  five minutes; `AuthProvider` renews it silently with the refresh token (used once, as the realm demands) when the
  library says it is about to expire. Every renewal (start-up, a token request, a session refresh, the expiring token)
  goes through one shared call, so two of them never send the same refresh token twice; the library's own renewal timer
  is off. A session that cannot be renewed ends with a message on the sign-in page.
- **What the UI reads from the token (token contract v2).** The token holds exactly one organization: the tenant
  is its alias in the `organization` claim (two organizations are refused, as the services do) and the tenant role
  (`tenant-admin` or `trader`) is the one group of that organization in `organization.<alias>.groups` (`/tenant-admin`
  or `/trader`). `platform-admin` is a realm role in `realm_access.roles`; a realm role `trader` or `tenant-admin` counts
  for nothing. The signature is not checked in the browser: this only decides what the menu shows, and every service
  verifies the token itself. A new user has **no app role until the first invite code is accepted**; the join page is
  open to every user except a platform admin, because an invite adds a further organization.
- **Organizations and the switcher.** A user may belong to several organizations. `GET /v1/me/organizations` (all pages,
  read by `OrganizationsProvider` in the layout) lists them; the header shows the name of the only one, or a list for
  several (`OrganizationSwitcher`). A choice is a new sign-in with the scope `chance-organization:<alias>` (the alias is the
  tenant id), coming back to the same page; the single sign-on session of the identity provider normally answers without
  a form. The first sign-in asks for the plain scope `chance-organization`, so Keycloak lets a member of several
  organizations pick one. Credits stay per organization: the wallet shows the organization of the token.
- **After joining.** The old token has no tenant yet. `refreshSession()` of the auth context renews the tokens with the
  refresh token, so the new role and tenant reach the app (the profile page offers it when `GET /v1/me` says
  `tokenNeedsRefresh` or `identityPending`).

## Routes and access

The route table `src/routes/route-table.tsx` is the one place that lists pages. The router, the menu and the guard all
read it, so a page that is hidden from the menu is also refused at its address ("Not allowed", with a link to the join
page for a user without a tenant). The API stays the real check.

| Address | Who | Menu entry |
|---|---|---|
| `/profile` | any signed-in user | Profile |
| `/join` | any signed-in user except a platform admin | Join an organization |
| `/share`, `/share/ready` | `/share`: anybody, also without a session; `/share/ready`: trader or tenant admin, in a tenant | none |
| `/markets`, `/markets/:marketId`, `/portfolio`, `/market-data` | trader or tenant admin, in a tenant | Markets, Portfolio, Market data |
| `/wallet`, the two deposit return paths from the configuration | trader or tenant admin, in a tenant | Wallet (return pages: none) |
| `/admin/members`, `/admin/invites`, `/audit` | tenant admin, in a tenant | Members, Invites, Audit log |
| `/platform/tenants` | platform admin | Tenants |

`/` goes to the first page that fits the user: the tenants for a platform admin, `/join` before joining, otherwise
`/markets`.

## API client

`src/api/client.ts`, reached in components with `useApi()`:

- `Authorization: Bearer <access token>` and a new `X-Correlation-Id` (a UUID) on every request; no cookies are sent
  and no answer is cached by the browser (the gateway also sends `Cache-Control: private, no-store`, INF-02).
- JSON in and out. `Idempotency-Key` is set with the `idempotencyKey` option; make the key once per attempt with
  `newIdempotencyKey()` (`src/lib/ids.ts`); the forms that send one (buy, sell, deposit, withdraw) get it from
  `useIdempotencyKey(scope)`, which also keeps it across a reload (see "Buy and sell"). `request()` also returns the status and headers (a `202` with its status link).
- Every error answer becomes an `ApiError` (`src/api/errors.ts`) built from the RFC 9457 problem: `status`, `type`,
  `title`, `detail`, `code`, `fieldErrors`, `retryAfterSeconds` (from `Retry-After`, seconds or a date) and the
  `correlationId`. A body that is no problem (a proxy's HTML page) gets plain wording for its status, never the body.
  A network failure is an `ApiError` with status 0. `outcomeUnknown` says that the request may have been decided although
  no usable answer came, so a page must not say that nothing was done: it is true for status 0, for a success status (2xx)
  whose body could not be read (the client's "The server sent an answer the app cannot read", which carries the status of the
  answer: a proxy's page instead of JSON, or a body that broke off, which the client turns into the same error, never a raw
  `TypeError`) and for a 5xx other than 503
  whose `code` is null (a gateway's `502` or `504` page, a body that is not our problem+json) or `internal_error` (the service
  failed and may have committed). A 503 (not taken on) and a 5xx that carries one of our services' own refusal codes (the only
  documented one is markets' `502 funding_rejected`, "nothing was funded") are definite answers.
- A `401` renews the session once and repeats the request; if it stays, the session ends and the sign-in page shows.
- `<ProblemDisplay error={...} />` shows an error as title, detail, invalid fields, how long to wait and the reference
  to quote when asking for help; never a stack or JSON.

## Pages

Every error answer is shown as its problem title and detail (`ProblemDisplay`), with the wait of a `503 Retry-After`;
every page that reads data has a loading line, an empty state and a "try again". Forms check what the contract limits
before they send anything, and name the field in words. After a navigation the focus goes to the page (`<main>`), and a
secret shown once gets the focus when it appears.

| Page (route) | What it does | API |
|---|---|---|
| Profile (`/profile`) | user, tenant, role. While `identityPending` it asks again every 5 seconds (for about 2 minutes, then a button), because refreshing the token cannot help before the identity provider caught up; when only `tokenNeedsRefresh` is true it renews the session once and reads again, so the menu follows | `GET /v1/me` |
| Join (`/join`) | invite code (16 to 128 characters), then the profile with a "you joined" note and a fresh list of organizations; 404 and 410 get a hint | `POST /v1/invites/{code}/accept` |
| Tenants (`/platform/tenants`) | list, oldest first, with "load more"; create a tenant (name, slug) and show the first admin's invite code once, with a copy button | `GET`, `POST /v1/tenants` |
| Invites (`/admin/invites`) | role, number of uses and validity; the code is shown once (the service keeps only its hash) | `POST /v1/tenants/{id}/invites` |
| Members (`/admin/members`) | members page by page; a role change per member, the 409 for the last tenant admin shown in the service's words | `GET /v1/tenants/{id}/members`, `PUT .../members/{userId}/role` |
| Wallet (`/wallet`) | deposit and withdraw; amounts in credits with the euro value beside them (1 credit = 1 EUR cent) | below |
| Deposit return (paths from the configuration) | polls the deposit every 2 seconds until `succeeded` or `failed`, showing "processing" meanwhile (DM-13); after 2 minutes a "check again" button | `GET /v1/deposits/{id}` |
| Audit log (`/audit`) | entries newest first, filters (event types, from, to, correlation id, actor, subject), "load older entries", entry details, "verify" with the first broken `seq` and `503 verify_busy` with its wait | `GET /v1/audit`, `GET /v1/audit/verify` |

**Deposit.** The page makes one `Idempotency-Key` per attempt and keeps it while the same amount is repeated after a
`503` or a lost answer (the service then finishes the first try instead of making a second one); a definitive answer or
another amount makes a new key (the key of an amount whose answer was lost is kept, so going back to that amount sends it again). The answer's `checkoutUrl` (http or https only) is where the browser goes; the deposit id
is kept in `sessionStorage` (`chance.deposit-id`) for the return page. The return addresses are the service's settings, so
the page never sends them.

**Withdrawal.** `202` and `200` show the withdrawal, which the page follows (`GET /v1/withdrawals/{id}`, by the id of the
answer) until `paid_out`, `rejected` or `refunded`; `failed` is not final (trading refunds), so it keeps asking. Plain
wording for each status; `409 insufficient_credits` and `503 trading_unavailable` (with `Retry-After`) are shown as such.
Both name a withdrawal the service stored as rejected and answers again with the same rejection for the same key, so the
next press makes a new key; a `503` that stores nothing (`tenant_not_ready`, `withdrawal_busy`) or a lost answer keeps it.

## Layout of `src`

| Path | What |
|---|---|
| `main.tsx`, `Bootstrap.tsx`, `App.tsx` | entry, configuration loading, providers |
| `config/` | `/config.json` loader and its validation |
| `auth/` | OIDC client settings, auth context, token reading, access rules |
| `api/` | client, typed errors, context; `tenants.ts`, `payments.ts`, `audit.ts`, `markets.ts`, `trading.ts`, `market-data.ts`: the requests and answers of each service |
| `routes/` | route table, router, guard |
| `components/` | layout, problem display, form field, table footer, one-time code box |
| `pages/` | shell pages and the one placeholder left; `platform/`, `admin/`, `wallet/`, `audit/`, `share/`, `markets/` (market list, market page, portfolio) and the profile and join pages |
| `lib/` | `usePagedList` (cursor lists), `usePolling`, `useIdempotencyKey`, formatting, numbers, `units.ts` (micro-units of trading and market-data) |
| `styles.css`, `pages.css` | all styling, light and dark, phone width; no inline styles |

## Markets, trading and market-data

`src/pages/markets/` holds the pages of the three services of the market side. Amounts are whole credits in requests
(`amount`, `fundingAmount`) and exact integers in micro-units in every answer of trading and market-data (ADR-055: 1 credit =
1 share = 1 000 000; a price is microcredits per share, 550000 is 0.55). `src/lib/units.ts` formats them from the integers
(credits and shares with two decimals, prices as 0.xx) and computes sums and products with `BigInt`; no money is computed
with floating point. The starting YES price of a new market is the one number that is sent as a decimal (`0.35`, two
decimals): the form reads it as whole cents and divides by 100.

| Page (route) | What it does | API |
|---|---|---|
| Markets (`/markets`) | The tenant's open, closed and resolved markets with the current YES price and what was traded, a status filter, "load more". When market-data answers 5xx or not at all, the list comes from the markets service without prices and says so (the plan's fallback; the cursor of each page remembers which service it belongs to). A 4xx is shown as the problem it is, not as a fallback. Tenant admins also see their drafts and the markets being opened (only the markets service has them) and the form that makes a draft: question, description, close time, starting YES price 0.01 to 0.99, funding, who may share; the service's field errors (`errors` of the problem) are shown under their fields | `GET /v1/market-data/markets`; fallback and admin lists `GET /v1/markets`; `POST /v1/markets` |
| Market (`/markets/:marketId`) | Header (question, status, close time, outcome), price and a hand-made SVG staircase chart of the YES price (no chart library; the numbers are in a table for people who cannot use the picture), the share dialog. A trader also gets the balance and position and the buy and sell forms while the market is open; a tenant admin gets the lifecycle actions instead and never the trading forms (the service answers 403 to an admin's order) | below |
| Market data (`/market-data`) | The overview of the tenant's markets (requirement 17, GraphQL as a small backend-for-frontend): a table with the question (a link to `/markets/:id`), the status, the current YES price (0.xx), the change over a window (24 hours or 7 days, a select), the time of the last trade and a small inline SVG sparkline whose `<title>` says in words where the price went ("YES price over the last 24 hours: from 0.50 to 0.55, lowest 0.48, highest 0.57."). The change is the difference of two integers: the current price minus the latest price before the window, or the opening price of the first bucket when the market opened inside it; it is written with its sign (`formatPriceChange`). "Load more markets" follows `pageInfo.endCursor`. The **schema has no history inside a market and no batch history**, so one query cannot carry both: each page is two queries to the same endpoint, `MarketOverview` (a page of 10 markets with their prices) and `MarketSparklines` (one aliased `history` field per market of that page, the interval 1 hour for 24 hours and 4 hours for 7 days, the start now minus the window rounded up to a bucket start, one page of buckets with one spare for a browser clock behind the server's). Ten markets per page keep the second query under 60 % of the service's complexity limit (5000; a page of 20 over 7 days would not fit: a test says so). A failure of one history (`history_paused`, `not_found`, ...) is an error with the path of its alias: that market shows "Unavailable" and the others keep their trend; a failure of the whole second query leaves the prices and says the change and trend are missing, with "Try again". A failure of the first query is the problem it is. `errors[].extensions.code` decides the words (`src/api/market-data-graphql.ts`: every code of the README of market-data, never the service's own message); a refusal of the whole request (HTTP 400, 401, 403 or 503 with the GraphQL error shape) is worded by its code as well, through `ApiError.graphqlError`, with the wait of `Retry-After`; any other failed answer (a gateway page, no answer) is the client's `ApiError` as everywhere | `POST /v1/market-data/graphql` (`markets`, `history`) |
| Portfolio (`/portfolio`) | Balance and what may be withdrawn, positions with the current price and what they are worth (one batch call to market-data for every market the page mentions, never one per position; a market resolved INVALID counts for nothing because its stakes were refunded), trades, payouts, refunds and returned funding; tenant admins also see the markets they funded and what came back. Without market-data everything but the prices still shows | `GET /v1/trading/portfolio?limit=50`, `GET /v1/market-data/markets?ids=` |

**Buy and sell.** Both are two steps, a quote and then the order. The order carries a new `Idempotency-Key` per attempt
(`useIdempotencyKey(scope)`: kept while the same order is repeated after a lost answer, a `429`, a `503` or a server failure
that may have been decided (`ApiError.outcomeUnknown`: a `500` `internal_error` or without a code, a gateway's `502` or `504`),
so the service finishes the first try instead of buying twice; new after a success, a refusal (a `5xx` with a refusal code of
ours included) or when the order changes). The attempts that have no settling answer are also kept in `sessionStorage` under
`chance.pending-key.<user>.<tenant>.<scope>` (`buy:<marketId>`, `sell:<marketId>`, `deposit`, `withdraw`; the user's id and the
tenant are part of the name, so a person who signs in in the same tab never finds or sends the key of another): up to five
per form, each `{ signature, key, at, payload? }`, written when the key is made or reused, removed when the attempt ended with
an answer that settles it (`done()` settles only the attempt of the last `keyFor`, so a refusal of another amount in between
does not forget a request whose answer was lost: lost 100, refused 200, 100 again sends the key of the first 100) or a day
after the key was made (trading keeps an order's key 7 days), read back when the form mounts. An error that is not an answer
of the service keeps the key (keeping is always safe, dropping is not). So a lost answer followed by a reload of the page
repeats the same request under the same key instead of making a second order, deposit or withdrawal; a different amount
or order is a new request with a new key. Nothing else is stored (the signature and the payload hold what the request holds,
never a token); a storage that throws (private mode, quota) leaves the key in memory only, and a removal that fails is
retried as an overwrite with an empty list, so the key of an attempt that ended is not found again.

The price limit is part of the request that trading checks with the key, and a reload loses the quote it comes from; the
person's own order moves the price, so the new quote has another limit, which would be another request (a second order).
The buy and the sell form therefore keep the whole request as the attempt's `payload` (`marketId`, side, amount and
`maxAveragePriceMicro`; or shares and `minProceedsMicro`) and, when the form opens with such an attempt, show "An order (a
sale) you sent earlier may have gone through" with "Send the same order (sale) again", which sends exactly the stored body
under the stored key without a new quote (the service answers with the first result when it was made and makes it once when
it was not), a link to the portfolio, and "Forget this order (sale)", the person's explicit decision. The box is not shown
while the quote on the screen is that very request (its own button repeats it). A stored payload that is not an order or a
sale of this market is ignored. The order carries
a price limit (DM-18): the quoted
average price plus 1 % for a buy (`maxAveragePriceMicro`, never above 0.999999; shown as a price, never above 0.99, by `formatPriceLimit`),
the quoted proceeds minus 1 % for a sale
(`minProceedsMicro`). When the price moved after the quote (`409 price_limit_exceeded`, `proceeds_below_minimum`) nothing was
traded: the page shows a fresh quote and asks again. The answer of a trade carries the new balance, the position and the
market's trade sequence, which the page shows at once (DM-17). When the answer is lost or is a server failure that names no
refusal of the service (`ApiError.outcomeUnknown`), the form does not say "Nothing was bought": it says it does not know yet whether the order went
through and asks to press the same button again, which repeats the request under the same key; it does not invite a new quote,
whose changed limit would be a new request. After a trade or an admin action the focus moves to the message that reports it
(`useFocusOnShow`), because the button that was pressed is gone.

**The chart after a trade.** The sequence of the trade goes to market-data as `afterSequence`; it answers `409 updating` until
it has that trade. The chart asks again every 500 ms for about 2 seconds ("waiting for your trade"), then says "Updating", that the
trade is made and the balance is right, and offers "Check again". A failure of market-data never blocks trading: the forms stay.

**Lifecycle (tenant admin).** Open (only the creator of the draft: their credits fund it), close, and resolve as YES, NO or INVALID,
each behind a confirmation whose text takes the focus (Escape or Cancel gives it back to the button). Open can answer `202`: the market
is then "opening" and the page reads it every 2 seconds (for up to 2 minutes, then a "Check again" button; the service goes on in
the background) until it is open, or a draft again. A read that fails with no answer, `429` or a gateway's `502`, `503` or `504`
is shown and tried again; any other failure stops the polling (`PollState.stopped`) and the same "Check again" button starts it
again. `409 insufficient_credits`, `502 funding_rejected`, `503 trading_unavailable`,
`409 invalid_state` and `403` each get a sentence of advice beside the problem; every answer but a `403` makes the page read the
market again, so what it shows is what the service has. When the answer is lost (`ApiError.outcomeUnknown`: no answer, or a
`5xx` other than `503` with no code or `internal_error`) the message is not "The action was not done" but "We do not know yet whether the market was closed" (opened,
resolved), the market is read again and the person is asked to check its status before trying again, as the buy and sell forms do.
The service's own `502 funding_rejected` is a definite answer by the same rule (no page-level exception): it keeps "The action was not done" and its sentence.
The lifecycle actions send no `Idempotency-Key` of their own (markets derives one from the market id and answers a repeated open with `202` while it is `opening`).

**Who sees what.** The role comes from the token (`useTenantRole`). A platform admin and a user without a tenant are refused by
the route guard and the pages show nothing of a tenant. A trader asking for a draft gets the service's 404.

**Tests.** `tests/markets-list.test.tsx`, `tests/market-page.test.tsx`, `tests/trading.test.tsx`, `tests/portfolio.test.tsx` and
`tests/price-chart.test.tsx` (the chart, the market-data and trading requests) use mock handlers checked against the contracts, and
`tests/units.test.ts` and `tests/money-format.test.ts` the money arithmetic. `tests/market-data-page.test.tsx` is the market
overview (the happy path, empty, every error code, an HTTP error, a failed history, the window switch, pages, the sparkline's text,
who may open it) against the mock GraphQL endpoint of `tests/support/graphql.ts`; `tests/market-data-graphql.test.ts` validates the
documents against the schema file, checks the limits, the words of the codes, the change and the drawing. `tests/market-resilience.test.tsx` covers a lost or
gateway answer (the same key, also after a reload, also when the quote after the reload has moved and the earlier order or sale is offered
exactly as it was sent, a success status whose body cannot be read, another person in the same tab, the wording, the opening poll that goes on or stops), a double click on a buy or a sale, leaving the
page during the poll and the focus after an action; its gateway answers are plain `msw` handlers, because a 502 or 504 is not
in the contracts. `tests/errors.test.ts` is the table of `outcomeUnknown` and `tests/use-idempotency-key.test.tsx` the hook
(a reload is an unmount and a new mount with the `sessionStorage` kept; several attempts per form, a storage that fails halfway,
the user in the name, the age limit, the pending request and `discard()`); `tests/wallet-pending.test.tsx` is a withdrawal that
is lost, another amount that is refused and the first amount again. Timers of the opening poll and of the chart's `updating` wait are fake (`tests/support/clock.ts`);
a test that waits on a fake clock gives `findBy...` a longer `timeout`, because Testing Library moves the fake clock 50 ms per step.

## Serving it

`npm run bundle` (or `npm run build`, which type-checks first) writes `dist/`. The `Dockerfile` has two stages: the
pinned Node.js bundles the app, and a pinned unprivileged nginx (`nginxinc/nginx-unprivileged`, Alpine, stable branch,
tag and digest; Dependabot proposes updates) serves it on port 8080 as user 101. The server block is
`nginx/default.conf.template`, the headers of every response `nginx/security-headers.conf`.

| Request | Answer |
|---|---|
| `/assets/...` (hashed names) | `Cache-Control: public, max-age=31536000, immutable`; a missing file is a 404 |
| `/index.html`, `/config.json`, other files | `Cache-Control: no-cache` (revalidated with the ETag); a missing file is a 404 |
| any path without a file extension (`/wallet`, `/auth/callback`, ...) | `index.html` (client-side routes) |
| `/v1/...` (the gateway sends unmatched paths to this server) | 404 problem, `Cache-Control: private, no-store` |
| `/healthz` | `ok`, never cached, not logged (probes and the image's health check) |
| not GET or HEAD | 405 |

Every response has `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a
`Permissions-Policy` and cross-origin policies; `server_tokens` is off; text is gzipped. Strict transport security is the
gateway's job (it ends TLS). The document carries the Content-Security-Policy: `default-src 'self'`, no inline script or
style, `connect-src 'self'` plus the origin of the issuer (and the origin of `auditExportUrl` when `config.json` has
one), `frame-ancestors 'none'`, `form-action 'self'`.

The issuer is only known at run time, so `nginx/18-chance-csp.envsh` reads it from `config.json` when the container
starts and the entrypoint renders the template with it (the same for the optional `auditExportUrl`, which is always
exported, empty when absent, because the image's envsubst step leaves an undefined variable in the header). Only a
plain http(s) origin is accepted (host name or IPv4 address, optional port); anything else stops the container with a
message. A new issuer is a new `config.json` and a
restart, never a new image. The image's own `config.json` holds the development defaults.

Local run of the image: `docker compose up --build` (http://localhost:5173, the address the realm allows; read-only
file system, no capabilities; `CHANCE_WEB_CONFIG=./other.json` mounts another config). It serves the static files only:
the API calls need the gateway in front (use `npm run dev` for the pages with data). Writable folders are `/tmp` and
`/etc/nginx/conf.d` (the entrypoint renders the server block there), which `compose.yaml` and the chart mount as memory
or empty-dir volumes owned by user 101.

Helm chart `helm/` (release name `web`: the Service has the release's name and the gateway routes "/" to `web:8080`):
`values.yaml` documents every key; `config` is rendered into `config.json` of a ConfigMap and mounted over the file in the
image, and a change restarts the Pods; `networkPolicy.enabled` (off by default) admits only the gateway; `helm test` runs
the smoke test (health endpoint, `config.json` names an issuer, `index.html` is `no-cache`). The pipeline passes
`image.repository`, `image.tag` and `image.digest`. `config.issuer` in `values-prod.yaml` is empty on purpose (the schema
accepts an empty issuer, so the chart still renders): its value, `https://<public host>/realms/chance`, comes from the
pipeline's public host (plan INF-01). A deploy without it stops the container at start (`18-chance-csp.envsh` finds no
`"issuer"` that is an http(s) URL; the Pod restarts and the deploy rolls back) instead of serving a page whose sign-in
goes to localhost. The deposit return paths (`depositSuccessPath`, `depositCancelPath`) are paths on the same host, not
addresses, so nothing there depends on the public host. `.github/workflows/ci-cd.yml` calls the organization's shared workflow with `service: web`.

```bash
helm lint helm -f helm/values-prod.yaml --set-string image.tag=sha-test
helm template web helm -n prod -f helm/values-prod.yaml --set-string image.tag=sha-test | kubeconform -strict -summary -kubernetes-version 1.35.0 -
```

## Dependencies

Pinned exactly in `package.json` (with `package-lock.json`); versions looked up on the npm registry on 2026-11-11.
Test-only additions of stage 2: `ajv` 8.20.0 (draft 2020-12, as OpenAPI 3.1 schemas), `ajv-formats` 3.0.1 and `yaml` 2.9.1,
which read the contracts and check requests and answers. TypeScript stays on 6.0.3 because typescript-eslint 8.72 supports it up to 6.0 (`<6.1.0`); 7.0 is newer than that range.

## Sharing a market by link

A market has a sharing policy, fixed when it is created (`Market.sharing`: who may share, and which link types). A link has
a type chosen by the sharer: `members` (people of the market's organization), `profiles` (the listed e-mail addresses, matched
against the verified address in the token) or `everyone`. The link is `<origin>/share#<token>`: the token (32 random bytes,
base64url) sits after `#`, so no server, proxy or access log ever sees it; the pages post it in a request body and never
write it to an address, a log or a storage.

- **Share dialog** (`src/components/ShareDialog.tsx`). Props: `marketId` (uuid), `sharing` (`Market.sharing`), `role`
  (`"trader"` or `"tenant-admin"`, from the token) and `marketStatus` (`Market.status`: only an open, closed or resolved
  market can be shared). It offers only the link types the policy allows for that role (`linkTypesFor`), the addresses of
  a `profiles` link (comma, space or line separated, at most 50), an expiry (none, 1, 7 or 30 days), then shows the
  address once with Copy (Clipboard API, with a selected-text fallback) and, where the device has it, the Web Share
  sheet. Below it the links of the market with their state and Revoke. The market page renders one
  line: `<ShareDialog marketId={market.id} sharing={market.sharing} role={role} marketStatus={market.status} />`.
- **Where it is mounted.** The market page (`src/pages/markets/MarketPage.tsx`) renders the dialog once it has read the
  market with `GET /v1/markets/{id}`; tenant admins and traders both get it, for an open, closed or resolved market.
- **Landing page** (`/share`, `src/pages/share/SharePage.tsx`), open without a session. The token is read from the
  address once and removed from the address bar, then `POST /v1/shared-markets/lookup` says what the link shows and what
  the caller may do (`next`): `sign_in` (a link for everyone shows the market first, the sign-in comes back with the
  token), `join` (`POST /v1/share-joins`, wait until `identityPending` is false, sign in again for that organization,
  `/share/ready?market=<id>`), `switch_organization` (a members link while signed in for another organization: the page
  names the organization and offers the switch when the caller belongs to it), `trade` (open the market). A refusal
  names the organization and nothing more; an unknown, expired or revoked link is one "does not work" text. Trading
  needs credits in that organization, so every case that can lead to trading says so and links to the wallet.
- **Tests.** `tests/share-dialog.test.tsx`, `tests/share-page.test.tsx` and `tests/organizations.test.tsx` use mock handlers
  checked against `contracts/*.openapi.yaml` (the lookup has an optional bearer token: `security: [{}, {bearerAuth: []}]`).
