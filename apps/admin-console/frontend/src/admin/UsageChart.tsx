import { useMemo, useState } from "react";
import type { ResourceSample } from "@/api/admin";
import {
  formatQuantity,
  parseQuantity,
  quantityKind,
  resourceLabel,
} from "@/admin/resourceQuantity";

/**
 * One resource's history: what was committed under the ceiling, and — where a
 * metrics source exists — what was actually being consumed.
 *
 * One chart per resource, never one chart with two y-axes. CPU cores and
 * gibibytes share no scale, and a second axis is the standard way to make two
 * unrelated series look correlated. Small multiples cost vertical space and
 * mislead nobody.
 *
 * The ceiling is a reference line rather than a third series: it is the frame
 * the other two are read against, not a quantity that competes with them.
 */

type UsageChartProps = {
  resource: string;
  samples: ResourceSample[];
};

// Series colors are the design system's iris and ember. The pair is validated
// for colorblind separation against the card surface — a warm/cool split rather
// than two blues, which is what makes it survive deuteranopia.
const COMMITTED = "var(--iris)";
const ACTUAL = "var(--ember)";

const WIDTH = 720;
const HEIGHT = 168;
const PAD = { top: 14, right: 78, bottom: 22, left: 8 };

type Point = { x: number; y: number; value: number; sample: ResourceSample };

export function UsageChart({ resource, samples }: UsageChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const kind = useMemo(() => quantityKind(resource), [resource]);

  const model = useMemo(() => {
    const rows = samples
      .map((sample) => ({
        sample,
        at: Date.parse(sample.observedAt),
        used: parseQuantity(sample.used?.[resource]),
        hard: parseQuantity(sample.hard?.[resource]),
        actual: parseQuantity(sample.actual?.[resource]),
      }))
      .filter((row) => Number.isFinite(row.at) && Number.isFinite(row.used));

    if (rows.length === 0) {
      return null;
    }

    const first = rows[0].at;
    const last = rows[rows.length - 1].at;
    const span = Math.max(1, last - first);

    // The ceiling is included in the domain so a tenant well under its limit
    // still shows as well under it, rather than the series being rescaled to
    // fill the box and looking maxed out.
    const ceiling = rows.reduce(
      (max, row) => (Number.isFinite(row.hard) ? Math.max(max, row.hard) : max),
      0,
    );
    const peak = rows.reduce(
      (max, row) =>
        Math.max(max, row.used, Number.isFinite(row.actual) ? row.actual : 0),
      0,
    );
    const top = Math.max(ceiling, peak) || 1;

    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (at: number) => PAD.left + ((at - first) / span) * plotW;
    const y = (value: number) => PAD.top + plotH - (value / top) * plotH;

    const committed: Point[] = rows.map((row) => ({
      x: x(row.at),
      y: y(row.used),
      value: row.used,
      sample: row.sample,
    }));
    const actual: Point[] = rows
      .filter((row) => Number.isFinite(row.actual))
      .map((row) => ({
        x: x(row.at),
        y: y(row.actual),
        value: row.actual,
        sample: row.sample,
      }));

    return {
      rows,
      committed,
      actual,
      ceiling,
      ceilingY: ceiling > 0 ? y(ceiling) : null,
      baseline: PAD.top + plotH,
      first,
      last,
    };
  }, [resource, samples]);

  if (!model) {
    return null;
  }

  const { committed, actual, ceiling, ceilingY, baseline } = model;
  const hasActual = actual.length > 0;
  const hovered = hover === null ? null : committed[hover];
  const hoveredActual =
    hover === null ? null : actual.find((p) => p.sample === committed[hover]?.sample) ?? null;

  return (
    <figure className="usage-chart">
      <figcaption className="usage-chart__caption">
        <span className="usage-chart__title">{resourceLabel(resource)}</span>
        {hasActual ? (
          <span className="usage-chart__legend">
            <span className="usage-chart__key" style={{ background: COMMITTED }} />
            committed
            <span className="usage-chart__key" style={{ background: ACTUAL }} />
            in use
          </span>
        ) : (
          // One series needs no legend box — the axis label and the direct
          // label at the line's end already name it.
          <span className="usage-chart__legend usage-chart__legend--muted">committed</span>
        )}
      </figcaption>

      <div className="usage-chart__plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${resourceLabel(resource)} over time`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const svgX = ((event.clientX - box.left) / box.width) * WIDTH;
            let nearest = 0;
            for (let i = 1; i < committed.length; i += 1) {
              if (Math.abs(committed[i].x - svgX) < Math.abs(committed[nearest].x - svgX)) {
                nearest = i;
              }
            }
            setHover(nearest);
          }}
        >
          {ceilingY !== null && (
            <>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={ceilingY}
                y2={ceilingY}
                className="usage-chart__ceiling"
              />
              <text
                x={WIDTH - PAD.right + 8}
                y={ceilingY + 4}
                className="usage-chart__ceiling-label"
              >
                {formatQuantity(ceiling, kind)}
              </text>
            </>
          )}

          <path
            d={`${areaPath(committed, baseline)}`}
            fill={COMMITTED}
            fillOpacity={0.12}
            stroke="none"
          />
          <path d={linePath(committed)} className="usage-chart__line" stroke={COMMITTED} />
          {hasActual && (
            <path d={linePath(actual)} className="usage-chart__line" stroke={ACTUAL} />
          )}

          {/* Direct labels at the series ends, so identity never rests on
              color alone and the current value is readable without hovering. */}
          <text
            x={committed[committed.length - 1].x + 8}
            y={committed[committed.length - 1].y + 4}
            className="usage-chart__end-label"
          >
            {formatQuantity(committed[committed.length - 1].value, kind)}
          </text>

          {hovered && (
            <>
              <line
                x1={hovered.x}
                x2={hovered.x}
                y1={PAD.top}
                y2={baseline}
                className="usage-chart__crosshair"
              />
              <circle cx={hovered.x} cy={hovered.y} r={5} fill={COMMITTED} className="usage-chart__dot" />
              {hoveredActual && (
                <circle
                  cx={hoveredActual.x}
                  cy={hoveredActual.y}
                  r={5}
                  fill={ACTUAL}
                  className="usage-chart__dot"
                />
              )}
            </>
          )}
        </svg>

        {hovered && (
          <div
            className="usage-chart__tooltip"
            style={{ left: `${(hovered.x / WIDTH) * 100}%` }}
          >
            <div className="usage-chart__tooltip-time">
              {new Date(hovered.sample.observedAt).toLocaleString()}
            </div>
            <div className="usage-chart__tooltip-row">
              <span className="usage-chart__key" style={{ background: COMMITTED }} />
              committed {formatQuantity(hovered.value, kind)}
            </div>
            {hoveredActual && (
              <div className="usage-chart__tooltip-row">
                <span className="usage-chart__key" style={{ background: ACTUAL }} />
                in use {formatQuantity(hoveredActual.value, kind)}
              </div>
            )}
            {hovered.sample.plan && (
              <div className="usage-chart__tooltip-row usage-chart__tooltip-row--muted">
                plan {hovered.sample.plan}
              </div>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}

function linePath(points: Point[]): string {
  return points
    .map((point, i) => `${i === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function areaPath(points: Point[], baseline: number): string {
  if (points.length === 0) {
    return "";
  }
  const first = points[0];
  const last = points[points.length - 1];
  return `M${first.x.toFixed(1)} ${baseline} ${points
    .map((point) => `L${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ")} L${last.x.toFixed(1)} ${baseline} Z`;
}
