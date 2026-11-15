"use client";

import type { SparkPoint } from "@/lib/api";
import {
  classifySampleSeverity,
  TRACE_COLORS,
  worseSeverity,
  type CellStatus,
  type TraceSeverity,
} from "@/lib/smoke-math";

interface MiniSparklineProps {
  points: SparkPoint[];
  status: CellStatus | string;
  warnMs?: number | null;
}

const WIDTH = 120;
const HEIGHT = 26;
const PAD_Y = 2;

function fallbackStatusSeverity(status: string): TraceSeverity {
  switch (status) {
    case "down":
      return "critical";
    case "degraded":
    case "loss":
      return "warn";
    default:
      return "normal";
  }
}

export function MiniSparkline({ points, status, warnMs }: MiniSparklineProps) {
  if (!points || points.length === 0) {
    return (
      <svg
        data-testid="mini-sparkline"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-6 w-full"
        aria-hidden="true"
      >
        <line
          x1={0}
          y1={HEIGHT / 2}
          x2={WIDTH}
          y2={HEIGHT / 2}
          stroke="#27272a"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const effectiveWarn =
    warnMs !== undefined && warnMs !== null && warnMs > 0 ? warnMs : null;

  let minVal = Number.POSITIVE_INFINITY;
  let maxVal = Number.NEGATIVE_INFINITY;
  for (const pt of points) {
    for (const v of [pt.min, pt.p50, pt.p95]) {
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
    }
  }

  const hasLatency = Number.isFinite(minVal) && Number.isFinite(maxVal);
  const lo = hasLatency ? Math.max(0, minVal * 0.9) : 0;
  const rawHi = hasLatency ? Math.max(lo + 0.5, maxVal * 1.1) : 10;
  const hi =
    effectiveWarn !== null && effectiveWarn <= rawHi * 1.35
      ? Math.max(rawHi, effectiveWarn * 1.08)
      : rawHi;
  const spanY = Math.max(0.5, hi - lo);

  const xAt = (idx: number) =>
    points.length <= 1 ? WIDTH / 2 : (idx / (points.length - 1)) * (WIDTH - 2) + 1;
  const yAt = (val: number) => {
    const norm = Math.max(0, Math.min(1, (val - lo) / spanY));
    return HEIGHT - PAD_Y - norm * (HEIGHT - PAD_Y * 2);
  };

  const severities: TraceSeverity[] = points.map((pt) => {
    const sev = classifySampleSeverity({
      p50: pt.p50,
      p95: pt.p95,
      lossPct: pt.loss,
      warnMs: effectiveWarn,
    });
    if (sev === "normal" && effectiveWarn === null && (pt.loss ?? 0) === 0) {
      return fallbackStatusSeverity(status);
    }
    return sev;
  });

  const bandPolys: Array<{ pts: string; fill: string }> = [];
  const lineSegments: Array<{ d: string; stroke: string; sev: TraceSeverity }> = [];
  const singleDots: Array<{ x: number; y: number; fill: string }> = [];

  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    if (cur.p50 === null || cur.p50 === undefined) continue;

    const prev = i > 0 ? points[i - 1] : null;
    const hasPrev = prev !== null && prev.p50 !== null && prev.p50 !== undefined;
    const next = i + 1 < points.length ? points[i + 1] : null;
    const hasNext = next !== null && next.p50 !== null && next.p50 !== undefined;

    if (!hasPrev && !hasNext) {
      singleDots.push({
        x: xAt(i),
        y: yAt(cur.p50),
        fill: TRACE_COLORS[severities[i]].stroke,
      });
      continue;
    }

    if (!hasPrev || !prev) continue;

    const x1 = xAt(i - 1);
    const x2 = xAt(i);
    const v1 = prev.p50 as number;
    const v2 = cur.p50 as number;
    const y1 = yAt(v1);
    const y2 = yAt(v2);

    const top1 = yAt(prev.p95 ?? v1);
    const bot1 = yAt(prev.min ?? v1);
    const top2 = yAt(cur.p95 ?? v2);
    const bot2 = yAt(cur.min ?? v2);
    const quadSev = worseSeverity(severities[i - 1], severities[i]);

    bandPolys.push({
      pts: `${x1.toFixed(1)},${top1.toFixed(1)} ${x2.toFixed(1)},${top2.toFixed(1)} ${x2.toFixed(1)},${bot2.toFixed(1)} ${x1.toFixed(1)},${bot1.toFixed(1)}`,
      fill: TRACE_COLORS[quadSev].innerCloud,
    });

    const loss1 = prev.loss ?? 0;
    const loss2 = cur.loss ?? 0;
    const crossesWarn =
      effectiveWarn !== null &&
      loss1 === 0 &&
      loss2 === 0 &&
      ((v1 < effectiveWarn && v2 >= effectiveWarn) ||
        (v1 >= effectiveWarn && v2 < effectiveWarn));

    if (crossesWarn && v2 !== v1) {
      const t = Math.max(0, Math.min(1, (effectiveWarn - v1) / (v2 - v1)));
      const xCross = x1 + t * (x2 - x1);
      const yCross = yAt(effectiveWarn);
      const firstSev: TraceSeverity = v1 < effectiveWarn ? severities[i - 1] : "warn";
      const secondSev: TraceSeverity = v1 < effectiveWarn ? "warn" : severities[i];
      lineSegments.push({
        d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${xCross.toFixed(1)} ${yCross.toFixed(1)}`,
        stroke: TRACE_COLORS[firstSev].stroke,
        sev: firstSev,
      });
      lineSegments.push({
        d: `M${xCross.toFixed(1)} ${yCross.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`,
        stroke: TRACE_COLORS[secondSev].stroke,
        sev: secondSev,
      });
    } else {
      lineSegments.push({
        d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`,
        stroke: TRACE_COLORS[quadSev].stroke,
        sev: quadSev,
      });
    }
  }

  const barW = Math.max(2, Math.min(5, WIDTH / Math.max(points.length, 16)));
  const showWarnLine =
    effectiveWarn !== null && effectiveWarn >= lo && effectiveWarn <= hi;

  return (
    <svg
      data-testid="mini-sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-6 w-full"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      {bandPolys.map((b, i) => (
        <polygon key={`b-${i}`} points={b.pts} fill={b.fill} />
      ))}

      {points.map((pt, i) => {
        if (!pt.loss || pt.loss <= 0) return null;
        const x = xAt(i) - barW / 2;
        const h = pt.loss >= 100 ? HEIGHT : Math.max(3, (pt.loss / 100) * HEIGHT * 0.75);
        return (
          <rect
            key={`l-${pt.ts}-${i}`}
            x={x}
            y={HEIGHT - h}
            width={barW}
            height={h}
            rx={0.5}
            fill={pt.loss >= 25 ? "rgba(244, 63, 94, 0.7)" : "rgba(245, 158, 11, 0.8)"}
          />
        );
      })}

      {showWarnLine && effectiveWarn !== null && (
        <line
          data-testid="sparkline-warn-line"
          x1={0}
          y1={yAt(effectiveWarn).toFixed(1)}
          x2={WIDTH}
          y2={yAt(effectiveWarn).toFixed(1)}
          stroke="rgba(251, 191, 36, 0.55)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      )}

      {lineSegments.map((seg, i) => (
        <path
          key={`p-${i}`}
          data-severity={seg.sev}
          d={seg.d}
          fill="none"
          stroke={seg.stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      {singleDots.map((dot, i) => (
        <circle key={`d-${i}`} cx={dot.x} cy={dot.y} r={1.8} fill={dot.fill} />
      ))}
    </svg>
  );
}
