import { formatDateTime } from "../lib/format";

/** A moment in the reader's time zone; the exact value stays in the markup (dateTime) and in the tooltip. */
export function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {formatDateTime(value)}
    </time>
  );
}
