import { Link } from "react-router";
import { LINK_TYPE_LABELS } from "../../api/markets";
import type { Lookup, MarketStatus } from "../../api/markets";
import { Time } from "../../components/Time";

const STATUS_TEXT: Record<MarketStatus, string> = {
  draft: "Not open yet",
  opening: "Opening",
  open: "Open for trading",
  closed: "Closed",
  resolved: "Resolved",
};

/** The address after joining or switching: the page that says where the user is and opens the market. */
export function readyPath(marketId: string): string {
  return `/share/ready?market=${encodeURIComponent(marketId)}`;
}

/** What a share link shows about its market: the question, the organization, the state and the closing time. Nothing else is known to the page. */
export function MarketSummary({ lookup }: { lookup: Lookup }) {
  return (
    <div className="card">
      <h2>{lookup.market.question}</h2>
      <dl className="details">
        <dt>Organization</dt>
        <dd>{lookup.organization.name ?? "Not named"}</dd>
        <dt>State</dt>
        <dd>{STATUS_TEXT[lookup.market.status]}</dd>
        <dt>Closes</dt>
        <dd>
          <Time value={lookup.market.closeTime} />
        </dd>
        <dt>This link is for</dt>
        <dd>{LINK_TYPE_LABELS[lookup.linkType]}</dd>
      </dl>
    </div>
  );
}

/** Credits belong to one organization: a trader needs some in the organization of the market, and the wallet shows exactly those. */
export function CreditsHint({ organization }: { organization: string }) {
  return (
    <p className="hint" data-testid="credits-hint">
      Trading uses credits, and credits are kept per organization: your balance in {organization} is separate from your other organizations. Add credits in{" "}
      <Link to="/wallet">the wallet</Link> after you are signed in for {organization}.
    </p>
  );
}
