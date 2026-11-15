import {
  formatAxisTicks24,
  formatDateSpan24,
  formatDateTime24,
} from "./date-format";
import { drawSmokeScene } from "./smoke-canvas";
import {
  computeChartYUpper,
  formatLoss,
  formatMs,
  type ProbeSeriesInput,
} from "./smoke-math";

export interface SeriesEvidenceStats {
  bestMs: number | null;
  normalMs: number | null;
  highMs: number | null;
  jitterMs: number | null;
  lossPct: number;
  startTs: number | null;
  endTs: number | null;
}

export function computeSeriesSummary(series: ProbeSeriesInput): SeriesEvidenceStats {
  let bestMs: number | null = null;
  let highMs: number | null = null;
  let p50Sum = 0;
  let p50Cnt = 0;
  let jitSum = 0;
  let jitCnt = 0;
  let lossSum = 0;
  let lossCnt = 0;

  const len = series.timestamps.length;
  for (let i = 0; i < len; i++) {
    const minVal = series.min_ms[i] ?? series.p50_ms[i] ?? null;
    if (minVal !== null && (bestMs === null || minVal < bestMs)) {
      bestMs = minVal;
    }

    const p50Val = series.p50_ms[i] ?? null;
    if (p50Val !== null) {
      p50Sum += p50Val;
      p50Cnt++;
    }

    const hiVal = series.p95_ms[i] ?? series.max_ms[i] ?? p50Val;
    if (hiVal !== null && (highMs === null || hiVal > highMs)) {
      highMs = hiVal;
    }

    const jVal = series.jitter_ms[i] ?? null;
    if (jVal !== null) {
      jitSum += jVal;
      jitCnt++;
    }

    const lVal = series.loss_pct[i];
    if (typeof lVal === "number" && Number.isFinite(lVal)) {
      lossSum += lVal;
      lossCnt++;
    }
  }

  return {
    bestMs,
    normalMs: p50Cnt > 0 ? p50Sum / p50Cnt : null,
    highMs,
    jitterMs: jitCnt > 0 ? jitSum / jitCnt : null,
    lossPct: lossCnt > 0 ? lossSum / lossCnt : 0,
    startTs: len > 0 ? series.timestamps[0] : null,
    endTs: len > 0 ? series.timestamps[len - 1] : null,
  };
}

function slugPart(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "node"
  );
}

export function buildEvidenceFilename(
  targetName: string,
  rangeLabel: string,
  now = new Date()
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `smoker-${slugPart(targetName)}-${slugPart(rangeLabel || "live")}-${stamp}.png`;
}

export function formatEvidenceSpan(
  startSec: number | null,
  endSec: number | null
): string {
  return formatDateSpan24(startSec, endSec);
}

function computeNiceYScale(rawMax: number): { yMax: number; ticks: number[] } {
  const safeMax = Math.max(5, rawMax);
  const rawStep = safeMax / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  const candidates = [1, 1.5, 2, 2.5, 5, 10];
  const niceMult = candidates.find((c) => c >= norm) ?? 10;
  const step = niceMult * pow;
  const yMax = step * 3;
  return {
    yMax,
    ticks: [0, step, step * 2, yMax],
  };
}

function computeNiceXTicks(startTs: number, endTs: number): number[] {
  const span = Math.max(1, endTs - startTs);
  const steps = [
    15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400,
  ];
  const incr = steps.find((s) => span / s <= 6) ?? Math.ceil(span / 5);
  const tzOffsetSec = new Date(startTs * 1000).getTimezoneOffset() * 60;
  const first =
    Math.ceil((startTs - tzOffsetSec) / incr) * incr + tzOffsetSec;
  const ticks: number[] = [];
  for (let t = first; t <= endTs; t += incr) {
    ticks.push(t);
  }
  if (ticks.length === 0) {
    ticks.push(startTs, endTs);
  }
  return ticks;
}

function drawVectorSmokePlot(
  ctx: CanvasRenderingContext2D,
  series: ProbeSeriesInput,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  warnMs?: number | null
) {
  const mLeft = 62;
  const mRight = 18;
  const mTop = 14;
  const mBottom = 38;
  const gLeft = boxX + mLeft;
  const gTop = boxY + mTop;
  const gW = boxW - mLeft - mRight;
  const gH = boxH - mTop - mBottom;
  const gRight = gLeft + gW;
  const gBottom = gTop + gH;

  const ts = series.timestamps;
  const startTs = ts[0] ?? 0;
  const endTs = Math.max(startTs + 1, ts[ts.length - 1] ?? startTs + 1);
  const effectiveWarn = warnMs ?? series.warn_ms ?? null;

  let dataMax = 5;
  for (let i = 0; i < ts.length; i++) {
    const candidate = series.p95_ms[i] ?? series.max_ms[i] ?? series.p50_ms[i] ?? 0;
    if (candidate > dataMax) dataMax = candidate;
  }
  const upperBound = computeChartYUpper(dataMax, effectiveWarn);
  const { yMax, ticks: yTicks } = computeNiceYScale(upperBound * 1.15);

  const toX = (t: number) => gLeft + ((t - startTs) / (endTs - startTs)) * gW;
  const toY = (v: number) =>
    gBottom - (Math.max(0, Math.min(yMax, v)) / yMax) * gH;

  // Horizontal Y grid & right-aligned axis labels (never clipped on the left)
  ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
  ctx.textBaseline = "middle";
  for (const val of yTicks) {
    const y = Math.round(toY(val)) + 0.5;
    ctx.strokeStyle = "rgba(39, 39, 42, 0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gLeft, y);
    ctx.lineTo(gRight, y);
    ctx.stroke();

    ctx.fillStyle = "#a1a1aa";
    ctx.textAlign = "right";
    const lbl = `${val.toFixed(val > 0 && val < 10 ? 1 : 0)}ms`;
    ctx.fillText(lbl, gLeft - 8, y);
  }

  // Vertical X grid & strict 24h + date ticks (never clipped at the bottom)
  const xTicks = computeNiceXTicks(startTs, endTs);
  const xLabels = formatAxisTicks24(xTicks);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < xTicks.length; i++) {
    const x = Math.round(toX(xTicks[i])) + 0.5;
    ctx.strokeStyle = "rgba(39, 39, 42, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, gTop);
    ctx.lineTo(x, gBottom);
    ctx.stroke();

    const raw = xLabels[i];
    if (!raw || x < gLeft + 16 || x > gRight - 16) continue;
    const lines = raw.split("\n");
    ctx.fillStyle = "#a1a1aa";
    ctx.fillText(lines[0], x, gBottom + 6);
    if (lines[1]) {
      ctx.fillStyle = "#71717a";
      ctx.fillText(lines[1], x, gBottom + 20);
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  drawSmokeScene({
    ctx,
    series,
    box: { left: gLeft, top: gTop, width: gW, height: gH },
    toX,
    toY,
    yMax,
    warnMs: effectiveWarn,
  });
}

export interface ExportChartOptions {
  chartContainer: HTMLElement;
  series: ProbeSeriesInput;
  targetName?: string;
  targetHost?: string;
  rangeLabel?: string;
  warnMs?: number | null;
}

export type ExportPngResult = "copied" | "downloaded";

export async function exportSmokeChartPng({
  chartContainer,
  series,
  targetName,
  targetHost,
  rangeLabel,
  warnMs,
}: ExportChartOptions): Promise<ExportPngResult> {
  const srcCanvas = chartContainer.querySelector("canvas");
  if (series.timestamps.length === 0 && !srcCanvas) {
    throw new Error("Chart canvas is not ready yet");
  }

  const dpr = 2;
  const padX = 20;
  const headerH = 66;
  const plotH = 264;
  const statsH = 50;
  const footerH = 28;
  const contentW = 840;
  const plotW = contentW - padX * 2;
  const totalH = headerH + plotH + statsH + footerH;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = contentW * dpr;
  outCanvas.height = totalH * dpr;
  const ctx = outCanvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.scale(dpr, dpr);

  // Outer card background & border
  ctx.fillStyle = "#0b0f17";
  ctx.fillRect(0, 0, contentW, totalH);
  ctx.strokeStyle = "#27272a";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, contentW - 1, totalH - 1);

  // Header: Target Title & Host (Probe info intentionally omitted for external evidence)
  const titleText = targetName || targetHost || "Monitored Target";
  ctx.fillStyle = "#f4f4f5";
  ctx.font = "700 15px Inter, system-ui, -apple-system, sans-serif";
  ctx.fillText(titleText, padX, 26);

  const effectiveWarn = warnMs ?? series.warn_ms ?? null;
  const warnSuffix =
    effectiveWarn !== null && effectiveWarn > 0
      ? ` · Warn ${formatMs(effectiveWarn)}`
      : "";
  const hostSubtitle = targetHost
    ? `Host: ${targetHost}${warnSuffix}`
    : `SmokePing Latency & Packet Loss${warnSuffix}`;
  ctx.fillStyle = "#a1a1aa";
  ctx.font = "12px 'JetBrains Mono', ui-monospace, monospace";
  ctx.fillText(hostSubtitle, padX, 46);

  // Top-right Range pill & 24h timestamp span with date
  const rangeText = (rangeLabel || "Live").toUpperCase();
  const stats = computeSeriesSummary(series);
  const spanText = formatEvidenceSpan(stats.startTs, stats.endTs);

  ctx.font = "700 11px 'JetBrains Mono', ui-monospace, monospace";
  const pillW = Math.max(44, ctx.measureText(rangeText).width + 18);
  const pillX = contentW - padX - pillW;
  ctx.fillStyle = "rgba(16, 185, 129, 0.16)";
  ctx.fillRect(pillX, 12, pillW, 20);
  ctx.strokeStyle = "rgba(16, 185, 129, 0.45)";
  ctx.strokeRect(pillX + 0.5, 12.5, pillW - 1, 19);
  ctx.fillStyle = "#34d399";
  ctx.fillText(rangeText, pillX + 9, 26);

  ctx.fillStyle = "#d4d4d8";
  ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
  const spanW = ctx.measureText(spanText).width;
  ctx.fillText(spanText, contentW - padX - spanW, 47);

  // Plot Canvas Frame
  ctx.fillStyle = "#090d14";
  ctx.fillRect(padX, headerH, plotW, plotH);
  if (series.timestamps.length > 0) {
    drawVectorSmokePlot(ctx, series, padX, headerH, plotW, plotH, effectiveWarn);
  } else if (srcCanvas) {
    ctx.drawImage(srcCanvas, padX, headerH, plotW, plotH);
  }
  ctx.strokeStyle = "#1f2937";
  ctx.strokeRect(padX + 0.5, headerH + 0.5, plotW - 1, plotH - 1);

  // Metrics Summary Bar
  const statsY = headerH + plotH;
  ctx.fillStyle = "#111827";
  ctx.fillRect(padX, statsY + 6, plotW, 38);
  ctx.strokeStyle = "#27272a";
  ctx.strokeRect(padX + 0.5, statsY + 6.5, plotW - 1, 37);

  const items = [
    { label: "BEST (Min)", value: formatMs(stats.bestMs), color: "#e4e4e7" },
    { label: "NORMAL (Typ)", value: formatMs(stats.normalMs), color: "#34d399" },
    { label: "HIGH (Peak 95%)", value: formatMs(stats.highMs), color: "#22d3ee" },
    { label: "JITTER", value: formatMs(stats.jitterMs), color: "#d4d4d8" },
    {
      label: "AVG LOSS",
      value: formatLoss(stats.lossPct),
      color: stats.lossPct > 0 ? "#fb7185" : "#34d399",
    },
  ];
  const colW = plotW / items.length;
  items.forEach((item, idx) => {
    const x = padX + idx * colW + 12;
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillText(item.label, x, statsY + 20);
    ctx.fillStyle = item.color;
    ctx.font = "700 12px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillText(item.value, x, statsY + 36);
  });

  // Watermark Footer (24h + Date Detail)
  const footerY = totalH - 9;
  ctx.fillStyle = "#71717a";
  ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
  ctx.fillText("Smoker NOC Telemetry Evidence", padX, footerY);
  const capturedLabel = `Captured ${formatDateTime24(new Date())}`;
  const capW = ctx.measureText(capturedLabel).width;
  ctx.fillText(capturedLabel, contentW - padX - capW, footerY);

  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("PNG encoding failed"));
    }, "image/png");
  });

  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "copied";
    } catch {
      // Fallback to direct file download on insecure HTTP origins or permission denial
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = buildEvidenceFilename(
      targetName || targetHost || "target",
      rangeLabel || "live"
    );
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return "downloaded";
}
