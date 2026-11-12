import { useCallback, useEffect, useState } from "react";
import type { Page } from "../api/types";

export interface PagedList<T> {
  items: T[];
  /** "loading": the first page is on its way; "ready": shown; "error": the first page failed. */
  phase: "loading" | "ready" | "error";
  /** Why the first page failed, or why "load more" failed (the items already shown stay). */
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Replaces an item shown (after a change the server confirmed) without reading the list again. */
  replaceItem: (matches: (item: T) => boolean, next: T) => void;
}

interface Snapshot<T> {
  items: T[];
  nextCursor: string | null;
  phase: "loading" | "ready" | "error";
  error: unknown;
  loadingMore: boolean;
}

const LOADING: Snapshot<never> = { items: [], nextCursor: null, phase: "loading", error: null, loadingMore: false };

/**
 * A list read page by page with the cursor of the API. fetchPage must be stable (useCallback); to start another list
 * (new filters) the parent gives the component a new key, so the state starts clean and no effect has to reset it.
 */
export function usePagedList<T>(fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>): PagedList<T> {
  const [state, setState] = useState<Snapshot<T>>(LOADING);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchPage(null, controller.signal).then(
      (page) => setState({ items: page.items, nextCursor: page.nextCursor, phase: "ready", error: null, loadingMore: false }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ ...LOADING, phase: "error", error });
      },
    );
    return () => controller.abort();
  }, [fetchPage, round]);

  const reload = useCallback(() => {
    setState(LOADING);
    setRound((value) => value + 1);
  }, []);

  const cursor = state.nextCursor;
  const loadingMore = state.loadingMore;
  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setState((previous) => ({ ...previous, loadingMore: true, error: null }));
    fetchPage(cursor, new AbortController().signal).then(
      (page) =>
        setState((previous) => ({
          items: [...previous.items, ...page.items],
          nextCursor: page.nextCursor,
          phase: "ready",
          error: null,
          loadingMore: false,
        })),
      (error: unknown) => setState((previous) => ({ ...previous, error, loadingMore: false })),
    );
  }, [cursor, loadingMore, fetchPage]);

  const replaceItem = useCallback((matches: (item: T) => boolean, next: T) => {
    setState((previous) => ({ ...previous, items: previous.items.map((item) => (matches(item) ? next : item)) }));
  }, []);

  return {
    items: state.items,
    phase: state.phase,
    error: state.error,
    hasMore: state.nextCursor !== null,
    loadingMore: state.loadingMore,
    loadMore,
    reload,
    replaceItem,
  };
}
