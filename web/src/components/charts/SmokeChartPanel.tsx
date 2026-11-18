"use client";

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Camera, Check, Download, Maximize2, RotateCcw } from "lucide-react";
import type uPlot from "uplot";
import { formatAxisTicks24, formatDateTime24 } from "@/lib/date-format";
import { exportSmokeChartPng } from "@/lib/export-chart-png";
import {
  classifySampleSeverity,
  computeChartXBounds,
  computeChartYUpper,
  formatLoss,
  formatMs,
  rangeKeyToSeconds,
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

export type ExportButtonState = "idle" | "copied" | "downloaded" | "error";

export interface SmokeChartPanelHandle {
  exportPng: () => Promise<void>;
  resetZoom: () => void;
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
  windowSec?: number | null;
  intervalSec?: number | null;
  baselineMs?: number | null;
  warnMs?: number | null;
  showThresholdMeta?: boolean;
  enableExport?: boolean;
  hideActions?: boolean;
  probeBadgeTestId?: string;
  onZoomClick?: () => void;
  onZoomStateChange?: (isZoomed: boolean) => void;
  onExportStateChange?: (state: ExportButtonState) => void;
}

interface HoverReadout {
  ts: number | null;
  min: number | null;
  p50: number | null;
  p95: number | null;
  jitter: number | null;
  loss: number;
}

export const SmokeChartPanel = forwardRef<
  SmokeChartPanelHandle,
  SmokeChartPanelProps
>(function SmokeChartPanel(
  {
    series,
    syncKey,
    compact = false,
    fillHeight = false,
    fixedHeight,
    targetName,
    targetHost,
    rangeLabel,
    windowSec,
    intervalSec,
    baselineMs,
    warnMs,
    showThresholdMeta,
    enableExport = true,
    hideActions = false,
    probeBadgeTestId,
    onZoomClick,
    onZoomStateChange,
    onExportStateChange,
  },
  ref
) {
  const effectiveFillHeight = fillHeight || (fixedHeight !== undefined && fixedHeight > 0);
  const defaultHeight = compact ? (effectiveFillHeight ? 96 : 132) : 210;
  const shouldShowMeta = showThresholdMeta ?? !compact;
  const effectiveWarnMs = warnMs ?? series.warn_ms ?? null;
  const effectiveBaselineMs = baselineMs ?? series.baseline_ms ?? null;
  const effectiveWindowSec = windowSec ?? rangeKeyToSeconds(rangeLabel);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const seriesRef = useRef<ProbeSeriesInput>(series);
  seriesRef.current = series;
  const warnMsRef = useRef<number | null>(effectiveWarnMs);
  warnMsRef.current = effectiveWarnMs;
  const windowSecRef = useRef<number | null>(effectiveWindowSec);
  windowSecRef.current = effectiveWindowSec;
  const onZoomStateChangeRef = useRef(onZoomStateChange);
  onZoomStateChangeRef.current = onZoomStateChange;
  const onExportStateChangeRef = useRef(onExportStateChange);
  onExportStateChangeRef.current = onExportStateChange;

  const [isZoomed, setIsZoomed] = useState(false);
  const isZoomedRef = useRef(false);
  const programmaticScaleRef = useRef(false);
  const prevWindowKeyRef = useRef<string | number | null>(
    effectiveWindowSec ?? rangeLabel ?? null
  );
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);

  const latestIdx = useMemo(() => {
    for (let i = series.timestamps.length - 1; i >= 0; i--) {
      if (series.p50_ms[i] !== null || series.loss_pct[i] > 0) return i;
    }
    return series.timestamps.length - 1;
  }, [series]);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [exportState, setExportState] = useState<ExportButtonState>("idle");

  const updateZoomState = (zoomed: boolean) => {
    isZoomedRef.current = zoomed;
    setIsZoomed(zoomed);
    onZoomStateChangeRef.current?.(zoomed);
  };

  const updateExportState = (state: ExportButtonState) => {
    setExportState(state);
    onExportStateChangeRef.current?.(state);
  };

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

  function handleResetZoom() {
    const plot = plotRef.current;
    const bounds = computeChartXBounds(
      seriesRef.current.timestamps,
      windowSecRef.current
    );
    if (!plot || !bounds) return;
    updateZoomState(false);
    programmaticScaleRef.current = true;
    try {
      plot.setScale?.("x", { min: bounds[0], max: bounds[1] });
    } finally {
      programmaticScaleRef.current = false;
    }
  }

  async function handleExportPng() {
    if (!containerRef.current && series.timestamps.length === 0) return;
    try {
      const outcome = await exportSmokeChartPng({
        chartContainer: containerRef.current,
        series,
        targetName,
        targetHost,
        rangeLabel,
        warnMs: effectiveWarnMs,
      });
      updateExportState(outcome);
      setTimeout(() => updateExportState("idle"), 2000);
    } catch {
      updateExportState("error");
      setTimeout(() => updateExportState("idle"), 2000);
    }
  }

  useImperativeHandle(ref, () => ({
    exportPng: handleExportPng,
    resetZoom: handleResetZoom,
  }));

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
          x: {
            time: true,
            range: (_u, dataMin, dataMax) => {
              const bounds = computeChartXBounds(
                seriesRef.current.timestamps,
                windowSecRef.current
              );
              if (bounds) return bounds;
              return [dataMin, dataMax];
            },
          },
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
          setScale: [
            (u, key) => {
              if (key !== "x") return;
              if (programmaticScaleRef.current) return;
              const bounds = computeChartXBounds(
                seriesRef.current.timestamps,
                windowSecRef.current
              );
              if (!bounds) return;
              const min = u.scales.x?.min;
              const max = u.scales.x?.max;
              if (min === undefined || max === undefined) return;
              const zoomed = min > bounds[0] + 2 || max < bounds[1] - 2;
              updateZoomState(zoomed);
            },
          ],
        },
        plugins: [createSmokePlugin(seriesRef, warnMsRef, !compact)],
      };

      programmaticScaleRef.current = true;
      try {
        plot = new UPlot(
          opts,
          [seriesRef.current.timestamps, seriesRef.current.p50_ms] as unknown as uPlot.AlignedData,
          targetEl
        );
        plotRef.current = plot;
        const initBounds = computeChartXBounds(
          seriesRef.current.timestamps,
          windowSecRef.current
        );
        if (initBounds) {
          plot.setScale?.("x", { min: initBounds[0], max: initBounds[1] });
        }
      } finally {
        programmaticScaleRef.current = false;
      }

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
      isZoomedRef.current = false;
      setIsZoomed(false);
    };
  }, [hasData, syncKey, defaultHeight, compact, effectiveFillHeight]);

  useEffect(() => {
    const plot = plotRef.current;
    const el = containerRef.current;
    if (!plot || !el || !fixedHeight || fixedHeight <= 0) return;
    const w = Math.max(el.clientWidth || sizeRef.current.w, compact ? 220 : 300);
    const measuredH = el.clientHeight > 20 ? el.clientHeight : Math.max(72, fixedHeight - 24);
    const h = Math.max(72, Math.floor(measuredH));
    if (w !== sizeRef.current.w || h !== sizeRef.current.h) {
      sizeRef.current = { w, h };
      plot.setSize?.({ width: w, height: h });
    }
  }, [fixedHeight, compact]);

  useEffect(() => {
    const nextRangeKey = effectiveWindowSec ?? rangeLabel ?? null;
    const rangeChanged = prevWindowKeyRef.current !== nextRangeKey;
    prevWindowKeyRef.current = nextRangeKey;

    if (rangeChanged) {
      updateZoomState(false);
    }

    if (plotRef.current && series.timestamps.length > 0) {
      const shouldResetScale = rangeChanged || !isZoomedRef.current;
      programmaticScaleRef.current = true;
      try {
        plotRef.current.setData(
          [
            series.timestamps,
            series.p50_ms,
          ] as unknown as uPlot.AlignedData,
          shouldResetScale
        );
        if (shouldResetScale) {
          const bounds = computeChartXBounds(
            series.timestamps,
            effectiveWindowSec
          );
          if (bounds) {
            plotRef.current.setScale?.("x", {
              min: bounds[0],
              max: bounds[1],
            });
          }
        }
        plotRef.current.redraw?.();
      } finally {
        programmaticScaleRef.current = false;
      }
    }
  }, [series, effectiveWarnMs, effectiveWindowSec, rangeLabel]);

  const readoutSeverity = classifySampleSeverity({
    p50: displayReadout.p50,
    p95: displayReadout.p95,
    lossPct: displayReadout.loss,
    warnMs: effectiveWarnMs,
  });

  const showTopActionBar =
    !hideActions &&
    Boolean(isZoomed || onZoomClick || (enableExport && hasData) || (!compact && displayReadout.ts));

  return (
    <section
      aria-label={`Latency smoke chart from ${series.probe_name}`}
      data-testid="smoke-chart-panel"
      style={fixedHeight && fixedHeight > 0 ? { height: fixedHeight } : undefined}
      className={
        fixedHeight && fixedHeight > 0
          ? "group flex shrink-0 min-h-0 flex-col gap-1 overflow-hidden"
          : effectiveFillHeight
          ? "group flex flex-1 min-h-0 flex-col gap-1 overflow-hidden"
          : compact
          ? "group flex flex-col gap-1.5"
          : "group rounded-lg border border-border bg-surface p-4 space-y-2.5"
      }
    >
      {showTopActionBar && (
        <div className="flex shrink-0 items-center justify-between gap-2 min-w-0">
          <div className="min-w-0 flex-1 font-mono text-xs text-zinc-400 truncate">
            {!compact && displayReadout.ts ? formatDateTime24(displayReadout.ts) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isZoomed && (
              <button
                type="button"
                onClick={handleResetZoom}
                data-testid="reset-zoom-btn"
                title="Reset time zoom to full window"
                aria-label="Reset zoom"
                className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-amber-300 transition-colors hover:bg-amber-500/25"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                {!compact && <span>Reset Zoom</span>}
              </button>
            )}

            {onZoomClick && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onZoomClick();
                }}
                data-testid="zoom-chart-btn"
                title="Zoom & inspect target graph"
                aria-label="Zoom graph"
                className="inline-flex items-center gap-1 rounded border border-border bg-elevated/90 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
              >
                <Maximize2 className="h-3 w-3" aria-hidden="true" />
              </button>
            )}

            {enableExport && hasData && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleExportPng();
                }}
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
      )}

      {/* Clean Graph Box (No text or buttons inside graph area) */}
      <div
        className={
          effectiveFillHeight
            ? "flex flex-1 min-h-0 flex-col rounded border border-border/40 bg-canvas/35 px-1.5 py-0.5 overflow-hidden"
            : compact
            ? "rounded border border-border/50 bg-canvas/40 px-2 py-1 overflow-hidden"
            : "rounded-md border border-border/60 bg-canvas/40 p-2 overflow-hidden"
        }
      >
        {series.timestamps.length === 0 ? (
          onZoomClick ? (
            <button
              type="button"
              onClick={onZoomClick}
              data-testid="smoke-chart-empty-zoom"
              style={effectiveFillHeight ? undefined : { height: defaultHeight }}
              className={`${
                effectiveFillHeight ? "flex-1 min-h-[72px]" : ""
              } flex w-full flex-col items-center justify-center rounded border border-dashed border-border bg-canvas/50 px-2 text-center text-xs font-mono text-zinc-400 cursor-zoom-in transition-colors hover:border-emerald-500/40 hover:text-zinc-200`}
            >
              <span>Waiting for telemetry samples from this probe...</span>
              <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-emerald-400">
                <Maximize2 className="h-3 w-3" aria-hidden="true" />
                Click to zoom &amp; inspect MTR
              </span>
            </button>
          ) : (
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
          )
        ) : (
          <div
            ref={containerRef}
            onDoubleClick={handleResetZoom}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              suppressNextClickRef.current = false;
              pointerDownPosRef.current = { x: e.clientX ?? 0, y: e.clientY ?? 0 };
            }}
            onMouseDown={(e) => {
              if (e.button !== 0 || pointerDownPosRef.current) return;
              suppressNextClickRef.current = false;
              pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerCancel={() => {
              pointerDownPosRef.current = null;
              suppressNextClickRef.current = false;
            }}
            onPointerUp={(e) => {
              const start = pointerDownPosRef.current;
              pointerDownPosRef.current = null;
              if (!start) return;
              const dx = Math.abs((e.clientX ?? 0) - start.x);
              const dy = Math.abs((e.clientY ?? 0) - start.y);
              if (dx >= 8 || dy >= 8) {
                suppressNextClickRef.current = true;
              }
            }}
            onMouseUp={(e) => {
              const start = pointerDownPosRef.current;
              if (!start) return;
              pointerDownPosRef.current = null;
              const dx = Math.abs(e.clientX - start.x);
              const dy = Math.abs(e.clientY - start.y);
              if (dx >= 8 || dy >= 8) {
                suppressNextClickRef.current = true;
              }
            }}
            onClick={() => {
              if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                return;
              }
              onZoomClick?.();
            }}
            style={effectiveFillHeight ? undefined : { minHeight: defaultHeight }}
            className={`${
              effectiveFillHeight ? "flex-1 min-h-[72px] w-full overflow-hidden" : "w-full"
            } ${onZoomClick ? "cursor-zoom-in" : ""}`}
          />
        )}
      </div>

      {/* Bottom Footer Row: Probe Info (Bottom-Left) + NORMAL/HIGH/LOSS Readouts (Bottom-Right) */}
      <div
        className={
          compact
            ? "flex h-[18px] shrink-0 items-center justify-between gap-2 border-t border-border/50 pt-0.5 text-[10px] sm:text-[11px] font-mono tabular-nums min-w-0"
            : "flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-2 text-xs font-mono tabular-nums min-w-0"
        }
      >
        <div className="min-w-0 flex-1 truncate text-zinc-400">
          <span
            data-testid={probeBadgeTestId}
            className={compact ? "font-medium text-zinc-300" : "font-semibold text-zinc-100"}
          >
            {series.probe_name}
          </span>
          {series.location_label ? ` · ${series.location_label}` : ""}
          {intervalSec ? ` · Every ${intervalSec}s` : ""}
        </div>

        <div
          className={
            compact
              ? "flex min-w-0 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap"
              : "flex flex-wrap items-center gap-4"
          }
        >
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
        </div>
      </div>
    </section>
  );
});
