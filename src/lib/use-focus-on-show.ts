import { useEffect, useRef } from "react";

/**
 * A ref for the message that says what an action did. It takes the keyboard focus when `shown` turns true, so a person
 * who pressed a button that goes away with the action (the buy button, a confirmation) does not fall back to the top of
 * the page. Give the element tabIndex={-1} so that it can hold the focus.
 */
export function useFocusOnShow<T extends HTMLElement>(shown: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (shown) ref.current?.focus();
  }, [shown]);
  return ref;
}
