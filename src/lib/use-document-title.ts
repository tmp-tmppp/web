import { useEffect } from "react";

/** Sets the browser tab title to "<page> - Chance" while the page is shown, so a screen reader announces the change. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} - Chance`;
  }, [title]);
}
