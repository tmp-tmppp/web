import { useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useOrganizations } from "../../organizations/OrganizationsContext";
import type { MarketStatus } from "../../api/markets";
import { MarketListView } from "./MarketTable";
import { CreateMarketForm } from "./CreateMarketForm";
import { useDataRows, useMarketsRows } from "./use-market-rows";
import { useTenantRole } from "./use-tenant-role";
import { STATUS_LABELS } from "./wording";

type Filter = "all" | MarketStatus;

const TRADER_FILTERS: readonly Filter[] = ["all", "open", "closed", "resolved"];
const ADMIN_FILTERS: readonly Filter[] = ["all", "draft", "opening", "open", "closed", "resolved"];

const filterLabel = (filter: Filter): string => (filter === "all" ? "All markets" : STATUS_LABELS[filter]);

/** open, closed and resolved markets with their prices; market-data answers them, the markets service stands in when it is away. */
function DataMarkets({ status, hideUnopened, title }: { status: "open" | "closed" | "resolved" | undefined; hideUnopened: boolean; title?: string }) {
  const list = useDataRows(status, hideUnopened);
  const what = status ? `${status} markets` : "markets";
  const notice = list.withoutPrices ? (
    <div className="notice-box" role="status">
      <p>
        Prices are not available right now, so this list comes from the markets service and shows no prices. Trading is not affected.
      </p>
      <button type="button" className="button button-quiet" onClick={list.reload}>
        Try again
      </button>
    </div>
  ) : null;
  const empty = status ? `There are no ${status} markets.` : "There are no markets yet.";
  return <MarketListView list={list} what={what} empty={empty} notice={notice} {...(title ? { title } : {})} />;
}

/** Drafts and markets being opened: only the markets service has them, and only tenant admins see them. */
function UnopenedMarkets({ status, title, hideWhenEmpty }: { status: "draft" | "opening"; title: string; hideWhenEmpty: boolean }) {
  const list = useMarketsRows(status);
  return (
    <MarketListView
      list={list}
      what={status === "draft" ? "drafts" : "markets being opened"}
      empty={status === "draft" ? "There are no drafts." : "No market is being opened."}
      hideWhenEmpty={hideWhenEmpty}
      title={title}
    />
  );
}

function Lists({ filter, admin }: { filter: Filter; admin: boolean }): ReactNode {
  switch (filter) {
    case "all":
      return admin ? (
        <>
          <UnopenedMarkets status="draft" title="Drafts" hideWhenEmpty />
          <UnopenedMarkets status="opening" title="Being opened" hideWhenEmpty />
          <DataMarkets status={undefined} hideUnopened title="Open, closed and resolved" />
        </>
      ) : (
        <DataMarkets status={undefined} hideUnopened={false} />
      );
    case "draft":
    case "opening":
      return <UnopenedMarkets status={filter} title={STATUS_LABELS[filter]} hideWhenEmpty={false} />;
    default:
      return <DataMarkets status={filter} hideUnopened={false} />;
  }
}

/**
 * The tenant's markets (UC-03): the current YES price of every open, closed and resolved market from market-data, with a
 * status filter. Tenant admins also see their drafts and the markets being opened (the markets service has those) and the
 * form that makes a draft. When market-data is down the list comes from the markets service without prices.
 */
export function MarketsPage() {
  const role = useTenantRole();
  const { user } = useAuth();
  const { organizations } = useOrganizations();
  const [filter, setFilter] = useState<Filter>("all");
  const [version, setVersion] = useState(0);
  if (!role) return null;
  const admin = role === "tenant-admin";
  const organization = organizations.find((entry) => entry.alias === user?.tenantId);
  const filters = admin ? ADMIN_FILTERS : TRADER_FILTERS;

  return (
    <section>
      <h1>Markets</h1>
      <p>
        {organization ? (
          <>
            Questions of <strong>{organization.name}</strong>.{" "}
          </>
        ) : null}
        A YES price reads as a chance: 0.70 means the group thinks YES is about 70 % likely. The NO price is 1 minus that.
      </p>
      {admin ? <CreateMarketForm onCreated={() => setVersion((value) => value + 1)} /> : null}
      <div className="field filter-field">
        <label htmlFor="market-filter">Show</label>
        <select id="market-filter" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
          {filters.map((entry) => (
            <option key={entry} value={entry}>
              {filterLabel(entry)}
            </option>
          ))}
        </select>
      </div>
      <div key={`${filter}-${version}`}>
        <Lists filter={filter} admin={admin} />
      </div>
    </section>
  );
}
