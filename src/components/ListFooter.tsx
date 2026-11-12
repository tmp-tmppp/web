import type { PagedList } from "../lib/use-paged-list";
import { ProblemDisplay } from "./ProblemDisplay";
import { StatusMessage } from "./StatusMessage";

interface ListFooterProps {
  list: Pick<PagedList<unknown>, "hasMore" | "loadingMore" | "loadMore" | "error" | "phase">;
  /** What the next page holds, for the button: "more members", "older entries". */
  more: string;
}

/** Under a table: the "load more" button of cursor pagination, its progress and the failure of a page that did not load. */
export function ListFooter({ list, more }: ListFooterProps) {
  return (
    <div className="list-footer">
      {list.phase === "ready" && list.error ? <ProblemDisplay error={list.error} heading={`Could not load ${more}`} /> : null}
      {list.loadingMore ? <StatusMessage>Loading {more}...</StatusMessage> : null}
      {list.hasMore ? (
        <button type="button" className="button button-quiet" onClick={list.loadMore} disabled={list.loadingMore}>
          Load {more}
        </button>
      ) : null}
    </div>
  );
}
