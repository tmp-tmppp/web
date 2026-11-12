import type { ReactNode } from "react";
import { Link } from "react-router";
import { ListFooter } from "../../components/ListFooter";
import { ProblemDisplay } from "../../components/ProblemDisplay";
import { StatusMessage } from "../../components/StatusMessage";
import { Time } from "../../components/Time";
import { formatMicroCredits, formatPrice } from "../../lib/units";
import type { PagedList } from "../../lib/use-paged-list";
import type { MarketRow } from "./use-market-rows";
import { statusWithOutcome } from "./wording";

/** The YES price of a row: the number, or why there is none (a market not open yet has no price; market-data may be away). */
function priceText(row: MarketRow): string {
  if (row.priceYesMicro !== null) return formatPrice(row.priceYesMicro);
  return row.status === "draft" || row.status === "opening" ? "Not open yet" : "Unavailable";
}

export function MarketTable({ rows, caption }: { rows: MarketRow[]; caption: string }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col">Status</th>
            <th scope="col">Closes</th>
            <th scope="col">YES price</th>
            <th scope="col">Traded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                <Link to={`/markets/${row.id}`}>{row.question}</Link>
              </th>
              <td>{statusWithOutcome(row.status, row.outcome)}</td>
              <td>
                <Time value={row.closeTime} />
              </td>
              <td>{priceText(row)}</td>
              <td>{row.volumeMicro === null ? "-" : formatMicroCredits(row.volumeMicro)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface MarketListViewProps {
  list: PagedList<MarketRow>;
  /** Names the table for a screen reader and the button that loads more: "open markets". */
  what: string;
  /** Shown instead of the table when the list is empty. */
  empty: ReactNode;
  /** A section that shows nothing at all while it is empty (drafts of an admin who has none). */
  hideWhenEmpty?: boolean;
  /** Above the table, for example why there are no prices. */
  notice?: ReactNode;
  /** A heading for the table, shown when there is a table. */
  title?: string;
}

/** A list of markets with its loading line, its failure with "try again", its empty text, the table and "load more". */
export function MarketListView({ list, what, empty, hideWhenEmpty = false, notice, title }: MarketListViewProps) {
  if (list.phase === "loading") return hideWhenEmpty ? null : <StatusMessage>Loading {what}...</StatusMessage>;
  if (list.phase === "error") {
    return (
      <div>
        <ProblemDisplay error={list.error} heading={`The ${what} could not be loaded`} />
        <button type="button" className="button button-quiet" onClick={list.reload}>
          Try again
        </button>
      </div>
    );
  }
  if (list.items.length === 0 && !list.hasMore) {
    if (hideWhenEmpty) return null;
    return (
      <>
        {notice}
        <p>{empty}</p>
      </>
    );
  }
  return (
    <>
      {title ? <h2>{title}</h2> : null}
      {notice}
      <MarketTable rows={list.items} caption={`List of ${what}`} />
      <ListFooter list={list} more={`more ${what}`} />
    </>
  );
}
