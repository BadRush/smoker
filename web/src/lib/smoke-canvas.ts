import {
  classifySampleSeverity,
  formatMs,
  TRACE_COLORS,
  worseSeverity,
  type ProbeSeriesInput,
  type TraceSeverity,
} from "./smoke-math";

export interface SmokeSceneBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DrawSmokeSceneOptions {
  ctx: CanvasRenderingContext2D;
  series: ProbeSeriesInput;
  box: SmokeSceneBox;
  toX: (ts: number) => number;
  toY: (val: number) => number;
  yMax?: number;
  warnMs?: number | null;
  showWarnLabel?: boolean;
  lineWidth?: number;
}

interface TraceSubSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sev: TraceSeverity;
}

interface TraceDot {
  x: number;
  y: number;
  sev: TraceSeverity;
}

function drawSegmentedSmokeBand(
  ctx: CanvasRenderingContext2D,
  timestamps: number[],
  lower: Array<number | null>,
  upper: Array<number | null>,
  severities: TraceSeverity[],
  toX: (ts: number) => number,
  toY: (val: number) => number,
  layer: "outerCloud" | "innerCloud"
) {
  const flushSubPoly = (start: number, end: number, sev: TraceSeverity) => {
    if (end - start < 1) return;
    ctx.beginPath();
    for (let i = start; i <= end; i++) {
      const x = toX(timestamps[i]);
      const yTop = toY(upper[i] as number);
      if (i === start) ctx.moveTo(x, yTop);
      else ctx.lineTo(x, yTop);
    }
    for (let i = end; i >= start; i--) {
      const x = toX(timestamps[i]);
      const yBot = toY(lower[i] as number);
      ctx.lineTo(x, yBot);
    }
    ctx.closePath();
    ctx.fillStyle = TRACE_COLORS[sev][layer];
    ctx.fill();
  };

  const flushContiguousValid = (start: number, end: number) => {
    if (end - start < 1) return;
    let subStart = start;
    let curSev = worseSeverity(severities[start], severities[start + 1]);
    for (let i = start + 1; i <= end; i++) {
      const quadSev = worseSeverity(severities[i - 1], severities[i]);
      if (quadSev !== curSev) {
        flushSubPoly(subStart, i - 1, curSev);
        subStart = i - 1;
        curSev = quadSev;
      }
    }
    flushSubPoly(subStart, end, curSev);
  };

  let segStart = -1;
  for (let i = 0; i < timestamps.length; i++) {
    const valid =
      lower[i] !== null &&
      lower[i] !== undefined &&
      upper[i] !== null &&
      upper[i] !== undefined;
    if (valid && segStart === -1) {
      segStart = i;
    } else if (!valid && segStart !== -1) {
      flushContiguousValid(segStart, i - 1);
      segStart = -1;
    }
  }
  if (segStart !== -1) {
    flushContiguousValid(segStart, timestamps.length - 1);
  }
}

/**
 * Shared 2D vector SmokePing renderer used by both live uPlot charts and PNG evidence export.
 * Renders severity-colored smoke clouds, vertical packet-loss ticks, a dashed WARN threshold
 * reference line, and a segmented median P50 trace that turns yellow (#FBBF24) when latency
 * touches/crosses warnMs or experiences intermittent loss, and red (#F43F5E) at >= 50% loss.
 */
export function drawSmokeScene({
  ctx,
  series,
  box,
  toX,
  toY,
  yMax,
  warnMs,
  showWarnLabel = true,
  lineWidth = 2,
}: DrawSmokeSceneOptions): void {
  const ts = series.timestamps;
  if (!ts || ts.length === 0) return;

  const { left, top, width, height } = box;
  const right = left + width;
  const bottom = top + height;

  const effectiveWarn =
    warnMs !== undefined && warnMs !== null && warnMs > 0
      ? warnMs
      : series.warn_ms !== undefined && series.warn_ms !== null && series.warn_ms > 0
      ? series.warn_ms
      : null;

  const upperOuter = series.p95_ms.map((v, i) => v ?? series.max_ms[i] ?? null);
  const severities: TraceSeverity[] = new Array(ts.length);
  for (let i = 0; i < ts.length; i++) {
    severities[i] = classifySampleSeverity({
      p50: series.p50_ms[i],
      p95: upperOuter[i],
      lossPct: series.loss_pct[i],
      warnMs: effectiveWarn,
    });
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();

  // 1. Outer & inner quantile smoke bands (segmented by normal/warn/critical)
  drawSegmentedSmokeBand(
    ctx,
    ts,
    series.min_ms,
    upperOuter,
    severities,
    toX,
    toY,
    "outerCloud"
  );
  drawSegmentedSmokeBand(
    ctx,
    ts,
    series.p25_ms,
    series.p75_ms,
    severities,
    toX,
    toY,
    "innerCloud"
  );

  // 2. Vertical packet loss indicators
  const barW = Math.max(2, Math.min(6, width / Math.max(ts.length, 30)));
  for (let i = 0; i < ts.length; i++) {
    const loss = series.loss_pct[i] ?? 0;
    if (loss <= 0) continue;
    const x = toX(ts[i]);
    if (x < left - barW || x > right + barW) continue;

    if (loss >= 100) {
      ctx.fillStyle = "rgba(244, 63, 94, 0.45)";
      ctx.fillRect(x - barW / 2, top, barW, height);
    } else {
      const tickH = Math.max(6, (loss / 100) * height * 0.65);
      ctx.fillStyle =
        loss >= 25 ? "rgba(244, 63, 94, 0.85)" : "rgba(245, 158, 11, 0.85)";
      ctx.fillRect(x - barW / 2, bottom - tickH, barW, tickH);
    }
  }

  // 3. Horizontal dashed WARN threshold line (when inside visible Y bounds)
  if (
    effectiveWarn !== null &&
    (yMax === undefined || effectiveWarn <= yMax)
  ) {
    const rawWarnY = toY(effectiveWarn);
    if (rawWarnY >= top + 2 && rawWarnY <= bottom - 2) {
      const warnY = Math.round(rawWarnY) + 0.5;
      ctx.save();
      ctx.strokeStyle = "rgba(251, 191, 36, 0.62)";
      ctx.lineWidth = 1;
      if (typeof ctx.setLineDash === "function") {
        ctx.setLineDash([4, 4]);
      }
      ctx.beginPath();
      ctx.moveTo(left, warnY);
      ctx.lineTo(right, warnY);
      ctx.stroke();
      if (typeof ctx.setLineDash === "function") {
        ctx.setLineDash([]);
      }

      if (showWarnLabel && height >= 64 && width >= 180) {
        ctx.font = "600 9px 'JetBrains Mono', ui-monospace, monospace";
        ctx.fillStyle = "rgba(251, 191, 36, 0.88)";
        ctx.textAlign = "right";
        ctx.textBaseline = "alphabetic";
        const labelY = warnY - 12 >= top ? warnY - 4 : warnY + 10;
        ctx.fillText(`WARN ${formatMs(effectiveWarn)}`, right - 4, labelY);
      }
      ctx.restore();
    }
  }

  // 4. Segmented median P50 trace with linear interpolation at y = warnMs crossings
  const subSegments: TraceSubSegment[] = [];
  const dots: TraceDot[] = [];

  for (let i = 0; i < ts.length; i++) {
    const vCur = series.p50_ms[i];
    if (vCur === null || vCur === undefined) continue;

    const vPrev = i > 0 ? series.p50_ms[i - 1] : null;
    const hasPrev = vPrev !== null && vPrev !== undefined;
    const vNext = i + 1 < ts.length ? series.p50_ms[i + 1] : null;
    const hasNext = vNext !== null && vNext !== undefined;

    if (!hasPrev && !hasNext) {
      dots.push({
        x: toX(ts[i]),
        y: toY(vCur),
        sev: severities[i],
      });
      continue;
    }

    if (!hasPrev) continue;

    const v1 = vPrev as number;
    const v2 = vCur;
    const x1 = toX(ts[i - 1]);
    const y1 = toY(v1);
    const x2 = toX(ts[i]);
    const y2 = toY(v2);
    const loss1 = series.loss_pct[i - 1] ?? 0;
    const loss2 = series.loss_pct[i] ?? 0;

    const crossesWarn =
      effectiveWarn !== null &&
      loss1 === 0 &&
      loss2 === 0 &&
      ((v1 < effectiveWarn && v2 >= effectiveWarn) ||
        (v1 >= effectiveWarn && v2 < effectiveWarn));

    if (crossesWarn && v2 !== v1) {
      const t = Math.max(
        0,
        Math.min(1, (effectiveWarn - v1) / (v2 - v1))
      );
      const xCross = x1 + t * (x2 - x1);
      const yCross = toY(effectiveWarn);
      if (v1 < effectiveWarn) {
        subSegments.push({ x1, y1, x2: xCross, y2: yCross, sev: severities[i - 1] });
        subSegments.push({ x1: xCross, y1: yCross, x2, y2, sev: "warn" });
      } else {
        subSegments.push({ x1, y1, x2: xCross, y2: yCross, sev: "warn" });
        subSegments.push({ x1: xCross, y1: yCross, x2, y2, sev: severities[i] });
      }
    } else {
      subSegments.push({
        x1,
        y1,
        x2,
        y2,
        sev: worseSeverity(severities[i - 1], severities[i]),
      });
    }
  }

  const order: TraceSeverity[] = ["normal", "warn", "critical"];
  for (const sev of order) {
    let hasPath = false;
    let lastX = Number.NaN;
    let lastY = Number.NaN;
    ctx.beginPath();
    ctx.strokeStyle = TRACE_COLORS[sev].stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const seg of subSegments) {
      if (seg.sev !== sev) continue;
      if (!hasPath || Math.abs(seg.x1 - lastX) > 0.01 || Math.abs(seg.y1 - lastY) > 0.01) {
        ctx.moveTo(seg.x1, seg.y1);
      }
      ctx.lineTo(seg.x2, seg.y2);
      lastX = seg.x2;
      lastY = seg.y2;
      hasPath = true;
    }

    if (hasPath) {
      ctx.stroke();
    }
  }

  for (const dot of dots) {
    ctx.beginPath();
    ctx.fillStyle = TRACE_COLORS[dot.sev].stroke;
    ctx.arc(dot.x, dot.y, Math.max(2, lineWidth), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
