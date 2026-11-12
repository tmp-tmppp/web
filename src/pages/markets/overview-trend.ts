import type { WindowHistory } from "../../api/market-data-graphql";
import { MICRO, formatPrice } from "../../lib/units";
import { stairPath } from "./PriceChart";
import type { ChartPoint } from "./PriceChart";

/**
 * What the overview shows of one market's recent history: the price at the start of the window, the change to the current
 * price, the extremes, and the points of the sparkline. Every price is an integer in microcredits and the change is the
 * difference of two integers; only the pixel positions of the drawing are computed with floating point.
 */
export interface Trend {
  /** The YES price at the start of the window: the latest price before it, else the opening price of the first bucket. */
  baselineMicro: number;
  currentMicro: number;
  /** `currentMicro - baselineMicro`, exact. */
  changeMicro: number;
  lowMicro: number;
  highMicro: number;
  points: ChartPoint[];
}

/**
 * The trend of a market over its window, or null when the history says nothing about the start (no point before the window
 * and no bucket in it). The line carries the price in from before the window, goes to the closing price of every bucket
 * (the price holds until the next trade, as in the chart of the market page) and ends at the current price.
 */
export function trendOf(history: WindowHistory, currentMicro: number): Trend | null {
  const first = history.buckets[0];
  const baselineMicro = history.previousCloseYesMicro ?? first?.openYesMicro ?? null;
  if (baselineMicro === null) return null;
  const points: ChartPoint[] = [];
  if (history.previousCloseYesMicro !== null) points.push({ t: Date.parse(history.from), v: baselineMicro, real: false });
  else if (first && first.openYesMicro !== first.closeYesMicro) points.push({ t: Date.parse(first.start), v: first.openYesMicro, real: true });
  for (const bucket of history.buckets) points.push({ t: Date.parse(bucket.start), v: bucket.closeYesMicro, real: true });
  const end = Date.parse(history.to);
  const last = points[points.length - 1];
  if (last && end > last.t) points.push({ t: end, v: currentMicro, real: false });
  const drawn = points.filter((point) => Number.isFinite(point.t));
  return {
    baselineMicro,
    currentMicro,
    changeMicro: currentMicro - baselineMicro,
    lowMicro: Math.min(baselineMicro, currentMicro, ...history.buckets.map((bucket) => bucket.lowYesMicro)),
    highMicro: Math.max(baselineMicro, currentMicro, ...history.buckets.map((bucket) => bucket.highYesMicro)),
    points: drawn,
  };
}

/** The text alternative of the sparkline: where the price started, where it is, and its range, in words. */
export function trendText(trend: Trend, phrase: string): string {
  if (trend.lowMicro === trend.highMicro) return `YES price over ${phrase}: unchanged at ${formatPrice(trend.currentMicro)}.`;
  return `YES price over ${phrase}: from ${formatPrice(trend.baselineMicro)} to ${formatPrice(trend.currentMicro)}, lowest ${formatPrice(trend.lowMicro)}, highest ${formatPrice(trend.highMicro)}.`;
}

export const SPARK_WIDTH = 120;
export const SPARK_HEIGHT = 32;
const PAD = 2;
/** A line that moved less than this is drawn on a scale this tall, so a change of one cent does not look like a crash. */
const MIN_SPAN = 100_000;

/** The path of the sparkline: a staircase through the points, scaled to the range of their prices (at least MIN_SPAN tall). */
export function sparklinePath(points: readonly ChartPoint[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "";
  const values = points.map((point) => point.v);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < MIN_SPAN) {
    low = Math.max(0, Math.min(Math.floor((high + low) / 2) - MIN_SPAN / 2, MICRO - MIN_SPAN));
    high = low + MIN_SPAN;
  }
  const spanMs = Math.max(1, last.t - first.t);
  const x = (t: number) => PAD + ((t - first.t) / spanMs) * (SPARK_WIDTH - 2 * PAD);
  const y = (v: number) => PAD + ((high - v) / (high - low)) * (SPARK_HEIGHT - 2 * PAD);
  return stairPath(points, x, y);
}
