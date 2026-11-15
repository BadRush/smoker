import type { SparkPoint } from "./api";

export type CellStatus = "healthy" | "degraded" | "loss" | "down" | "unknown";

export interface ProbeSeriesInput {
  probe_id: string;
  probe_name: string;
  location_label: string;
  baseline_ms?: number | null;
  warn_ms?: number | null;
  timestamps: number[];
  min_ms: Array<number | null>;
  p25_ms: Array<number | null>;
  p50_ms: Array<number | null>;
  p75_ms: Array<number | null>;
  p95_ms: Array<number | null>;
  max_ms: Array<number | null>;
  jitter_ms: Array<number | null>;
  loss_pct: number[];
}

export type TraceSeverity = "normal" | "warn" | "critical";

export const TRACE_COLORS = {
  normal: {
    stroke: "#10B981",
    outerCloud: "rgba(16, 185, 129, 0.12)",
    innerCloud: "rgba(16, 185, 129, 0.28)",
  },
  warn: {
    stroke: "#FBBF24",
    outerCloud: "rgba(245, 158, 11, 0.16)",
    innerCloud: "rgba(245, 158, 11, 0.32)",
  },
  critical: {
    stroke: "#F43F5E",
    outerCloud: "rgba(244, 63, 94, 0.18)",
    innerCloud: "rgba(244, 63, 94, 0.34)",
  },
} as const;

function severityRank(sev: TraceSeverity): number {
  switch (sev) {
    case "critical":
      return 2;
    case "warn":
      return 1;
    default:
      return 0;
  }
}

export function worseSeverity(a: TraceSeverity, b: TraceSeverity): TraceSeverity {
  return severityRank(b) > severityRank(a) ? b : a;
}

/**
 * Classifies a single time-series sample bucket into normal (green), warn (yellow),
 * or critical (red) matching backend RollingCache.BuildMatrixCells rules:
 * - critical: loss_pct >= 50%
 * - warn: 0 < loss_pct < 50%, OR p50 >= warnMs, OR p95 >= warnMs * 1.25
 * - normal: otherwise
 */
export function classifySampleSeverity(input: {
  p50: number | null | undefined;
  p95?: number | null | undefined;
  lossPct?: number | null | undefined;
  warnMs?: number | null | undefined;
}): TraceSeverity {
  const loss = input.lossPct ?? 0;
  if (loss >= 50) return "critical";
  if (loss > 0) return "warn";
  const warn = input.warnMs ?? null;
  if (warn !== null && warn > 0) {
    if (input.p50 !== null && input.p50 !== undefined && input.p50 >= warn) {
      return "warn";
    }
    if (
      input.p95 !== null &&
      input.p95 !== undefined &&
      input.p95 >= warn * 1.25
    ) {
      return "warn";
    }
  }
  return "normal";
}

export interface TargetThresholdConfigLike {
  latency_warn_ms?: number | null;
  probe_latency_overrides?: Record<string, number> | null;
  timeout_ms?: number | null;
}

/**
 * Resolves the effective latency warning threshold (in ms) for a (Target, Probe) pair,
 * preferring authoritative backend cell/series values and falling back to the exact
 * backend priority chain: probe override -> target latency_warn_ms -> adaptive P25 -> timeout * 0.5.
 */
export function resolveEffectiveWarnMs(input: {
  cellWarnMs?: number | null;
  seriesWarnMs?: number | null;
  target?: TargetThresholdConfigLike | null;
  probeId?: string | null;
  series?: Pick<ProbeSeriesInput, "p25_ms" | "p50_ms"> | null;
}): number | null {
  if (input.cellWarnMs !== null && input.cellWarnMs !== undefined && input.cellWarnMs > 0) {
    return input.cellWarnMs;
  }
  if (input.seriesWarnMs !== null && input.seriesWarnMs !== undefined && input.seriesWarnMs > 0) {
    return input.seriesWarnMs;
  }
  const tgt = input.target;
  if (tgt && input.probeId && tgt.probe_latency_overrides) {
    const ov = tgt.probe_latency_overrides[input.probeId];
    if (typeof ov === "number" && ov > 0) {
      return ov;
    }
  }
  if (tgt && typeof tgt.latency_warn_ms === "number" && tgt.latency_warn_ms > 0) {
    return tgt.latency_warn_ms;
  }
  if (input.series) {
    const samples: number[] = [];
    const src = input.series.p25_ms.length > 0 ? input.series.p25_ms : input.series.p50_ms;
    for (const v of src) {
      if (v !== null && v !== undefined && Number.isFinite(v) && v > 0) {
        samples.push(v);
      }
    }
    if (samples.length > 0) {
      samples.sort((a, b) => a - b);
      const idx = Math.min(samples.length - 1, Math.max(0, Math.floor(samples.length * 0.25)));
      const base = samples[idx];
      return Math.round(Math.max(base * 2, base + 15) * 100) / 100;
    }
  }
  if (tgt && typeof tgt.timeout_ms === "number" && tgt.timeout_ms > 0) {
    return Math.round(tgt.timeout_ms * 0.5 * 100) / 100;
  }
  return null;
}

/**
 * Computes the chart Y-axis upper bound (before 1.15x headroom padding), gently
 * including warnMs only when warnMs is reasonably close to observed data (<= 1.35x)
 * so fallback 500ms thresholds never flatten low-latency (~8ms) graphs.
 */
export function computeChartYUpper(
  dataTop: number,
  warnMs?: number | null
): number {
  const safeTop = Math.max(5, dataTop || 5);
  if (warnMs && warnMs > 0 && warnMs <= safeTop * 1.35) {
    return Math.max(safeTop, warnMs * 1.08);
  }
  return safeTop;
}

export function formatMs(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) {
    return "—";
  }
  if (val < 1) {
    return `${val.toFixed(2)} ms`;
  }
  if (val < 100) {
    return `${val.toFixed(1)} ms`;
  }
  return `${Math.round(val)} ms`;
}

export function formatLoss(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) {
    return "0.0%";
  }
  return `${pct.toFixed(1)}%`;
}

export function statusVisuals(status: CellStatus): {
  label: string;
  badgeClass: string;
  cellClass: string;
  dotClass: string;
} {
  switch (status) {
    case "healthy":
      return {
        label: "OK",
        badgeClass: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        cellClass: "bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/25",
        dotClass: "bg-emerald-400",
      };
    case "degraded":
      return {
        label: "HIGH RTT",
        badgeClass: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        cellClass: "bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/35",
        dotClass: "bg-amber-400",
      };
    case "loss":
      return {
        label: "LOSS",
        badgeClass: "bg-orange-500/20 text-orange-300 border-orange-500/40",
        cellClass: "bg-orange-500/15 hover:bg-orange-500/25 border-orange-500/35",
        dotClass: "bg-orange-400",
      };
    case "down":
      return {
        label: "DOWN",
        badgeClass: "bg-rose-500/20 text-rose-400 border-rose-500/40",
        cellClass: "bg-rose-500/20 hover:bg-rose-500/30 border-rose-500/45",
        dotClass: "bg-rose-500",
      };
    default:
      return {
        label: "NO DATA",
        badgeClass: "bg-zinc-800 text-zinc-400 border-zinc-700",
        cellClass: "bg-zinc-900/60 hover:bg-zinc-800/60 border-zinc-800",
        dotClass: "bg-zinc-500",
      };
  }
}

export function appendLiveTick(
  series: ProbeSeriesInput,
  tsSec: number,
  rttMs: number | null,
  jitterMs: number | null,
  isLoss: boolean,
  maxWindowSec = 300
): ProbeSeriesInput {
  const len = series.timestamps.length;
  if (len > 0 && series.timestamps[len - 1] === tsSec) {
    return series;
  }

  const nextTimestamps = [...series.timestamps, tsSec];
  const nextMin = [...series.min_ms, rttMs];
  const nextP25 = [...series.p25_ms, rttMs];
  const nextP50 = [...series.p50_ms, rttMs];
  const nextP75 = [...series.p75_ms, rttMs];
  const nextP95 = [...series.p95_ms, rttMs];
  const nextMax = [...series.max_ms, rttMs];
  const nextJitter = [...series.jitter_ms, jitterMs];
  const nextLoss = [...series.loss_pct, isLoss ? 100 : 0];

  const cutoff = tsSec - maxWindowSec;
  let trim = 0;
  while (trim < nextTimestamps.length && nextTimestamps[trim] < cutoff) {
    trim++;
  }

  return {
    ...series,
    timestamps: nextTimestamps.slice(trim),
    min_ms: nextMin.slice(trim),
    p25_ms: nextP25.slice(trim),
    p50_ms: nextP50.slice(trim),
    p75_ms: nextP75.slice(trim),
    p95_ms: nextP95.slice(trim),
    max_ms: nextMax.slice(trim),
    jitter_ms: nextJitter.slice(trim),
    loss_pct: nextLoss.slice(trim),
  };
}

/** Appends or coalesces a live sparkline sample while keeping a fixed sliding window. */
export function appendSparkPoint(
  points: SparkPoint[] | undefined,
  next: SparkPoint,
  maxPoints = 36
): SparkPoint[] {
  const list = points ? [...points] : [];
  const last = list[list.length - 1];
  if (last && next.ts < last.ts) {
    return list;
  }
  if (last && next.ts === last.ts) {
    list[list.length - 1] = next;
  } else {
    list.push(next);
  }
  return list.length > maxPoints ? list.slice(list.length - maxPoints) : list;
}

/** Converts matrix rolling sparkline buckets into a ProbeSeriesInput for compact uPlot cards. */
export function sparklineToProbeSeries(
  probeId: string,
  probeName: string,
  locationLabel: string,
  points: SparkPoint[] | undefined,
  jitterMs = 0,
  warnMs?: number | null,
  baselineMs?: number | null
): ProbeSeriesInput {
  const list = points ?? [];
  const timestamps: number[] = [];
  const minMs: Array<number | null> = [];
  const p25Ms: Array<number | null> = [];
  const p50Ms: Array<number | null> = [];
  const p75Ms: Array<number | null> = [];
  const p95Ms: Array<number | null> = [];
  const maxMs: Array<number | null> = [];
  const jitterArr: Array<number | null> = [];
  const lossPct: number[] = [];

  for (const pt of list) {
    timestamps.push(pt.ts);
    minMs.push(pt.min);
    p50Ms.push(pt.p50);
    p95Ms.push(pt.p95);
    maxMs.push(pt.p95);
    p25Ms.push(pt.min !== null && pt.p50 !== null ? (pt.min + pt.p50) / 2 : pt.p50);
    p75Ms.push(pt.p50 !== null && pt.p95 !== null ? (pt.p50 + pt.p95) / 2 : pt.p50);
    jitterArr.push(pt.p50 !== null ? jitterMs : null);
    lossPct.push(pt.loss ?? 0);
  }

  return {
    probe_id: probeId,
    probe_name: probeName,
    location_label: locationLabel,
    baseline_ms: baselineMs ?? null,
    warn_ms: warnMs ?? null,
    timestamps,
    min_ms: minMs,
    p25_ms: p25Ms,
    p50_ms: p50Ms,
    p75_ms: p75Ms,
    p95_ms: p95Ms,
    max_ms: maxMs,
    jitter_ms: jitterArr,
    loss_pct: lossPct,
  };
}
