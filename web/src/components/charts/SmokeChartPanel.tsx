"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, Download } from "lucide-react";
import type uPlot from "uplot";
import { formatAxisTicks24, formatDateTime24 } from "@/lib/date-format";
import { exportSmokeChartPng } from "@/lib/export-chart-png";
import {
  classifySampleSeverity,
  computeChartYUpper,
  formatLoss,
  formatMs,
  type ProbeSeriesInput,
} from "@/lib/smoke-math";
import { createSmokePlugin } from "./uplotSmokePlugin";

type UPlotCtor = typeof import("uplot");

let uplotLoader: Promise<UPlotCtor> | null = null;

async function getUPlot(): Promise<UPlotCtor> {
  if (!uplotLoader) {
    if (typeof navigator !== "undefined") {
      try {
        new Intl.NumberFormat(navigator.language);
      } catch {
        try {
          Object.defineProperty(navigator, "language", {
            value: "en-US",
            configurable: true,
          });
        } catch {
          // ignore read-only navigator environments
        }
      }
    }
    uplotLoader = import("uplot").then((mod) => {
      const m = mod as unknown as { default?: UPlotCtor };
      return m.default ?? (mod as unknown as UPlotCtor);
    });
  }
  return uplotLoader;
}

interface SmokeChartPanelProps {
  series: ProbeSeriesInput;
  syncKey: string;
  compact?: boolean;
  fillHeight?: boolean;
  fixedHeight?: number;
  targetName?: string;
  targetHost?: string;
  rangeLabel?: string;
  baselineMs?: number | null;
  warnMs?: number | null;
  showThresholdMeta?: boolean;
  enableExport?: boolean;
}

interface HoverReadout {
  ts: number | null;
  min: number | null;
  p50: number | null;
  p95: number | null;
  jitter: number | null;
  loss: number;
}

export function SmokeChartPanel({
  series,
  syncKey,
  compact = false,
  fillHeight = false,
  fixedHeight,
  targetName,
  targetHost,
  rangeLabel,
  baselineMs,
  warnMs,
  showThresholdMeta,
  enableExport = true,
}: SmokeChartPanelProps) {
  const effectiveFillHeight = fillHeight || (fixedHeight !== undefined && fixedHeight > 0);
  const defaultHeight = compact ? (effectiveFillHeight ? 96 : 132) : 210;
  const shouldShowMeta = showThresholdMeta ?? !compact;
  const effectiveWarnMs = warnMs ?? series.warn_ms ?? null;
  const effectiveBaselineMs = baselineMs ?? series.baseline_ms ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const seriesRef = useRef<ProbeSeriesInput>(series);
  seriesRef.current = series;
  const warnMsRef = useRef<number | null>(effectiveWarnMs);
  warnMsRef.current = effectiveWarnMs;

  const latestIdx = useMemo(() => {
    for (let i = series.timestamps.length - 1; i >= 0; i--) {
      if (series.p50_ms[i] !== null || series.loss_pct[i] > 0) return i;
    }
    return series.timestamps.length - 1;
  }, [series]);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [exportState, setExportState] = useState<"idle" | "copied" | "downloaded" | "error">("idle");

  const displayReadout: HoverReadout = useMemo(() => {
    const idx = hoverIdx !== null && hoverIdx < series.timestamps.length ? hoverIdx : latestIdx;
    if (idx < 0 || idx >= series.timestamps.length) {
      return { ts: null, min: null, p50: null, p95: null, jitter: null, loss: 0 };
    }
    return {
      ts: series.timestamps[idx] ?? null,
      min: series.min_ms[idx] ?? null,
      p50: series.p50_ms[idx] ?? null,
      p95: series.p95_ms[idx] ?? null,
      jitter: series.jitter_ms[idx] ?? null,
      loss: series.loss_pct[idx] ?? 0,
    };
  }, [hoverIdx, latestIdx, series]);

  const hasData = series.timestamps.length > 0;

  async function handleExportPng() {
    if (!containerRef.current) return;
    try {
      const outcome = await exportSmokeChartPng({
        chartContainer: containerRef.current,
        series,
        targetName,
        targetHost,
        rangeLabel,
        warnMs: effectiveWarnMs,
      });
      setExportState(outcome);
      setTimeout(() => setExportState("idle"), 2000);
    } catch {
      setExportState("error");
      setTimeout(() => setExportState("idle"), 2000);
    }
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasData) {
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
      sizeRef.current = { w: 0, h: 0 };
      return;
    }

    let cancelled = false;
    let ro: ResizeObserver | null = null;
    let plot: uPlot | null = null;

    void getUPlot().then((UPlot) => {
      if (cancelled || !containerRef.current) return;
      const targetEl = containerRef.current;
      const sync = UPlot.sync(syncKey);

      const measureHeight = (rectH?: number) => {
        if (!effectiveFillHeight) return defaultHeight;
        const raw = rectH ?? targetEl.clientHeight;
        return Math.max(72, Math.floor(raw > 20 ? raw : defaultHeight));
      };

      const initW = Math.max(targetEl.clientWidth, compact ? 220 : 300);
      const initH = measureHeight();
      sizeRef.current = { w: initW, h: initH };

      const opts: uPlot.Options = {
        width: initW,
        height: initH,
        padding: [10, 12, 0, 6],
        legend: { show: false },
        cursor: {
          sync: {
            key: sync.key,
            setSeries: true,
          },
          drag: { x: true, y: false },
        },
        scales: {
          x: { time: true },
          y: {
            auto: true,
            range: (_u, _min, dataMax) => {
              const s = seriesRef.current;
              let top = dataMax || 10;
              for (let i = 0; i < s.p95_ms.length; i++) {
                const candidate = s.p95_ms[i] ?? s.max_ms[i] ?? s.p50_ms[i] ?? 0;
                if (candidate > top) top = candidate;
              }
              const upper = computeChartYUpper(top, warnMsRef.current);
              return [0, Math.max(5, upper * 1.15)];
            },
          },
        },
        axes: [
          {
            stroke: "#71717a",
            size: compact ? 34 : 38,
            gap: 4,
            space: compact ? 52 : 64,
            grid: { stroke: "rgba(39, 39, 42, 0.7)", width: 1 },
            ticks: { stroke: "#27272a", width: 1, size: 4 },
            font: compact
              ? "10px JetBrains Mono, monospace"
              : "11px JetBrains Mono, monospace",
            values: (_u, splits) => formatAxisTicks24(splits),
          },
          {
            stroke: "#71717a",
            size: compact ? 56 : 64,
            gap: 4,
            grid: { stroke: "rgba(39, 39, 42, 0.7)", width: 1 },
            ticks: { stroke: "#27272a", width: 1, size: 4 },
            font: compact
              ? "10px JetBrains Mono, monospace"
              : "11px JetBrains Mono, monospace",
            values: (_u, vals) => vals.map((v) => `${v.toFixed(v < 10 ? 1 : 0)}ms`),
          },
        ],
        series: [
          {},
          {
            label: "Normal RTT",
            stroke: "#10B981",
            width: 2,
            spanGaps: false,
            paths: () => null,
            points: { show: false },
          },
        ],
        hooks: {
          setCursor: [
            (u) => {
              const idx = u.cursor.idx;
              setHoverIdx(idx === null || idx === undefined ? null : idx);
            },
          ],
        },
        plugins: [createSmokePlugin(seriesRef, warnMsRef)],
      };

      plot = new UPlot(
        opts,
        [seriesRef.current.timestamps, seriesRef.current.p50_ms] as unknown as uPlot.AlignedData,
        targetEl
      );
      plotRef.current = plot;

      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const w = Math.floor(entry.contentRect.width);
            const h = measureHeight(entry.contentRect.height);
            if (
              w > 100 &&
              plotRef.current &&
              (w !== sizeRef.current.w || h !== sizeRef.current.h)
            ) {
              sizeRef.current = { w, h };
              plotRef.current.setSize({ width: w, height: h });
            }
          }
        });
        ro.observe(targetEl);
      }
    });

    return () => {
      cancelled = true;
      ro?.disconnect();
      if (plot) {
        plot.destroy();
      }
      plotRef.current = null;
    };
  }, [hasData, syncKey, defaultHeight, compact, effectiveFillHeight]);

  useEffect(() => {
    if (plotRef.current && series.timestamps.length > 0) {
      plotRef.current.setData([
        series.timestamps,
        series.p50_ms,
      ] as unknown as uPlot.AlignedData);
      plotRef.current.redraw?.();
    }
  }, [series, effectiveWarnMs]);

  const readoutSeverity = classifySampleSeverity({
    p50: displayReadout.p50,
    p95: displayReadout.p95,
    lossPct: displayReadout.loss,
    warnMs: effectiveWarnMs,
  });

  return (
    <section
      aria-label={`Latency smoke chart from ${series.probe_name}`}
      data-testid="smoke-chart-panel"
      style={fixedHeight && fixedHeight > 0 ? { height: fixedHeight } : undefined}
      className={
        fixedHeight && fixedHeight > 0
          ? "group flex shrink-0 min-h-0 flex-col rounded-md border border-border/80 bg-canvas/55 px-2.5 py-1.5 overflow-hidden"
          : effectiveFillHeight
          ? "group flex flex-1 min-h-0 flex-col rounded-md border border-border/80 bg-canvas/55 px-2.5 py-1.5 overflow-hidden"
          : compact
          ? "group rounded-md border border-border/80 bg-canvas/50 p-2.5"
          : "group rounded-lg border border-border bg-surface p-4"
      }
    >
      <div
        className={
          effectiveFillHeight
            ? "mb-1 flex shrink-0 flex-nowrap items-center justify-between gap-1.5"
            : compact
            ? "mb-1.5 flex flex-wrap items-center justify-between gap-2"
            : "mb-3 flex flex-wrap items-center justify-between gap-3"
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h3
              className={
                compact
                  ? "truncate text-xs font-semibold text-zinc-200"
                  : "truncate text-sm font-semibold text-zinc-100"
              }
            >
              {series.probe_name}
            </h3>
            {!compact && series.location_label && (
              <span className="rounded border border-border bg-elevated px-2 py-0.5 text-[11px] font-mono text-zinc-400">
                {series.location_label}
              </span>
            )}
          </div>
        </div>

        <div
          className={
            compact
              ? "flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap text-[11px] font-mono tabular-nums"
              : "flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums"
          }
        >
          {!compact && displayReadout.ts && (
            <span className="text-zinc-400">
              {formatDateTime24(displayReadout.ts)}
            </span>
          )}
          {!compact && (
            <div title="Minimum RTT — best observed path latency">
              <span className="text-zinc-400 mr-1 cursor-help">BEST</span>
              <span className="text-zinc-200">{formatMs(displayReadout.min)}</span>
            </div>
          )}
          <div title="Typical median latency (50th percentile)">
            <span className="text-zinc-400 mr-1 cursor-help">NORMAL</span>
            <span
              className={
                readoutSeverity === "critical"
                  ? "text-rose-400 font-semibold"
                  : readoutSeverity === "warn"
                  ? "text-amber-400 font-semibold"
                  : "text-emerald-400 font-semibold"
              }
            >
              {formatMs(displayReadout.p50)}
            </span>
          </div>
          {shouldShowMeta && effectiveBaselineMs !== null && (
            <div title="Learned best-path baseline RTT from this probe">
              <span className="text-zinc-400 mr-1 cursor-help">BASE</span>
              <span className="text-zinc-200">{formatMs(effectiveBaselineMs)}</span>
            </div>
          )}
          {shouldShowMeta && effectiveWarnMs !== null && (
            <div title="Auto-computed latency warning threshold for this probe">
              <span className="text-zinc-400 mr-1 cursor-help">WARN</span>
              <span className="text-amber-300">{formatMs(effectiveWarnMs)}</span>
            </div>
          )}
          <div title="High-water latency (95th percentile, excl. top 5% spikes)">
            <span className="text-zinc-400 mr-1 cursor-help">HIGH</span>
            <span className="text-cyan-400">{formatMs(displayReadout.p95)}</span>
          </div>
          {!compact && (
            <div title="Round-trip delay variation (stability)">
              <span className="text-zinc-400 mr-1 cursor-help">JITTER</span>
              <span className="text-zinc-300">{formatMs(displayReadout.jitter)}</span>
            </div>
          )}
          <div title="Packet loss percentage">
            <span className="text-zinc-400 mr-1 cursor-help">LOSS</span>
            <span
              className={
                displayReadout.loss > 0
                  ? "text-rose-400 font-semibold"
                  : "text-zinc-300"
              }
            >
              {formatLoss(displayReadout.loss)}
            </span>
          </div>

          {enableExport && hasData && (
            <button
              type="button"
              onClick={() => void handleExportPng()}
              data-testid="copy-chart-png-btn"
              title="Copy evidence graph as PNG (or download on HTTP)"
              aria-label="Copy graph as PNG"
              className="inline-flex items-center gap-1 rounded border border-border bg-elevated/90 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-300"
            >
              {exportState === "copied" ? (
                <>
                  <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                  <span className="text-emerald-400">Copied PNG</span>
                </>
              ) : exportState === "downloaded" ? (
                <>
                  <Download className="h-3 w-3 text-cyan-400" aria-hidden="true" />
                  <span className="text-cyan-300">Saved PNG</span>
                </>
              ) : exportState === "error" ? (
                <span className="text-rose-400">Export err</span>
              ) : (
                <>
                  <Camera className="h-3 w-3" aria-hidden="true" />
                  {!compact && <span>Copy PNG</span>}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {series.timestamps.length === 0 ? (
        <div
          style={effectiveFillHeight ? undefined : { height: defaultHeight }}
          className={
            effectiveFillHeight
              ? "flex flex-1 min-h-[72px] items-center justify-center rounded border border-dashed border-border bg-canvas/50 text-xs font-mono text-zinc-400"
              : "flex items-center justify-center rounded border border-dashed border-border bg-canvas/50 text-xs font-mono text-zinc-400"
          }
        >
          Waiting for telemetry samples from this probe...
        </div>
      ) : (
        <div
          ref={containerRef}
          style={effectiveFillHeight ? undefined : { minHeight: defaultHeight }}
          className={effectiveFillHeight ? "flex-1 min-h-[72px] w-full overflow-hidden" : "w-full"}
        />
      )}
    </section>
  );
}
