import { useId } from "react";
import type { Bucket, History } from "../../api/market-data";
import { formatDateTime } from "../../lib/format";
import { formatMicroCredits, formatPrice } from "../../lib/units";

/** A hand-made line chart of the YES price (no chart library): the price holds until the next trade, so the line is a staircase. */

const WIDTH = 640;
const HEIGHT = 280;
const MARGIN = { top: 12, right: 14, bottom: 30, left: 46 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;
const PRICE_TICKS = [0, 250_000, 500_000, 750_000, 1_000_000];
const X_TICKS = 4;
const TABLE_ROWS = 50;
const HOUR_MS = 3_600_000;

export interface ChartPoint {
  /** Milliseconds since the epoch. */
  t: number;
  /** YES price in microcredits. */
  v: number;
  /** A point of a bucket (drawn as a dot) or the carried-on price at the start or the end of the range. */
  real: boolean;
}

/**
 * The points of the line: the price carried in from before the first bucket, then the closing YES price of every
 * bucket at its start (the first bucket's opening price when nothing came before it), and the last price carried on to
 * the end of the range.
 */
export function chartPoints(history: History): ChartPoint[] {
  const points: ChartPoint[] = [];
  const first = history.buckets[0];
  if (history.previousCloseYesMicro !== null) points.push({ t: Date.parse(history.from), v: history.previousCloseYesMicro, real: false });
  else if (first && first.openYesMicro !== first.closeYesMicro) points.push({ t: Date.parse(first.start), v: first.openYesMicro, real: true });
  for (const bucket of history.buckets) points.push({ t: Date.parse(bucket.start), v: bucket.closeYesMicro, real: true });
  const last = points[points.length - 1];
  const end = Date.parse(history.to);
  if (last && end > last.t) points.push({ t: end, v: last.v, real: false });
  return points.filter((point) => Number.isFinite(point.t));
}

/** The SVG path of a staircase through the points: right to the next time, then up or down to its price. */
export function stairPath(points: readonly ChartPoint[], x: (t: number) => number, y: (v: number) => number): string {
  return points
    .map((point, index) => {
      if (index === 0) return `M${x(point.t).toFixed(1)} ${y(point.v).toFixed(1)}`;
      return `H${x(point.t).toFixed(1)} V${y(point.v).toFixed(1)}`;
    })
    .join(" ");
}

function tickLabel(t: number, spanMs: number): string {
  const options: Intl.DateTimeFormatOptions = spanMs < 2 * 24 * HOUR_MS ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" };
  return new Intl.DateTimeFormat(undefined, options).format(new Date(t));
}

function summary(history: History, points: readonly ChartPoint[]): string {
  const real = points.filter((point) => point.real);
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "No price points yet.";
  const lows = [...history.buckets.map((bucket) => bucket.lowYesMicro), ...(history.previousCloseYesMicro === null ? [] : [history.previousCloseYesMicro])];
  const highs = [...history.buckets.map((bucket) => bucket.highYesMicro), ...(history.previousCloseYesMicro === null ? [] : [history.previousCloseYesMicro])];
  const low = lows.length > 0 ? Math.min(...lows) : first.v;
  const high = highs.length > 0 ? Math.max(...highs) : first.v;
  return `YES price from ${formatPrice(first.v)} to ${formatPrice(last.v)}, lowest ${formatPrice(low)}, highest ${formatPrice(high)}, ${real.length} ${real.length === 1 ? "point" : "points"}, from ${formatDateTime(new Date(first.t).toISOString())} to ${formatDateTime(new Date(last.t).toISOString())}.`;
}

function BucketRows({ buckets }: { buckets: readonly Bucket[] }) {
  return buckets.map((bucket) => (
    <tr key={bucket.start}>
      <th scope="row">{formatDateTime(bucket.start)}</th>
      <td>{formatPrice(bucket.openYesMicro)}</td>
      <td>{formatPrice(bucket.highYesMicro)}</td>
      <td>{formatPrice(bucket.lowYesMicro)}</td>
      <td>{formatPrice(bucket.closeYesMicro)}</td>
      <td>{formatMicroCredits(bucket.volumeMicro)}</td>
      <td>{bucket.trades}</td>
    </tr>
  ));
}

/** The price history of a market as a line chart, with the numbers in a table for people who cannot see or use the picture. */
export function PriceChart({ history }: { history: History }) {
  const titleId = useId();
  const descId = useId();
  const points = chartPoints(history);
  if (points.length === 0) return <p>There are no price points yet.</p>;

  const start = points[0]?.t ?? 0;
  const lastT = points[points.length - 1]?.t ?? start;
  const end = lastT > start ? lastT : start + HOUR_MS;
  const x = (t: number) => MARGIN.left + ((t - start) / (end - start)) * PLOT_W;
  const y = (v: number) => MARGIN.top + (1 - v / 1_000_000) * PLOT_H;
  const ticks = Array.from({ length: X_TICKS + 1 }, (_, index) => start + ((end - start) * index) / X_TICKS);
  const shown = history.buckets.slice(-TABLE_ROWS);

  return (
    <figure className="price-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby={titleId} aria-describedby={descId}>
        <title id={titleId}>YES price over time</title>
        <desc id={descId}>{summary(history, points)}</desc>
        {PRICE_TICKS.map((tick) => (
          <g key={tick}>
            <line className="chart-grid" x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} />
            <text className="chart-label" x={MARGIN.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatPrice(tick)}
            </text>
          </g>
        ))}
        {ticks.map((tick, index) => (
          <text key={index} className="chart-label" x={x(tick)} y={HEIGHT - 8} textAnchor={index === 0 ? "start" : index === X_TICKS ? "end" : "middle"}>
            {tickLabel(tick, end - start)}
          </text>
        ))}
        <path className="chart-line" d={stairPath(points, x, y)} />
        {points.map((point, index) => (point.real ? <circle key={index} className="chart-dot" cx={x(point.t)} cy={y(point.v)} r={2.5} /> : null))}
      </svg>
      <figcaption>
        <details>
          <summary>Show the numbers</summary>
          <div className="table-wrap">
            <table>
              <caption>
                Price history in buckets of {history.interval}
                {history.buckets.length > shown.length ? `, the newest ${shown.length} of ${history.buckets.length}` : ""}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Start</th>
                  <th scope="col">Open</th>
                  <th scope="col">High</th>
                  <th scope="col">Low</th>
                  <th scope="col">Close</th>
                  <th scope="col">Traded</th>
                  <th scope="col">Trades</th>
                </tr>
              </thead>
              <tbody>
                <BucketRows buckets={shown} />
              </tbody>
            </table>
          </div>
        </details>
      </figcaption>
    </figure>
  );
}
