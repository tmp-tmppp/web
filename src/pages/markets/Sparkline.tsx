import { useId } from "react";
import { SPARK_HEIGHT, SPARK_WIDTH, sparklinePath, trendText } from "./overview-trend";
import type { Trend } from "./overview-trend";

/** A small inline line of the YES price over the window. It has no axes; its text alternative says what it shows. */
export function Sparkline({ trend, phrase }: { trend: Trend; phrase: string }) {
  const titleId = useId();
  return (
    <svg className="sparkline" viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} role="img" aria-labelledby={titleId}>
      <title id={titleId}>{trendText(trend, phrase)}</title>
      <path className="sparkline-line" d={sparklinePath(trend.points)} />
    </svg>
  );
}
