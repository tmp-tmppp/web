import { useState } from "react";
import { Link } from "react-router";
import { DEFAULT_WINDOW, OVERVIEW_WINDOWS } from "../../api/market-data-graphql";
import type { OverviewWindow } from "../../api/market-data-graphql";
import { useAuth } from "../../auth/AuthContext";
import { ListFooter } from "../../components/ListFooter";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";
import { useOrganizations } from "../../organizations/OrganizationsContext";
import { formatPrice, formatPriceChange } from "../../lib/units";
import { Sparkline } from "./Sparkline";
import { useMarketOverview } from "./use-market-overview";
import type { OverviewRow } from "./use-market-overview";
import { useTenantRole } from "./use-tenant-role";
import { statusWithOutcome } from "./wording";

/** What stands in the change and trend cells when there is nothing to draw: the history is missing, or the window holds nothing. */
const noTrendText = (row: OverviewRow): string => (row.problem === null ? "No history" : "Unavailable");

function OverviewTable({ rows, span }: { rows: OverviewRow[]; span: OverviewWindow }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{`Overview of the markets with their price, its change and its trend over ${span.phrase}`}</caption>
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col">Status</th>
            <th scope="col">YES price</th>
            <th scope="col">{`Change, ${span.label}`}</th>
            <th scope="col">Last trade</th>
            <th scope="col">Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                <Link to={`/markets/${row.id}`}>{row.question}</Link>
              </th>
              <td>{statusWithOutcome(row.status, row.outcome)}</td>
              <td>{formatPrice(row.priceYesMicro)}</td>
              <td>{row.trend ? formatPriceChange(row.trend.changeMicro) : noTrendText(row)}</td>
              <td>{row.lastTradeAt ? <Time value={row.lastTradeAt} /> : "No trade yet"}</td>
              <td>{row.trend ? <Sparkline trend={row.trend} phrase={span.phrase} /> : noTrendText(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The table of one window, with its loading line, its failure with "try again", its empty text and "load more". */
function Overview({ span }: { span: OverviewWindow }) {
  const list = useMarketOverview(span);
  if (list.phase === "loading") return <StatusMessage>Loading the market overview...</StatusMessage>;
  if (list.phase === "error") {
    return (
      <div>
        <ProblemDisplay error={list.error} heading="The market overview could not be loaded" />
        <button type="button" className="button button-quiet" onClick={list.reload}>
          Try again
        </button>
      </div>
    );
  }
  if (list.items.length === 0 && !list.hasMore) return <p>There are no markets yet.</p>;
  const missing = list.items.filter((row) => row.problem !== null);
  const reasons = [...new Set(missing.map((row) => row.problem as string))];
  return (
    <>
      {missing.length > 0 ? (
        <div className="notice-box" role="status">
          <p>
            The price history is missing for {missing.length} {missing.length === 1 ? "market" : "markets"}, so their change and trend cannot be shown. The prices are current. {reasons.join(" ")}
          </p>
          <button type="button" className="button button-quiet" onClick={list.reload}>
            Try again
          </button>
        </div>
      ) : null}
      <OverviewTable rows={list.items} span={span} />
      <ListFooter list={list} more="more markets" />
    </>
  );
}

/**
 * The market overview (requirement 17, GraphQL as a small backend-for-frontend): the tenant's markets with their current
 * YES price, its change over the chosen window, the time of the last trade and a small line of the price, all read from
 * market-data through its GraphQL endpoint. Traders and tenant admins see the same table; a platform admin has no tenant
 * and the route guard keeps them out.
 */
export function MarketDataPage() {
  const role = useTenantRole();
  const { user } = useAuth();
  const { organizations } = useOrganizations();
  const [windowId, setWindowId] = useState<OverviewWindow["id"]>("24h");
  if (!role) return null;
  const organization = organizations.find((entry) => entry.alias === user?.tenantId);
  const span = OVERVIEW_WINDOWS.find((entry) => entry.id === windowId) ?? DEFAULT_WINDOW;

  return (
    <section>
      <h1>Market data</h1>
      <p>
        {organization ? (
          <>
            Markets of <strong>{organization.name}</strong>.{" "}
          </>
        ) : null}
        The YES price of every market, how it changed, and a small line of its history. A YES price reads as a chance: 0.70 means the group thinks YES is about 70 % likely.
      </p>
      <div className="field filter-field">
        <label htmlFor="market-data-window">Show the change over</label>
        <select id="market-data-window" value={windowId} onChange={(event) => setWindowId(event.target.value as OverviewWindow["id"])}>
          {OVERVIEW_WINDOWS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div key={span.id}>
        <Overview span={span} />
      </div>
    </section>
  );
}
