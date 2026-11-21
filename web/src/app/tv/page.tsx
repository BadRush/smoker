"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Bookmark,
  Camera,
  Check,
  Copy,
  Download,
  Flame,
  Maximize2,
  Pause,
  Pin,
  Play,
  Radio,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  SmokeChartPanel,
  type ExportButtonState,
  type SmokeChartPanelHandle,
} from "@/components/charts/SmokeChartPanel";
import { TargetZoomModal } from "@/components/charts/TargetZoomModal";
import { TimeRangePicker } from "@/components/charts/TimeRangePicker";
import {
  DisplaySizeControls,
  LayoutPresetPills,
} from "@/components/layout/DisplaySizeControls";
import {
  isEditableTarget,
  KeyboardShortcutsModal,
} from "@/components/layout/KeyboardShortcutsModal";
import { ProtocolFilterChips } from "@/components/targets/ProtocolFilterChips";
import {
  ApiError,
  apiRequest,
  type BatchSeriesResponse,
  type MatrixSnapshot,
  type ProbeSeries,
  type TVPreset,
} from "@/lib/api";
import { formatDateTime24 } from "@/lib/date-format";
import { saveEvidenceBrandName } from "@/lib/export-chart-png";
import {
  parseWidthSpec,
  type FlowMode,
} from "@/lib/display-layout";
import {
  formatCleanTargetTitle,
  getProtocolFamily,
  getProtocolFamilyMeta,
  groupItemsByProtocol,
  PROTOCOL_FAMILIES,
  type IpFamilyFilter,
  type ProtocolFamily,
} from "@/lib/protocol-filters";
import {
  appendSparkPoint,
  formatLoss,
  formatMs,
  mergeProbeSeriesWithCell,
  rangeKeyToSeconds,
  resolveEffectiveWarnMs,
  statusVisuals,
  type CellStatus,
} from "@/lib/smoke-math";
import {
  computeBestFitGrid,
  DEFAULT_TV_CONFIG,
  formatCustomWindowShort,
  groupSummariesByProbe,
  loadTvConfigFromStorage,
  MANUAL_CARD_OPTIONS,
  parseCustomWindowFromSearch,
  parseTvConfig,
  partitionTargetsForTv,
  resolveTvFlowMode,
  sanitizeTvConfig,
  saveTvConfigToStorage,
  selectFocalProbeCell,
  serializeTvConfig,
  TV_RANGES,
  UNGROUPED_GROUP_TOKEN,
  type CustomTimeWindow,
  type TargetHealthSummary,
  type TvGridLayout,
  type TvOrientation,
  type TvProbeDisplayMode,
  type TvRange,
  type TvSpotlightMode,
  type TvWallConfig,
} from "@/lib/tv-config";
import { useLiveSocket, type LiveEventMessage } from "@/lib/useLiveSocket";

function playAlertChime() {
  if (typeof window === "undefined") return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch {
    // Ignore autoplay restriction errors
  }
}

interface FocalTargetCardProps {
  item: TargetHealthSummary;
  layout: TvGridLayout;
  range: TvRange;
  customWindow?: CustomTimeWindow | null;
  rangeVersion?: number;
  seriesLoading?: boolean;
  probeMap: Map<string, string>;
  groupMap: Map<string, string>;
  seriesByTarget: Record<string, ProbeSeries[]>;
  selectedProbeId?: string;
  onSelectProbe: (targetId: string, probeId: string) => void;
  onZoomTarget: (targetId: string) => void;
  isHighlight?: boolean;
}

function FocalTargetCard({
  item,
  layout,
  range,
  customWindow = null,
  rangeVersion = 0,
  seriesLoading = false,
  probeMap,
  groupMap,
  seriesByTarget,
  selectedProbeId,
  onSelectProbe,
  onZoomTarget,
  isHighlight = false,
}: FocalTargetCardProps) {
  const { target, worstStatus, cells, isPinnedVip, isImpaired } = item;
  const isPerProbeCard = Boolean(item.focalProbeId);
  const vis = statusVisuals(worstStatus);
  const groupName = target.group_id ? groupMap.get(target.group_id) : null;
  const protoMeta = getProtocolFamilyMeta(target.probe_type);
  const cleanTitle = formatCleanTargetTitle(target.name, target.probe_type);
  const targetSeries = seriesByTarget[target.id] ?? [];
  const seriesMap = new Map(targetSeries.map((s) => [s.probe_id, s]));
  const focalCell = item.focalProbeId
    ? cells.find((c) => c.probe_id === item.focalProbeId) ?? null
    : selectFocalProbeCell(cells, selectedProbeId);
  const focalProbeLabel =
    item.focalProbeName ??
    (focalCell ? probeMap.get(focalCell.probe_id) ?? "Probe" : "Probe");
  const rawFocalSeries = focalCell
    ? mergeProbeSeriesWithCell(
        seriesMap.get(focalCell.probe_id),
        focalCell,
        focalProbeLabel,
        range,
        Boolean(customWindow)
      )
    : null;
  const focalSeries = rawFocalSeries
    ? {
        ...rawFocalSeries,
        location_label:
          rawFocalSeries.location_label || item.focalProbeLocation || "",
      }
    : null;

  const chartRef = useRef<SmokeChartPanelHandle | null>(null);
  const [isChartZoomed, setIsChartZoomed] = useState(false);
  const [exportState, setExportState] = useState<ExportButtonState>("idle");
  const hasChartData = Boolean(focalSeries && focalSeries.timestamps.length > 0);

  const cardBorderClass = isHighlight
    ? isImpaired
      ? "border-rose-500/50 bg-surface"
      : "border-amber-500/40 bg-surface"
    : "border-border bg-surface";

  return (
    <article
      data-testid={isHighlight ? "tv-highlight-card" : "tv-target-card"}
      style={
        layout.horizontalScroll
          ? {
              height: layout.cardHeight,
              width: layout.cardWidth,
              minWidth: layout.cardWidth,
              flexShrink: 0,
            }
          : {
              height: layout.cardHeight,
            }
      }
      className={`flex w-full shrink-0 flex-col justify-between gap-1 rounded-lg border p-2 overflow-hidden ${cardBorderClass}`}
    >
      {/* Compact Header (2 tight rows: Target + Actions/Status on row 1, Host + optional Multi-Probe Switcher on row 2) */}
      <div className="flex shrink-0 flex-col gap-0.5">
        <div className="flex h-5 items-center justify-between gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              type="button"
              onClick={() => onZoomTarget(target.id)}
              title="Click to zoom & inspect target graphs and MTR"
              className="truncate text-left text-[13px] font-bold leading-tight text-zinc-100 hover:text-emerald-300 transition-colors"
            >
              <h2>{cleanTitle}</h2>
            </button>
            <span
              className={`shrink-0 rounded border px-1.5 py-0 text-[10px] font-mono uppercase ${protoMeta.badgeClass}`}
            >
              {target.probe_type}
            </span>
            {isPinnedVip && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0 text-[9px] font-mono font-semibold text-amber-300">
                <Pin className="h-2.5 w-2.5" aria-hidden="true" />
                VIP
              </span>
            )}
            {isHighlight && isImpaired && (
              <span className="hidden sm:inline-flex shrink-0 items-center rounded border border-rose-500/40 bg-rose-500/15 px-1 py-0 text-[9px] font-mono font-semibold text-rose-300">
                SPOTLIGHT
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isChartZoomed && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  chartRef.current?.resetZoom();
                }}
                data-testid="reset-zoom-btn"
                title="Reset time zoom to full window"
                aria-label="Reset zoom"
                className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-amber-300 transition-colors hover:bg-amber-500/25"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onZoomTarget(target.id);
              }}
              data-testid="zoom-chart-btn"
              title="Zoom & inspect target graph"
              aria-label="Zoom graph"
              className="inline-flex items-center gap-1 rounded border border-border bg-elevated/90 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
            >
              <Maximize2 className="h-3 w-3" aria-hidden="true" />
            </button>

            {hasChartData && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void chartRef.current?.exportPng();
                }}
                data-testid="copy-chart-png-btn"
                title="Copy evidence graph as PNG to clipboard"
                aria-label="Copy graph as PNG"
                className="inline-flex items-center gap-1 rounded border border-border bg-elevated/90 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-300"
              >
                {exportState === "copied" ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                    <span className="text-emerald-400">Copied</span>
                  </>
                ) : exportState === "downloaded" ? (
                  <>
                    <Download className="h-3 w-3 text-cyan-400" aria-hidden="true" />
                    <span className="text-cyan-300">Saved</span>
                  </>
                ) : exportState === "error" ? (
                  <span className="text-rose-400">Err</span>
                ) : (
                  <Camera className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            )}

            <span
              data-testid="tv-card-status-badge"
              className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0 text-[10px] font-mono font-semibold leading-tight ${vis.badgeClass}`}
            >
              {vis.label}
            </span>
          </div>
        </div>

        <div className="flex h-4 items-center justify-between gap-2 min-w-0 text-[11px]">
          <div className="flex items-center gap-1.5 min-w-0">
            <p
              title={groupName ? `${target.host} · ${groupName}` : target.host}
              className="min-w-0 truncate font-mono text-zinc-400"
            >
              {target.host}
            </p>
          </div>

          {!isPerProbeCard && cells.length > 1 && (
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
              {cells.slice(0, 4).map((cell) => {
                const pName = probeMap.get(cell.probe_id) ?? "Probe";
                const cVis = statusVisuals((cell.status as CellStatus) || "unknown");
                const isFocal = focalCell?.probe_id === cell.probe_id;
                return (
                  <button
                    key={cell.probe_id}
                    type="button"
                    data-testid="tv-probe-chip"
                    aria-pressed={isFocal}
                    onClick={() => onSelectProbe(target.id, cell.probe_id)}
                    title={`${pName}: ${cVis.label} · Normal ${formatMs(cell.p50_ms)} · High ${formatMs(cell.p95_ms)} · Loss ${formatLoss(cell.loss_pct)}`}
                    className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-mono leading-tight transition-colors ${
                      isFocal
                        ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200 font-semibold"
                        : "border-border/80 bg-canvas/60 text-zinc-300 hover:text-zinc-100"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${cVis.dotClass}`} />
                    <span className="max-w-[76px] truncate">{pName}</span>
                    <span className="tabular-nums text-[9px] text-zinc-300">
                      {cell.status === "down" ? "DOWN" : formatMs(cell.p50_ms)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Focal 7:3 SmokePing Chart Panel + Bottom Footer */}
      <div
        data-testid={isHighlight ? "tv-highlight-probe-row" : "tv-focal-probe-row"}
        className="flex flex-1 min-h-0 flex-col overflow-hidden"
      >
        {!focalCell || !focalSeries ? (
          <div className="flex flex-1 min-h-0 flex-col gap-1 overflow-hidden">
            <button
              type="button"
              onClick={() => onZoomTarget(target.id)}
              style={{ height: layout.panelHeight }}
              className="flex flex-1 min-h-[72px] w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-canvas/50 px-2 text-center text-xs font-mono text-zinc-400 cursor-zoom-in transition-colors hover:border-emerald-500/40 hover:text-zinc-200"
            >
              <span>
                {isPerProbeCard
                  ? `Waiting for ${focalProbeLabel} telemetry...`
                  : "Waiting for probe telemetry..."}
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                <Maximize2 className="h-3 w-3" aria-hidden="true" />
                Click to zoom &amp; inspect MTR
              </span>
            </button>
            <div className="flex h-[18px] shrink-0 items-center justify-between gap-2 border-t border-border/50 pt-0.5 text-[10px] font-mono tabular-nums text-zinc-400">
              <div className="min-w-0 flex-1 truncate">
                <span
                  data-testid={isPerProbeCard ? "tv-card-probe-badge" : undefined}
                  className="font-medium text-zinc-300"
                >
                  {focalProbeLabel}
                </span>
                {item.focalProbeLocation ? ` · ${item.focalProbeLocation}` : ""}
                {` · Every ${target.interval_sec}s`}
              </div>
              <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                <span>NORMAL —</span>
                <span>HIGH —</span>
                <span>LOSS 0.0%</span>
              </div>
            </div>
          </div>
        ) : (
          <SmokeChartPanel
            ref={chartRef}
            compact
            fillHeight
            hideActions
            fixedHeight={layout.panelHeight + 18}
            syncKey={`tv-${isHighlight ? "hi" : "grid"}-${target.id}`}
            series={focalSeries}
            targetName={target.name}
            targetHost={target.host}
            rangeLabel={customWindow ? "CUSTOM" : range}
            windowSec={customWindow ? null : rangeKeyToSeconds(range)}
            fixedBounds={
              customWindow
                ? [customWindow.fromSec, customWindow.toSec]
                : null
            }
            rangeVersion={rangeVersion}
            loading={seriesLoading}
            intervalSec={target.interval_sec}
            probeBadgeTestId={isPerProbeCard ? "tv-card-probe-badge" : undefined}
            baselineMs={focalCell.baseline_ms ?? focalSeries.baseline_ms ?? null}
            warnMs={resolveEffectiveWarnMs({
              cellWarnMs: focalCell.warn_ms,
              seriesWarnMs: focalSeries.warn_ms,
              target,
              probeId: focalCell.probe_id,
              series: focalSeries,
            })}
            showThresholdMeta={Boolean(isHighlight)}
            onZoomClick={() => onZoomTarget(target.id)}
            onZoomStateChange={setIsChartZoomed}
            onExportStateChange={setExportState}
          />
        )}
      </div>
    </article>
  );
}

export default function NocTvWallboardPage() {
  const [cfg, setCfg] = useState<TvWallConfig>(DEFAULT_TV_CONFIG);
  const [customWindow, setCustomWindow] = useState<CustomTimeWindow | null>(null);
  const [rangeVersion, setRangeVersion] = useState<number>(0);
  const [seriesLoading, setSeriesLoading] = useState<boolean>(false);
  const customWindowRef = useRef<CustomTimeWindow | null>(null);
  customWindowRef.current = customWindow;
  const seriesReqSeqRef = useRef<number>(0);
  const [urlHydrated, setUrlHydrated] = useState(false);
  const [data, setData] = useState<MatrixSnapshot | null>(null);
  const [seriesByRange, setSeriesByRange] = useState<
    Record<string, Record<string, ProbeSeries[]>>
  >({});
  const activeSeriesKey = customWindow
    ? `custom:${customWindow.fromSec}:${customWindow.toSec}`
    : cfg.range;
  const seriesByTarget = useMemo(
    () => seriesByRange[activeSeriesKey] ?? {},
    [seriesByRange, activeSeriesKey]
  );
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [countdown, setCountdown] = useState(DEFAULT_TV_CONFIG.rotateSec);
  const [paused, setPaused] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [copied, setCopied] = useState(false);
  const [clockText, setClockText] = useState<string>("");
  const [simTargetId, setSimTargetId] = useState<string>("");
  const [simRunning, setSimRunning] = useState<boolean>(false);
  const [selectedProbeByTarget, setSelectedProbeByTarget] = useState<Record<string, string>>({});
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [impairedOnly, setImpairedOnly] = useState<boolean>(false);
  const [zoomTargetId, setZoomTargetId] = useState<string | null>(null);
  const [presets, setPresets] = useState<TVPreset[]>([]);
  const [activePresetSlug, setActivePresetSlug] = useState<string | null>(null);
  const [newPresetName, setNewPresetName] = useState<string>("");
  const [newPresetDefault, setNewPresetDefault] = useState<boolean>(true);
  const [presetBusy, setPresetBusy] = useState<boolean>(false);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [kioskKey, setKioskKey] = useState<string>("");
  const [stageBox, setStageBox] = useState<{ width: number; height: number }>({
    width: 1900,
    height: 988,
  });

  const mainRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const prevImpairedIdsRef = useRef<Set<string>>(new Set());
  const prevCriticalIdsRef = useRef<Set<string>>(new Set());
  const hasSeededImpairedRef = useRef<boolean>(false);
  const handledZoomQueryRef = useRef<boolean>(false);
  const initialConfigSourceRef = useRef<"preset-query" | "url-query" | "storage" | "default">("default");
  const requestedPresetSlugRef = useRef<string | null>(null);
  const appliedServerPresetRef = useRef<boolean>(false);
  const kioskKeyRef = useRef<string>("");

  const handleOpenZoomTarget = useCallback((targetId: string) => {
    setZoomTargetId(targetId);
  }, []);

  const handleCloseZoomTarget = useCallback(() => {
    setZoomTargetId(null);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.has("zoom")) {
        params.delete("zoom");
        const qs = params.toString();
        window.history.replaceState(
          null,
          "",
          qs ? `${window.location.pathname}?${qs}` : window.location.pathname
        );
      }
    }
  }, []);

  const handleSelectProbe = useCallback((targetId: string, probeId: string) => {
    setSelectedProbeByTarget((prev) => ({
      ...prev,
      [targetId]: probeId,
    }));
  }, []);

  // Track available <main> content stage box for dynamic Auto Best-Fit 7:3 sizing
  useEffect(() => {
    if (typeof window === "undefined") return;
    const measure = () => {
      const el = mainRef.current;
      if (el) {
        const cs = window.getComputedStyle(el);
        const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const w = Math.floor(el.clientWidth - padX);
        const h = Math.floor(el.clientHeight - padY);
        if (w > 200 && h > 200) {
          setStageBox((prev) =>
            prev.width === w && prev.height === h ? prev : { width: w, height: h }
          );
          return;
        }
      }
      const fallbackW = Math.max(320, window.innerWidth - 20);
      const fallbackH = Math.max(300, window.innerHeight - 94);
      setStageBox((prev) =>
        prev.width === fallbackW && prev.height === fallbackH
          ? prev
          : { width: fallbackW, height: fallbackH }
      );
    };

    measure();
    window.addEventListener("resize", measure);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && mainRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(mainRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  // Hydrate initial config from window.location.search or localStorage fallback on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const keyParam = (params.get("key") ?? "").trim();
    if (keyParam) {
      kioskKeyRef.current = keyParam;
      setKioskKey(keyParam);
    }
    const presetParam = (params.get("preset") ?? "").trim().toLowerCase();
    if (presetParam) {
      requestedPresetSlugRef.current = presetParam;
      initialConfigSourceRef.current = "preset-query";
    }
    const parsedCustom = parseCustomWindowFromSearch(window.location.search);
    if (parsedCustom) {
      customWindowRef.current = parsedCustom;
      setCustomWindow(parsedCustom);
    }
    params.delete("zoom");
    params.delete("preset");
    params.delete("key");
    params.delete("from");
    params.delete("to");
    const hasConfigSearch = params.toString().length > 0;
    const stored = loadTvConfigFromStorage();
    if (!presetParam) {
      if (hasConfigSearch) {
        initialConfigSourceRef.current = "url-query";
      } else if (stored) {
        initialConfigSourceRef.current = "storage";
      } else {
        initialConfigSourceRef.current = "default";
      }
    }
    const initial = hasConfigSearch
      ? parseTvConfig(window.location.search)
      : stored ?? DEFAULT_TV_CONFIG;
    setCfg(initial);
    setCountdown(initial.rotateSec);
    setUrlHydrated(true);
  }, []);

  useEffect(() => {
    if (handledZoomQueryRef.current || !data || typeof window === "undefined") return;
    const zId = new URLSearchParams(window.location.search).get("zoom");
    handledZoomQueryRef.current = true;
    if (zId && data.targets.some((t) => t.id === zId)) {
      setZoomTargetId(zId);
    }
  }, [data]);

  // Sync config updates to URL query parameters and localStorage without triggering router navigation.
  // Custom historical date windows are synced only to URL (?from=&to=), NEVER persisted to localStorage.
  const updateConfig = useCallback(
    (updater: (prev: TvWallConfig) => TvWallConfig, resetPage = true) => {
      setActivePresetSlug(null);
      setCfg((prev) => {
        const next = updater(prev);
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(serializeTvConfig(next));
          const activeCustom = customWindowRef.current;
          if (activeCustom) {
            params.set("from", String(activeCustom.fromSec));
            params.set("to", String(activeCustom.toSec));
          }
          const nextUrl = `${window.location.pathname}?${params.toString()}`;
          window.history.replaceState(null, "", nextUrl);
          saveTvConfigToStorage(next);
        }
        return next;
      });
      if (resetPage) {
        setPageIdx(0);
      }
    },
    []
  );

  const handleSelectPresetRange = useCallback(
    (nextRange: TvRange) => {
      customWindowRef.current = null;
      setCustomWindow(null);
      setRangeVersion((v) => v + 1);
      updateConfig((prev) => ({ ...prev, range: nextRange }), false);
    },
    [updateConfig]
  );

  const handleApplyCustomWindow = useCallback((win: CustomTimeWindow) => {
    customWindowRef.current = win;
    setCustomWindow(win);
    setRangeVersion((v) => v + 1);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("from", String(win.fromSec));
      params.set("to", String(win.toSec));
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params.toString()}`
      );
    }
  }, []);

  const applyTvPreset = useCallback((preset: TVPreset, syncUrl = true) => {
    customWindowRef.current = null;
    setCustomWindow(null);
    const nextCfg = sanitizeTvConfig(preset.config);
    setCfg(nextCfg);
    setCountdown(nextCfg.rotateSec);
    setPageIdx(0);
    setActivePresetSlug(preset.slug);
    if (typeof window !== "undefined") {
      saveTvConfigToStorage(nextCfg);
      if (syncUrl) {
        const params = new URLSearchParams();
        params.set("preset", preset.slug);
        window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      }
    }
  }, []);

  const loadTvPresets = useCallback(async () => {
    try {
      const keySuffix = kioskKeyRef.current
        ? `?key=${encodeURIComponent(kioskKeyRef.current)}`
        : "";
      const list = await apiRequest<TVPreset[]>(`/api/tv/presets${keySuffix}`);
      if (!Array.isArray(list)) return;
      setPresets(list);

      if (!appliedServerPresetRef.current) {
        appliedServerPresetRef.current = true;
        if (
          initialConfigSourceRef.current === "preset-query" &&
          requestedPresetSlugRef.current
        ) {
          const matched = list.find(
            (p) => p.slug.toLowerCase() === requestedPresetSlugRef.current
          );
          if (matched) {
            applyTvPreset(matched, false);
          }
        } else if (initialConfigSourceRef.current === "default") {
          const defPreset = list.find((p) => p.is_default);
          if (defPreset) {
            applyTvPreset(defPreset, false);
          }
        }
      }
    } catch {
      // ignore if presets endpoint unavailable in minimal test mocks
    }
  }, [applyTvPreset]);

  const loadTvMatrix = useCallback(async () => {
    try {
      setError(null);
      const keySuffix = kioskKeyRef.current
        ? `?key=${encodeURIComponent(kioskKeyRef.current)}`
        : "";
      const snap = await apiRequest<MatrixSnapshot>(`/api/tv/matrix${keySuffix}`);
      if (kioskKeyRef.current && typeof window !== "undefined") {
        // Server has now issued HttpOnly smoker_tv_kiosk cookie; remove secret key from address bar
        const params = new URLSearchParams(window.location.search);
        if (params.has("key")) {
          params.delete("key");
          const qs = params.toString();
          window.history.replaceState(
            null,
            "",
            qs ? `${window.location.pathname}?${qs}` : window.location.pathname
          );
        }
        kioskKeyRef.current = "";
      }
      if (snap.brand_name !== undefined) {
        saveEvidenceBrandName(snap.brand_name);
      }
      setData(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load NOC TV matrix");
    }
  }, []);

  useEffect(() => {
    if (!urlHydrated) return;
    void loadTvMatrix();
    void loadTvPresets();
    const poll = setInterval(() => {
      void loadTvMatrix();
    }, 5000);
    return () => clearInterval(poll);
  }, [urlHydrated, loadTvMatrix, loadTvPresets]);

  // Live 24h + short date clock ticker (single-line NOC format: "19 Nov · 16:57:57")
  useEffect(() => {
    const updateClock = () => {
      setClockText(
        formatDateTime24(new Date(), { includeYear: false, includeSeconds: true })
      );
    };
    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleLiveEvent = useCallback(
    (ev: LiveEventMessage) => {
      if (ev.type === "probe_status" || ev.type === "incident_update") {
        void loadTvMatrix();
        return;
      }
      if (ev.type === "sample_tick") {
        const payload = ev.data as {
          probe_id?: string;
          status?: string;
          backlog_count?: number;
          samples?: Array<{
            ts_ns?: number;
            target_id: string;
            rtt_us?: number;
            jitter_us: number;
            is_loss: boolean;
          }>;
        };
        const probeId = payload.probe_id;
        const samples = payload.samples;
        if (!probeId || !samples) return;
        const nowSec = Math.floor(Date.now() / 1000);
        setData((prev) => {
          if (!prev) return prev;
          const sampleMap = new Map(samples.map((s) => [s.target_id, s]));
          const nextCells = prev.cells.map((c) => {
            if (c.probe_id !== probeId) return c;
            const rec = sampleMap.get(c.target_id);
            if (!rec) return c;
            const rttMs =
              rec.rtt_us !== undefined
                ? Math.round((rec.rtt_us / 1000) * 100) / 100
                : c.p50_ms;
            const ptSec = rec.ts_ns ? Math.floor(rec.ts_ns / 1e9) : nowSec;
            const ptVal = rec.is_loss
              ? null
              : rec.rtt_us !== undefined
              ? Math.round((rec.rtt_us / 1000) * 100) / 100
              : null;
            return {
              ...c,
              p50_ms: rec.is_loss ? c.p50_ms : rttMs,
              jitter_ms: rec.is_loss
                ? c.jitter_ms
                : Math.round((rec.jitter_us / 1000) * 100) / 100,
              status: (rec.is_loss
                ? "loss"
                : c.status === "unknown"
                ? "healthy"
                : c.status) as CellStatus,
              sparkline: appendSparkPoint(c.sparkline, {
                ts: ptSec,
                min: ptVal,
                p50: ptVal,
                p95: ptVal,
                loss: rec.is_loss ? 100 : 0,
              }),
            };
          });
          return { ...prev, cells: nextCells };
        });
      }
    },
    [loadTvMatrix]
  );

  const wsState = useLiveSocket(["matrix"], handleLiveEvent, {
    scope: "tv",
    kioskKey: kioskKey || undefined,
  });

  const groupMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!data) return map;
    for (const g of data.groups) {
      map.set(g.id, g.name);
    }
    return map;
  }, [data]);

  const probeMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!data) return map;
    for (const p of data.probes) {
      map.set(p.id, p.name);
    }
    return map;
  }, [data]);

  const filteredTargets = useMemo(() => {
    if (!data) return [];
    const q = searchQuery.trim().toLowerCase();
    const probeFilterSet = new Set(cfg.probes);
    return data.targets.filter((t) => {
      if (impairedOnly) {
        const hasImpaired = data.cells.some(
          (c) =>
            c.target_id === t.id &&
            (probeFilterSet.size === 0 || probeFilterSet.has(c.probe_id)) &&
            (c.status === "down" || c.status === "loss" || c.status === "degraded")
        );
        if (!hasImpaired) return false;
      }
      if (!q) return true;
      const gName = t.group_id ? (groupMap.get(t.group_id) ?? "").toLowerCase() : "ungrouped";
      return (
        t.name.toLowerCase().includes(q) ||
        t.host.toLowerCase().includes(q) ||
        t.probe_type.toLowerCase().includes(q) ||
        gName.includes(q)
      );
    });
  }, [data, searchQuery, impairedOnly, groupMap, cfg.probes]);

  const effectiveFlow = useMemo(
    () => resolveTvFlowMode(cfg, stageBox.width, stageBox.height),
    [cfg, stageBox.width, stageBox.height]
  );

  const parsedWidthSpec = useMemo(
    () =>
      parseWidthSpec(cfg.widthSpec, {
        allowAuto: false,
        allowFull: true,
        minPx: 320,
        maxPx: 2560,
        minPct: 35,
        maxPct: 100,
      }),
    [cfg.widthSpec]
  );

  const stageContainerStyle = useMemo(
    () =>
      !parsedWidthSpec || parsedWidthSpec.kind === "full"
        ? undefined
        : { maxWidth: parsedWidthSpec.cssValue },
    [parsedWidthSpec]
  );

  const prePartitioned = useMemo(() => {
    if (!data) {
      return { totalFiltered: 0 };
    }
    return partitionTargetsForTv(filteredTargets, data.cells, cfg, 12, data.probes);
  }, [data, filteredTargets, cfg]);

  const gridLayout = useMemo(
    () =>
      computeBestFitGrid({
        width: stageBox.width,
        height: stageBox.height,
        orientation: cfg.orientation,
        cardsOverride: cfg.cardsPerPage > 0 ? cfg.cardsPerPage : undefined,
        layoutMode: cfg.layoutMode,
        customCols: cfg.customCols,
        chartHeight: cfg.chartHeight,
        widthSpec: cfg.widthSpec,
        rowCardWidth: cfg.rowCardWidth,
        scrollMode: effectiveFlow === "scroll",
        maxItems:
          prePartitioned.totalFiltered > 0
            ? prePartitioned.totalFiltered
            : undefined,
      }),
    [
      stageBox.width,
      stageBox.height,
      cfg.orientation,
      cfg.cardsPerPage,
      cfg.layoutMode,
      cfg.customCols,
      cfg.chartHeight,
      cfg.widthSpec,
      cfg.rowCardWidth,
      effectiveFlow,
      prePartitioned.totalFiltered,
    ]
  );

  const toggleProtocolFilter = useCallback(
    (proto: ProtocolFamily) => {
      updateConfig((prev) => ({
        ...prev,
        protocols: prev.protocols.includes(proto)
          ? prev.protocols.filter((p) => p !== proto)
          : [...prev.protocols, proto],
      }));
    },
    [updateConfig]
  );

  const toggleGroupFilter = useCallback(
    (groupId: string) => {
      updateConfig((prev) => ({
        ...prev,
        groups: prev.groups.includes(groupId)
          ? prev.groups.filter((id) => id !== groupId)
          : [...prev.groups, groupId],
      }));
    },
    [updateConfig]
  );

  const toggleProbeFilter = useCallback(
    (probeId: string) => {
      updateConfig((prev) => ({
        ...prev,
        probes: prev.probes.includes(probeId)
          ? prev.probes.filter((id) => id !== probeId)
          : [...prev.probes, probeId],
      }));
    },
    [updateConfig]
  );

  const protocolCounts = useMemo(() => {
    const counts: Partial<Record<ProtocolFamily, number>> = {};
    if (!data) return counts;
    const groupSet = new Set(cfg.groups);
    const includeUngrouped = groupSet.has(UNGROUPED_GROUP_TOKEN);
    for (const t of data.targets) {
      if (!t.enabled) continue;
      if (groupSet.size > 0) {
        if (!t.group_id ? !includeUngrouped : !groupSet.has(t.group_id)) continue;
      }
      const fam = getProtocolFamily(t.probe_type);
      counts[fam] = (counts[fam] ?? 0) + 1;
    }
    return counts;
  }, [data, cfg.groups]);

  const ungroupedCount = useMemo(() => {
    if (!data) return 0;
    return data.targets.filter((t) => !t.group_id).length;
  }, [data]);

  const partitioned = useMemo(() => {
    if (!data) {
      return {
        allSummaries: [],
        pinnedAlerts: [],
        highlightItems: [],
        pages: [[]],
        slides: [{ kind: "grid" as const, label: "GRID 1/1", items: [] }],
        highlightSlideIdx: null as number | null,
        totalFiltered: 0,
      };
    }
    return partitionTargetsForTv(
      filteredTargets,
      data.cells,
      cfg,
      gridLayout.cardsPerPage,
      data.probes
    );
  }, [data, filteredTargets, cfg, gridLayout.cardsPerPage]);

  // Default simTargetId to the first active target when loaded
  useEffect(() => {
    if (!simTargetId && data && data.targets.length > 0) {
      setSimTargetId(data.targets[0].id);
    }
  }, [data, simTargetId]);

  // Event-Driven Auto-Switch (opt-in) + Audio Chime when a target newly enters a critical (loss/down) state
  useEffect(() => {
    if (!data) return;
    const currentLossOrDown = new Set(
      partitioned.pinnedAlerts
        .filter((a) => a.worstStatus === "loss" || a.worstStatus === "down")
        .map((a) => a.target.id)
    );
    const currentCritical = new Set(
      partitioned.pinnedAlerts
        .filter(
          (a) =>
            (a.worstStatus === "loss" || a.worstStatus === "down") &&
            (cfg.spotlightMode !== "vip" || a.isPinnedVip)
        )
        .map((a) => a.target.id)
    );

    if (!hasSeededImpairedRef.current) {
      hasSeededImpairedRef.current = true;
      prevImpairedIdsRef.current = currentLossOrDown;
      prevCriticalIdsRef.current = currentCritical;
      return;
    }

    let hasNewLossOrDown = false;
    for (const id of currentLossOrDown) {
      if (!prevImpairedIdsRef.current.has(id)) {
        hasNewLossOrDown = true;
        break;
      }
    }
    let hasNewCritical = false;
    for (const id of currentCritical) {
      if (!prevCriticalIdsRef.current.has(id)) {
        hasNewCritical = true;
        break;
      }
    }
    prevImpairedIdsRef.current = currentLossOrDown;
    prevCriticalIdsRef.current = currentCritical;

    if (hasNewLossOrDown && cfg.sound) {
      playAlertChime();
    }
    if (
      hasNewCritical &&
      cfg.spotlightMode !== "off" &&
      cfg.autoSwitchSpotlight &&
      cfg.rotateSec > 0 &&
      !paused &&
      partitioned.highlightSlideIdx !== null
    ) {
      setPageIdx(partitioned.highlightSlideIdx);
      setCountdown(cfg.rotateSec);
    }
  }, [
    data,
    partitioned.pinnedAlerts,
    partitioned.highlightSlideIdx,
    cfg.sound,
    cfg.spotlightMode,
    cfg.autoSwitchSpotlight,
    cfg.rotateSec,
    paused,
  ]);

  const totalSlides = partitioned.slides.length;
  const safeSlideIdx = pageIdx < totalSlides ? pageIdx : 0;
  const activeSlide = partitioned.slides[safeSlideIdx] ?? {
    kind: "grid" as const,
    label: "GRID 1/1",
    items: [],
  };

  // Batch fetch historical quantile SmokePing series for visible wallboard cards
  const visibleIdsKey = useMemo(() => {
    const items =
      effectiveFlow === "scroll" && activeSlide.kind !== "highlight"
        ? partitioned.allSummaries
        : activeSlide.items;
    return items
      .map((it) => it.target.id)
      .sort()
      .join(",");
  }, [effectiveFlow, activeSlide.kind, activeSlide.items, partitioned.allSummaries]);

  const loadVisibleSeries = useCallback(async (showSpinner = true) => {
    if (!urlHydrated || !visibleIdsKey) return;
    const reqId = ++seriesReqSeqRef.current;
    if (showSpinner) {
      setSeriesLoading(true);
    }
    const requestedKey = customWindow
      ? `custom:${customWindow.fromSec}:${customWindow.toSec}`
      : cfg.range;
    const rangeQuery = customWindow
      ? `from=${customWindow.fromSec}&to=${customWindow.toSec}`
      : `range=${cfg.range}`;
    try {
      const res = await apiRequest<BatchSeriesResponse>(
        `/api/tv/series?${rangeQuery}&ids=${encodeURIComponent(visibleIdsKey)}`
      );
      setSeriesByRange((prev) => ({
        ...prev,
        [requestedKey]: {
          ...(prev[requestedKey] ?? {}),
          ...res.targets,
        },
      }));
    } catch {
      // Fall back gracefully to live rolling cache if batch series fetch temporarily fails
    } finally {
      if (reqId === seriesReqSeqRef.current) {
        setSeriesLoading(false);
      }
    }
  }, [urlHydrated, visibleIdsKey, cfg.range, customWindow]);

  useEffect(() => {
    if (!urlHydrated || !visibleIdsKey) return;
    void loadVisibleSeries(true);
    if (customWindow) {
      // Historical custom windows are frozen; skip background rolling series polling
      return;
    }
    const isLongRange =
      cfg.range === "12h" ||
      cfg.range === "24h" ||
      cfg.range === "3d" ||
      cfg.range === "7d" ||
      cfg.range === "30d";
    const intervalMs = isLongRange ? 60_000 : 15_000;
    const poll = setInterval(() => {
      void loadVisibleSeries(false);
    }, intervalMs);
    return () => clearInterval(poll);
  }, [urlHydrated, visibleIdsKey, cfg.range, customWindow, rangeVersion, loadVisibleSeries]);

  async function handleSimulateAnomaly(
    mode: "high_latency" | "intermittent_loss" | "down" | "clear"
  ) {
    const targetId = simTargetId || data?.targets[0]?.id;
    if (!targetId) return;
    try {
      setSimRunning(true);
      await apiRequest(`/api/targets/${targetId}/simulate`, {
        method: "POST",
        body: JSON.stringify({ mode, duration_sec: 30 }),
      });
      const snap = await apiRequest<MatrixSnapshot>("/api/tv/matrix");
      setData(snap);
      const nextPart = partitionTargetsForTv(
        snap.targets,
        snap.cells,
        cfg,
        gridLayout.cardsPerPage,
        snap.probes
      );
      if (mode !== "clear") {
        if (cfg.spotlightMode !== "off" && nextPart.highlightSlideIdx !== null) {
          setPageIdx(nextPart.highlightSlideIdx);
          setCountdown(cfg.rotateSec);
          setShowDrawer(false);
        } else {
          setImpairedOnly(true);
          setPageIdx(0);
          setShowDrawer(false);
        }
      } else {
        setImpairedOnly(false);
        setPageIdx(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setSimRunning(false);
    }
  }

  // Carousel rotation timer across slides (automatically paused while Zoom Modal is open)
  useEffect(() => {
    if (cfg.rotateSec <= 0 || paused || zoomTargetId !== null || totalSlides <= 1) {
      setCountdown(cfg.rotateSec);
      return;
    }
    setCountdown(cfg.rotateSec);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setPageIdx((p) => (p + 1) % totalSlides);
          return cfg.rotateSec;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cfg.rotateSec, paused, zoomTargetId, totalSlides]);

  const handleToggleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  }, []);

  // NOC TV keyboard shortcuts:
  // Ctrl+F / "/" -> search, Smart 2-step Esc, "?" -> cheatsheet,
  // ←/→ -> prev/next slide, Space -> play/pause (slides mode), f -> fullscreen,
  // a -> toggle impaired filter, 1-7 -> switch graph time range.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const inInput = isEditableTarget(e.target);
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      const isCtrlF = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";

      if (e.key === "Escape") {
        if (zoomTargetId !== null || showShortcuts) return;
        if (showSearch) {
          if (document.activeElement === searchInputRef.current && searchQuery) {
            e.preventDefault();
            setSearchQuery("");
            setPageIdx(0);
          } else {
            setShowSearch(false);
          }
          return;
        }
        if (showDrawer) {
          setShowDrawer(false);
        }
        return;
      }

      if (
        e.key === "?" &&
        !inInput &&
        !hasModifier &&
        !showDrawer &&
        zoomTargetId === null
      ) {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
        return;
      }

      if (showDrawer || showShortcuts || zoomTargetId !== null) return;

      if (isCtrlF || (e.key === "/" && !inInput && !hasModifier)) {
        e.preventDefault();
        if (showSearch && searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        } else {
          setShowSearch(true);
          requestAnimationFrame(() => {
            const el = searchInputRef.current;
            if (el && document.activeElement !== el) {
              el.focus();
              el.select();
            }
          });
        }
        return;
      }

      if (inInput || hasModifier) return;

      if (e.key === "ArrowRight" && totalSlides > 1) {
        e.preventDefault();
        setPageIdx((p) => (p + 1) % totalSlides);
        setCountdown(cfg.rotateSec);
        return;
      }

      if (e.key === "ArrowLeft" && totalSlides > 1) {
        e.preventDefault();
        setPageIdx((p) => (p - 1 + totalSlides) % totalSlides);
        setCountdown(cfg.rotateSec);
        return;
      }

      if (e.key === " " && effectiveFlow === "slides" && totalSlides > 1) {
        e.preventDefault();
        if (cfg.rotateSec === 0) {
          setPaused(false);
          updateConfig((prev) => ({ ...prev, rotateSec: 15 }), false);
        } else {
          setPaused((p) => !p);
        }
        return;
      }

      const lower = e.key.toLowerCase();
      if (lower === "f") {
        e.preventDefault();
        handleToggleFullscreen();
        return;
      }

      if (lower === "a" && (partitioned.pinnedAlerts.length > 0 || impairedOnly)) {
        e.preventDefault();
        setImpairedOnly((prev) => !prev);
        setPageIdx(0);
        return;
      }

      if (e.key >= "1" && e.key <= String(TV_RANGES.length)) {
        const range = TV_RANGES[Number(e.key) - 1];
        if (range) {
          e.preventDefault();
          handleSelectPresetRange(range);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    zoomTargetId,
    showSearch,
    searchQuery,
    showDrawer,
    showShortcuts,
    totalSlides,
    effectiveFlow,
    cfg.rotateSec,
    partitioned.pinnedAlerts.length,
    impairedOnly,
    updateConfig,
    handleSelectPresetRange,
    handleToggleFullscreen,
  ]);

  const kpis = useMemo(() => {
    if (!data) return { probesOnline: 0, totalProbes: 0, healthyTargets: 0 };
    const probesOnline = data.probes.filter((p) => p.status !== "offline").length;
    const healthyTargets = Math.max(
      0,
      partitioned.totalFiltered - partitioned.pinnedAlerts.length
    );
    return {
      probesOnline,
      totalProbes: data.probes.length,
      healthyTargets,
    };
  }, [data, partitioned]);

  const isAdmin = Boolean(data?.is_admin);

  async function handleSaveNewPreset(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = newPresetName.trim();
    if (!cleanName) return;
    setPresetBusy(true);
    setPresetNotice(null);
    try {
      const created = await apiRequest<TVPreset>("/api/tv/presets", {
        method: "POST",
        body: JSON.stringify({
          name: cleanName,
          config: cfg,
          is_default: newPresetDefault,
        }),
      });
      setNewPresetName("");
      setActivePresetSlug(created.slug);
      setPresetNotice(
        created.is_default
          ? `Saved "${created.name}" as Default TV layout (auto-loads on reboot).`
          : `Saved preset "${created.name}".`
      );
      await loadTvPresets();
    } catch (err) {
      setPresetNotice(
        err instanceof ApiError ? err.detail : "Failed to save TV preset"
      );
    } finally {
      setPresetBusy(false);
    }
  }

  async function handleUpdatePreset(preset: TVPreset, opts: { setDefault?: boolean; overwriteConfig?: boolean }) {
    setPresetBusy(true);
    setPresetNotice(null);
    try {
      await apiRequest<TVPreset>(`/api/tv/presets/${preset.id}`, {
        method: "PUT",
        body: JSON.stringify({
          slug: preset.slug,
          name: preset.name,
          config: opts.overwriteConfig ? cfg : preset.config,
          is_default: opts.setDefault ? true : preset.is_default,
        }),
      });
      setPresetNotice(
        opts.setDefault
          ? `"${preset.name}" is now the Default TV preset on reboot.`
          : `Updated preset "${preset.name}" with current layout.`
      );
      await loadTvPresets();
    } catch (err) {
      setPresetNotice(
        err instanceof ApiError ? err.detail : "Failed to update TV preset"
      );
    } finally {
      setPresetBusy(false);
    }
  }

  async function handleDeletePreset(preset: TVPreset) {
    setPresetBusy(true);
    setPresetNotice(null);
    try {
      await apiRequest(`/api/tv/presets/${preset.id}`, { method: "DELETE" });
      if (activePresetSlug === preset.slug) {
        setActivePresetSlug(null);
      }
      setPresetNotice(`Deleted preset "${preset.name}".`);
      await loadTvPresets();
    } catch (err) {
      setPresetNotice(
        err instanceof ApiError ? err.detail : "Failed to delete TV preset"
      );
    } finally {
      setPresetBusy(false);
    }
  }

  const kioskUrl = useMemo(() => {
    const origin =
      typeof window === "undefined" || !urlHydrated ? "" : window.location.origin;
    if (activePresetSlug) {
      return `${origin}/tv?preset=${encodeURIComponent(activePresetSlug)}`;
    }
    const qs = serializeTvConfig(cfg);
    return `${origin}/tv?${qs}`;
  }, [cfg, urlHydrated, activePresetSlug]);

  async function handleCopyKioskUrl() {
    try {
      await navigator.clipboard.writeText(kioskUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const spotlightLayout = useMemo(
    () =>
      computeBestFitGrid({
        width: stageBox.width,
        height: Math.max(260, stageBox.height - 42),
        orientation: cfg.orientation,
        cardsOverride:
          cfg.cardsPerPage > 0
            ? Math.min(cfg.cardsPerPage, Math.max(1, activeSlide.items.length))
            : undefined,
        layoutMode: cfg.layoutMode,
        customCols: cfg.customCols,
        chartHeight: cfg.chartHeight,
        widthSpec: cfg.widthSpec,
        rowCardWidth: cfg.rowCardWidth,
        scrollMode: effectiveFlow === "scroll",
        maxItems: Math.max(1, activeSlide.items.length),
      }),
    [
      stageBox.width,
      stageBox.height,
      cfg.orientation,
      cfg.cardsPerPage,
      cfg.layoutMode,
      cfg.customCols,
      cfg.chartHeight,
      cfg.widthSpec,
      cfg.rowCardWidth,
      effectiveFlow,
      activeSlide.items.length,
    ]
  );

  const activeLayout =
    activeSlide.kind === "highlight" ? spotlightLayout : gridLayout;

  const hasCriticalImpaired = useMemo(
    () =>
      partitioned.pinnedAlerts.some(
        (a) => a.worstStatus === "down" || a.worstStatus === "loss"
      ),
    [partitioned.pinnedAlerts]
  );

  const slidePillLabel = useMemo(() => {
    if (activeSlide.label.startsWith("GRID ")) {
      return `${safeSlideIdx + 1}/${totalSlides}`;
    }
    return activeSlide.label;
  }, [activeSlide.label, safeSlideIdx, totalSlides]);

  const showSlideControl =
    (effectiveFlow === "slides" && totalSlides > 1) ||
    activeSlide.kind === "highlight";

  const hasActiveSearchFilter =
    Boolean(searchQuery) ||
    impairedOnly ||
    cfg.protocols.length > 0 ||
    cfg.ipVersion !== "all" ||
    cfg.splitByProtocol;

  return (
    <div
      data-testid="noc-tv-root"
      data-orientation={cfg.orientation}
      data-flow={effectiveFlow}
      data-layout={cfg.layoutMode}
      className="flex h-screen w-screen flex-col overflow-hidden bg-canvas text-zinc-100 select-none"
    >
      {/* Clean 3-Zone NOC TV Topbar (Option A + Variant A1 quiet inline alerts) */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 xl:gap-3 border-b border-border bg-surface px-3 xl:px-4 overflow-hidden">
        {/* Zone 1 (Left): Brand + Live Stream + Core KPIs + Quiet Inline Alert Indicator */}
        <div className="flex items-center gap-2 xl:gap-2.5 shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-400">
              <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <h1
              aria-label="Smoker"
              className="whitespace-nowrap text-xs xl:text-sm font-bold tracking-wider uppercase text-zinc-100"
            >
              SMOKER
            </h1>
          </div>

          {customWindow ? (
            <button
              type="button"
              data-testid="tv-historical-badge"
              onClick={() => handleSelectPresetRange(cfg.range)}
              title="Viewing historical custom range — click to return to Live"
              className="inline-flex shrink-0 items-center gap-1 rounded border border-cyan-500/45 bg-cyan-500/15 px-1.5 py-0.5 text-[10px] xl:text-[11px] font-mono uppercase text-cyan-200 hover:bg-cyan-500/25 whitespace-nowrap transition-colors"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
              HISTORICAL
            </button>
          ) : (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] xl:text-[11px] font-mono uppercase whitespace-nowrap ${
                wsState === "connected"
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/15 text-amber-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  wsState === "connected" ? "bg-emerald-400" : "bg-amber-400"
                }`}
              />
              {wsState === "connected" ? "LIVE" : "SYNC"}
            </span>
          )}

          <span className="hidden xl:block h-4 w-px bg-border shrink-0" aria-hidden="true" />

          <div
            data-testid="tv-header-kpis"
            className="hidden xl:flex items-center gap-3 text-xs font-mono tabular-nums whitespace-nowrap"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-400">PROBES</span>
              <span
                className={`font-bold ${
                  kpis.totalProbes > 0 && kpis.probesOnline === kpis.totalProbes
                    ? "text-emerald-400"
                    : kpis.probesOnline === 0 && kpis.totalProbes > 0
                    ? "text-rose-400"
                    : "text-amber-300"
                }`}
              >
                {kpis.probesOnline}/{kpis.totalProbes}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-400">OK</span>
              <span
                className={`font-bold ${
                  partitioned.totalFiltered > 0 &&
                  kpis.healthyTargets === partitioned.totalFiltered
                    ? "text-emerald-400"
                    : "text-zinc-100"
                }`}
              >
                {kpis.healthyTargets}/{partitioned.totalFiltered}
              </span>
            </div>
          </div>

          {/* Variant A1: Non-intrusive inline severity-aware counter beside KPIs */}
          {cfg.spotlightMode !== "off" && partitioned.highlightItems.length > 0 ? (
            <button
              type="button"
              data-testid="tv-spotlight-btn"
              title="Jump to Spotlight slide"
              onClick={() => {
                if (partitioned.highlightSlideIdx !== null) {
                  setPageIdx(partitioned.highlightSlideIdx);
                  setCountdown(cfg.rotateSec);
                }
              }}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-mono font-semibold whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                activeSlide.kind === "highlight"
                  ? "border-amber-500/45 bg-amber-500/15 text-amber-300"
                  : "border-transparent bg-transparent text-amber-400 hover:bg-white/5"
              }`}
            >
              <Flame className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>
                <span className="hidden lg:inline">SPOTLIGHT </span>(
                {partitioned.highlightItems.length})
              </span>
            </button>
          ) : partitioned.pinnedAlerts.length > 0 || impairedOnly ? (
            <button
              type="button"
              data-testid="tv-anomalies-btn"
              data-severity={hasCriticalImpaired ? "alert" : "warn"}
              aria-pressed={impairedOnly}
              title="Click to filter grid to impaired targets (down, loss, high latency)"
              onClick={() => {
                setImpairedOnly((prev) => !prev);
                setPageIdx(0);
              }}
              className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] font-mono font-semibold tabular-nums whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 ${
                impairedOnly
                  ? hasCriticalImpaired
                    ? "border-rose-500/45 bg-rose-500/15 text-rose-300 focus-visible:ring-rose-400"
                    : "border-amber-500/45 bg-amber-500/15 text-amber-300 focus-visible:ring-amber-400"
                  : hasCriticalImpaired
                  ? "border-transparent bg-transparent text-rose-400 hover:bg-white/5 focus-visible:ring-rose-400"
                  : "border-transparent bg-transparent text-amber-400 hover:bg-white/5 focus-visible:ring-amber-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  hasCriticalImpaired ? "bg-rose-400" : "bg-amber-400"
                }`}
                aria-hidden="true"
              />
              <span>
                {partitioned.pinnedAlerts.length}{" "}
                {hasCriticalImpaired ? "ALERT" : "WARN"}
                {impairedOnly ? " · Filtered" : ""}
              </span>
            </button>
          ) : null}
        </div>

        {/* Zone 2 (Center): Graph Time Range + Saved Preset Switcher */}
        <div className="flex items-center gap-2 min-w-0 shrink">
          <TimeRangePicker
            compact
            value={cfg.range}
            customWindow={customWindow}
            loading={seriesLoading}
            onSelectPreset={(r) => handleSelectPresetRange(r as TvRange)}
            onApplyCustom={handleApplyCustomWindow}
            ariaLabel="TV Graph time range"
            testId="tv-range-selector"
            className="hidden lg:inline-flex"
          />

          {presets.length > 0 && (
            <div className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-border bg-canvas/80 px-2 h-7 max-w-[175px] shrink-0 focus-within:border-emerald-500">
              <Bookmark className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
              <select
                aria-label="Switch TV preset"
                data-testid="tv-header-preset-select"
                value={activePresetSlug ?? ""}
                onChange={(e) => {
                  const chosen = presets.find((p) => p.slug === e.target.value);
                  if (chosen) applyTvPreset(chosen);
                }}
                className="min-w-0 flex-1 bg-transparent text-[11px] font-mono text-zinc-200 focus:outline-none truncate cursor-pointer"
              >
                <option value="" disabled className="bg-surface text-zinc-400">
                  Presets...
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.slug} className="bg-surface text-zinc-100">
                    {p.is_default ? `★ ${p.name}` : p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Zone 3 (Right — Static): Unified Slide/Play + 3-Icon Bar [Search | Fullscreen | Configure] + Dashboard + Clock */}
        <div className="flex items-center gap-1.5 xl:gap-2 shrink-0">
          {showSlideControl && (
            <div
              data-testid="tv-slide-control"
              className="inline-flex h-7 items-center rounded-md border border-border bg-elevated overflow-hidden shrink-0"
            >
              <button
                type="button"
                onClick={() => {
                  setPageIdx((p) => (p + 1) % totalSlides);
                  setCountdown(cfg.rotateSec);
                }}
                aria-label="Next TV Display slide"
                title="Next slide"
                className="flex h-full items-center gap-1 px-2 text-[11px] font-mono tabular-nums text-zinc-200 hover:bg-white/5 hover:text-white whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400"
              >
                <span>{slidePillLabel}</span>
                {cfg.rotateSec > 0 &&
                  totalSlides > 1 &&
                  !paused &&
                  effectiveFlow === "slides" && (
                    <span className="hidden sm:inline text-[10px] text-zinc-400">
                      · {countdown}s
                    </span>
                  )}
              </button>

              {totalSlides > 1 && effectiveFlow === "slides" && (
                <button
                  type="button"
                  onClick={() => {
                    if (cfg.rotateSec === 0) {
                      setPaused(false);
                      updateConfig((prev) => ({ ...prev, rotateSec: 15 }), false);
                    } else {
                      setPaused((p) => !p);
                    }
                  }}
                  title={
                    cfg.rotateSec === 0
                      ? "Start auto page rotation (15s)"
                      : paused
                      ? "Resume rotation"
                      : "Pause rotation"
                  }
                  aria-label={
                    cfg.rotateSec === 0
                      ? "Start rotation"
                      : paused
                      ? "Resume rotation"
                      : "Pause rotation"
                  }
                  className="hidden sm:inline-flex h-full items-center justify-center border-l border-border px-2 text-zinc-300 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400"
                >
                  {cfg.rotateSec === 0 || paused ? (
                    <Play className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Pause className="h-3 w-3" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          )}

          {/* Compact 3-Icon Action Group (Option A: Search + Fullscreen + Configure TV) */}
          <div className="inline-flex h-7 items-center rounded-md border border-border bg-elevated overflow-hidden shrink-0">
            <button
              type="button"
              data-testid="tv-search-toggle-btn"
              aria-label="Search and filter by protocol or host"
              aria-pressed={showSearch || hasActiveSearchFilter}
              title="Search & Filter (Ctrl+F or /)"
              onClick={() => {
                setShowSearch((prev) => {
                  const next = !prev;
                  if (next) {
                    setTimeout(() => searchInputRef.current?.focus(), 30);
                  }
                  return next;
                });
              }}
              className={`inline-flex h-full items-center justify-center gap-1 px-2 text-[11px] font-mono transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400 ${
                showSearch || hasActiveSearchFilter
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "text-zinc-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {(cfg.protocols.length > 0 ||
                cfg.ipVersion !== "all" ||
                cfg.splitByProtocol) && (
                <span className="hidden lg:inline uppercase whitespace-nowrap">
                  {[
                    ...cfg.protocols,
                    cfg.ipVersion !== "all" ? cfg.ipVersion : null,
                    cfg.splitByProtocol ? "Split" : null,
                  ]
                    .filter(Boolean)
                    .join("·")}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={handleToggleFullscreen}
              aria-label="Toggle fullscreen"
              title="Toggle Fullscreen"
              className="hidden sm:inline-flex h-full items-center justify-center border-l border-border px-2 text-zinc-300 hover:bg-white/5 hover:text-white transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400"
            >
              <Maximize2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => setShowDrawer(true)}
              aria-label="Configure TV Display"
              title="Configure TV Display (Presets, Layout, Columns, Probes, Audio Chime)"
              className="inline-flex h-full items-center justify-center border-l border-border px-2 text-zinc-200 hover:bg-white/5 hover:text-emerald-300 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400"
            >
              <Settings2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
          </div>

          <Link
            href="/"
            className="hidden md:inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-zinc-400 hover:bg-elevated hover:text-zinc-100 whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Dashboard
          </Link>

          {clockText && (
            <div
              data-testid="tv-header-clock"
              className="hidden xl:block border-l border-border pl-2.5 text-xs font-mono tabular-nums text-zinc-300 whitespace-nowrap shrink-0"
            >
              {clockText}
            </div>
          )}
        </div>
      </header>

      {/* Main Fit-to-Screen or Vertical-Scroll Wallboard Body */}
      <main
        ref={mainRef}
        className={`flex flex-1 min-h-0 flex-col gap-2 p-2.5 ${
          effectiveFlow === "scroll" ? "overflow-y-auto" : "overflow-hidden"
        }`}
      >
        {error && (
          <div
            role="alert"
            className="shrink-0 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
          >
            {error}
          </div>
        )}

        {/* Collapsible Quick Search, Protocol Focus & IP Filter Bar */}
        {showSearch && (
          <div
            data-testid="tv-search-bar"
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface/95 px-3 py-2 text-xs shadow-lg"
          >
            <div className="flex flex-1 min-w-[200px] items-center gap-2">
              <Search className="h-3.5 w-3.5 text-zinc-400 shrink-0" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="text"
                data-testid="tv-search-input"
                aria-label="Search monitored hosts"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPageIdx(0);
                }}
                placeholder="Search target name, IPv4/IPv6 host, protocol, or group..."
                className="w-full rounded border border-border bg-canvas px-2.5 py-1 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <ProtocolFilterChips
                compact
                testIdPrefix="tv-proto"
                selectedProtocols={cfg.protocols}
                onToggleProtocol={toggleProtocolFilter}
                onClearProtocols={() => updateConfig((prev) => ({ ...prev, protocols: [] }))}
                ipVersion={cfg.ipVersion}
                onChangeIpVersion={(ip: IpFamilyFilter) =>
                  updateConfig((prev) => ({ ...prev, ipVersion: ip }))
                }
                protocolCounts={protocolCounts}
              />

              <button
                type="button"
                data-testid="tv-split-protocol-btn"
                aria-pressed={cfg.splitByProtocol}
                onClick={() =>
                  updateConfig((prev) => ({
                    ...prev,
                    splitByProtocol: !prev.splitByProtocol,
                  }))
                }
                title="Separate TV carousel slides by protocol family (ICMP, DNS Query, HTTP, TCP)"
                className={`rounded border px-2 py-0.5 text-[11px] font-mono ${
                  cfg.splitByProtocol
                    ? "border-amber-500 bg-amber-500 font-semibold text-zinc-950"
                    : "border-border bg-elevated text-zinc-300 hover:text-zinc-100"
                }`}
              >
                Split by Protocol
              </button>

              {cfg.probeDisplayMode === "per-probe" && (
                <button
                  type="button"
                  data-testid="tv-group-probe-btn"
                  aria-pressed={cfg.groupByProbe}
                  onClick={() =>
                    updateConfig((prev) => ({
                      ...prev,
                      groupByProbe: !prev.groupByProbe,
                    }))
                  }
                  title="Group wallboard sections/slides by probe instead of keeping probes side-by-side per target"
                  className={`rounded border px-2 py-0.5 text-[11px] font-mono ${
                    cfg.groupByProbe
                      ? "border-cyan-500 bg-cyan-500 font-semibold text-zinc-950"
                      : "border-border bg-elevated text-zinc-300 hover:text-zinc-100"
                  }`}
                >
                  Group by Probe
                </button>
              )}

              <button
                type="button"
                aria-pressed={impairedOnly}
                onClick={() => {
                  setImpairedOnly((prev) => !prev);
                  setPageIdx(0);
                }}
                className={`rounded border px-2 py-0.5 text-[11px] font-mono ${
                  impairedOnly
                    ? "border-rose-500 bg-rose-500 font-semibold text-zinc-950"
                    : "border-border bg-elevated text-zinc-300 hover:text-zinc-100"
                }`}
              >
                Impaired Only
              </button>

              <span className="px-1 font-mono text-[11px] text-zinc-400">
                {partitioned.totalFiltered} match{partitioned.totalFiltered === 1 ? "" : "es"}
              </span>

              {(searchQuery ||
                impairedOnly ||
                cfg.protocols.length > 0 ||
                cfg.ipVersion !== "all" ||
                cfg.splitByProtocol) && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setImpairedOnly(false);
                    updateConfig((prev) => ({
                      ...prev,
                      protocols: [],
                      ipVersion: "all",
                      splitByProtocol: false,
                    }));
                  }}
                  className="rounded border border-border bg-elevated px-2 py-0.5 text-[11px] font-mono text-zinc-300 hover:text-white"
                >
                  Reset
                </button>
              )}

              <button
                type="button"
                aria-label="Close search bar"
                onClick={() => setShowSearch(false)}
                className="rounded p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        <div
          style={stageContainerStyle}
          className={`mx-auto flex w-full flex-col gap-2 ${
            effectiveFlow === "scroll" ? "shrink-0 pb-2" : "flex-1 min-h-0 overflow-hidden"
          }`}
        >
        {activeSlide.kind === "highlight" ? (
          /* Dedicated Highlight & Multi-Probe Spotlight Page (locked 7:3 focal graphs) */
          <section
            aria-label="Highlight and multi-probe spotlight"
            data-testid="tv-highlight-page"
            data-cols={spotlightLayout.cols}
            data-rows={spotlightLayout.rows}
            data-flow={effectiveFlow}
            className={`flex flex-col gap-2 ${
              effectiveFlow === "scroll" ? "" : "flex-1 min-h-0 overflow-hidden"
            }`}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs">
              <div className="flex items-center gap-2 font-bold uppercase tracking-wide text-amber-300 min-w-0">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  Multi-Probe Highlight &amp; Alert / Warn Spotlight ({activeSlide.items.length} Hosts ·{" "}
                  {customWindow
                    ? formatCustomWindowShort(customWindow.fromSec, customWindow.toSec)
                    : cfg.range}
                  )
                </span>
              </div>
              <span className="hidden xl:inline shrink-0 font-mono text-[11px] text-zinc-200">
                Highlights loss / down targets · Click probe chips to compare paths
              </span>
            </div>

            <div
              style={
                spotlightLayout.horizontalScroll
                  ? undefined
                  : {
                      gridTemplateColumns: `repeat(${spotlightLayout.cols}, minmax(0, 1fr))`,
                    }
              }
              className={
                spotlightLayout.horizontalScroll
                  ? "flex flex-nowrap flex-1 min-h-0 items-start gap-2.5 overflow-x-auto pb-2"
                  : `grid content-start items-start gap-2.5 ${
                      effectiveFlow === "scroll" ? "" : "flex-1 min-h-0 overflow-hidden"
                    }`
              }
            >
              {activeSlide.items.map((item) => (
                <FocalTargetCard
                  key={item.cardKey ?? item.target.id}
                  item={item}
                  layout={spotlightLayout}
                  range={cfg.range}
                  customWindow={customWindow}
                  rangeVersion={rangeVersion}
                  seriesLoading={seriesLoading}
                  probeMap={probeMap}
                  groupMap={groupMap}
                  seriesByTarget={seriesByTarget}
                  selectedProbeId={selectedProbeByTarget[item.target.id]}
                  onSelectProbe={handleSelectProbe}
                  onZoomTarget={handleOpenZoomTarget}
                  isHighlight
                />
              ))}
            </div>
          </section>
        ) : (() => {
          const gridItems =
            effectiveFlow === "scroll"
              ? partitioned.allSummaries
              : activeSlide.items;

          if (gridItems.length === 0) {
            return (
              <section
                aria-label="Monitored hosts TV display"
                data-testid="tv-cards-grid"
                data-cols={gridLayout.cols}
                data-rows={gridLayout.rows}
                data-flow={effectiveFlow}
                className="flex flex-1 min-h-[220px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface text-sm font-mono text-zinc-400"
              >
                <span>No active targets match the selected probe, group, or protocol filters.</span>
                {(cfg.groups.length > 0 ||
                  cfg.probes.length > 0 ||
                  cfg.protocols.length > 0 ||
                  cfg.ipVersion !== "all" ||
                  Boolean(searchQuery) ||
                  impairedOnly) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setImpairedOnly(false);
                      updateConfig((prev) => ({
                        ...prev,
                        groups: [],
                        probes: [],
                        protocols: [],
                        ipVersion: "all",
                      }));
                    }}
                    className="rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/25"
                  >
                    Reset Filters
                  </button>
                )}
              </section>
            );
          }

          if (
            effectiveFlow === "scroll" &&
            cfg.probeDisplayMode === "per-probe" &&
            cfg.groupByProbe
          ) {
            const probeSections = groupSummariesByProbe(
              gridItems,
              data?.probes ?? []
            );
            return (
              <section
                aria-label="Monitored hosts TV display"
                data-testid="tv-cards-grid"
                data-cols={gridLayout.cols}
                data-rows={gridLayout.rows}
                data-flow={effectiveFlow}
                className="space-y-4 pb-2"
              >
                {probeSections.map((sec) => (
                  <div key={sec.probeId} className="space-y-2">
                    <div className="flex items-center justify-between border-b border-border/70 pb-1">
                      <span className="inline-flex items-center gap-1.5 rounded border border-cyan-500/40 bg-cyan-500/15 px-2 py-0.5 text-xs font-mono font-semibold text-cyan-300">
                        <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{sec.probeName}</span>
                        {sec.locationLabel && (
                          <span className="text-[11px] font-normal text-cyan-200/80">
                            · {sec.locationLabel}
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[11px] text-zinc-400">
                        {sec.items.length} host{sec.items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div
                      style={{
                        gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, 1fr))`,
                      }}
                      className="grid content-start items-start gap-2.5"
                    >
                      {sec.items.map((item) => (
                        <FocalTargetCard
                          key={item.cardKey ?? item.target.id}
                          item={item}
                          layout={gridLayout}
                          range={cfg.range}
                          customWindow={customWindow}
                          rangeVersion={rangeVersion}
                          seriesLoading={seriesLoading}
                          probeMap={probeMap}
                          groupMap={groupMap}
                          seriesByTarget={seriesByTarget}
                          selectedProbeId={selectedProbeByTarget[item.target.id]}
                          onSelectProbe={handleSelectProbe}
                          onZoomTarget={handleOpenZoomTarget}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            );
          }

          if (effectiveFlow === "scroll" && cfg.splitByProtocol) {
            const protoSections = groupItemsByProtocol(gridItems, (it) => it.target);
            return (
              <section
                aria-label="Monitored hosts TV display"
                data-testid="tv-cards-grid"
                data-cols={gridLayout.cols}
                data-rows={gridLayout.rows}
                data-flow={effectiveFlow}
                className="space-y-4 pb-2"
              >
                {protoSections.map((sec) => (
                  <div key={sec.family.id} className="space-y-2">
                    <div className="flex items-center justify-between border-b border-border/70 pb-1">
                      <span
                        className={`rounded border px-2 py-0.5 text-xs font-mono font-semibold ${sec.family.badgeClass}`}
                      >
                        {sec.family.label}
                      </span>
                      <span className="font-mono text-[11px] text-zinc-400">
                        {sec.items.length} card{sec.items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div
                      style={{
                        gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, 1fr))`,
                      }}
                      className="grid content-start items-start gap-2.5"
                    >
                      {sec.items.map((item) => (
                        <FocalTargetCard
                          key={item.cardKey ?? item.target.id}
                          item={item}
                          layout={gridLayout}
                          range={cfg.range}
                          customWindow={customWindow}
                          rangeVersion={rangeVersion}
                          seriesLoading={seriesLoading}
                          probeMap={probeMap}
                          groupMap={groupMap}
                          seriesByTarget={seriesByTarget}
                          selectedProbeId={selectedProbeByTarget[item.target.id]}
                          onSelectProbe={handleSelectProbe}
                          onZoomTarget={handleOpenZoomTarget}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            );
          }

          return (
            <section
              aria-label="Monitored hosts TV display"
              data-testid="tv-cards-grid"
              data-cols={gridLayout.cols}
              data-rows={gridLayout.rows}
              data-flow={effectiveFlow}
              style={
                gridLayout.horizontalScroll
                  ? undefined
                  : {
                      gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, 1fr))`,
                    }
              }
              className={
                gridLayout.horizontalScroll
                  ? "flex flex-nowrap flex-1 min-h-0 items-start gap-2.5 overflow-x-auto pb-2"
                  : effectiveFlow === "scroll"
                  ? "grid content-start items-start gap-2.5"
                  : "grid flex-1 min-h-0 content-start items-start gap-2.5 overflow-hidden"
              }
            >
              {gridItems.map((item) => (
                <FocalTargetCard
                  key={item.cardKey ?? item.target.id}
                  item={item}
                  layout={gridLayout}
                  range={cfg.range}
                  customWindow={customWindow}
                  rangeVersion={rangeVersion}
                  seriesLoading={seriesLoading}
                  probeMap={probeMap}
                  groupMap={groupMap}
                  seriesByTarget={seriesByTarget}
                  selectedProbeId={selectedProbeByTarget[item.target.id]}
                  onSelectProbe={handleSelectProbe}
                  onZoomTarget={handleOpenZoomTarget}
                />
              ))}
            </section>
          );
        })()}
        </div>
      </main>

      {/* Compact Friendly Telemetry Legend Strip */}
      <footer
        data-testid="tv-legend-bar"
        className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-surface/70 px-3 xl:px-4 text-[10px] font-mono text-zinc-400"
      >
        <div className="flex items-center gap-3 overflow-x-auto whitespace-nowrap min-w-0">
          <span>
            <strong className="text-zinc-200">BEST</strong> min
          </span>
          <span>
            <strong className="text-emerald-400">NORMAL</strong> median RTT
          </span>
          <span>
            <strong className="text-amber-400">WARN</strong> ≥ threshold / loss
          </span>
          <span>
            <strong className="text-cyan-400">HIGH</strong> 95th pct
          </span>
          <span>
            <strong className="text-rose-400">LOSS</strong> % drop
          </span>
        </div>
        <span className="hidden sm:inline shrink-0 text-zinc-400">
          {cfg.cardsPerPage === 0 || effectiveFlow === "scroll"
            ? `${cfg.layoutMode === "auto" ? "Auto" : cfg.layoutMode} ${activeLayout.cols}×${activeLayout.rows} (${activeLayout.aspectRatio}:1)`
            : `Fixed ${activeLayout.cols}×${activeLayout.rows} (${activeLayout.aspectRatio}:1)`}{" "}
          · {effectiveFlow}
          {cfg.widthSpec !== "full" ? ` · ${cfg.widthSpec}` : ""} ·{" "}
          {customWindow
            ? formatCustomWindowShort(customWindow.fromSec, customWindow.toSec)
            : cfg.range}{" "}
          ·{" "}
          {partitionSummary(kpis.probesOnline, kpis.totalProbes, data?.active_incidents ?? 0)}
        </span>
      </footer>

      {/* Interactive Target Zoom & Multi-Probe Inspector Modal */}
      {zoomTargetId && data && (() => {
        const zTarget = data.targets.find((t) => t.id === zoomTargetId);
        if (!zTarget) return null;
        return (
          <TargetZoomModal
            mode="tv"
            target={zTarget}
            groupName={zTarget.group_id ? groupMap.get(zTarget.group_id) : null}
            cells={data.cells}
            probeMap={probeMap}
            initialRange={cfg.range}
            initialCustomWindow={customWindow}
            fallbackSeries={seriesByTarget[zTarget.id] ?? []}
            onClose={handleCloseZoomTarget}
          />
        );
      })()}

      {/* TV Configuration Drawer Modal */}
      {showDrawer && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tv-config-title"
          className="fixed inset-0 z-50 flex justify-end bg-black/75"
        >
          <div className="flex h-full max-h-screen w-full max-w-md flex-col border-l border-border bg-surface overflow-hidden">
            {/* Fixed Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
              <h2 id="tv-config-title" className="text-base font-bold text-zinc-100">
                TV Display Configuration
              </h2>
              <button
                type="button"
                onClick={() => setShowDrawer(false)}
                aria-label="Close configuration drawer"
                className="rounded p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Independently Scrollable Body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Saved 1-Click TV Display Presets */}
              <div
                data-testid="tv-presets-section"
                className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Bookmark className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <p className="text-xs font-semibold uppercase tracking-wider text-zinc-100">
                      TV Display Presets (1-Click)
                    </p>
                  </div>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {presets.length} saved
                  </span>
                </div>

                {presets.length === 0 ? (
                  <p className="text-[11px] text-zinc-400">
                    {isAdmin
                      ? "Save your current layout below so NOC monitors auto-restore it on reboot."
                      : "No server presets saved yet. Sign in as Admin to save default NOC layouts."}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {presets.map((p) => {
                      const isActive = activePresetSlug === p.slug;
                      return (
                        <div
                          key={p.id}
                          className={`flex items-center justify-between gap-1.5 rounded border px-2 py-1.5 text-xs ${
                            isActive
                              ? "border-emerald-500/60 bg-emerald-500/15"
                              : "border-border bg-canvas/80"
                          }`}
                        >
                          <button
                            type="button"
                            data-testid={`tv-preset-btn-${p.slug}`}
                            onClick={() => applyTvPreset(p)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            {p.is_default && (
                              <Star
                                className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400"
                                aria-label="Default preset"
                              />
                            )}
                            <span
                              className={`truncate font-medium ${
                                isActive ? "text-emerald-200" : "text-zinc-100 hover:text-emerald-300"
                              }`}
                            >
                              {p.name}
                            </span>
                            {p.is_default && (
                              <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0 text-[9px] font-mono uppercase text-amber-300">
                                Default
                              </span>
                            )}
                          </button>

                          <div className="flex items-center gap-1 shrink-0">
                            {isAdmin && !p.is_default && (
                              <button
                                type="button"
                                disabled={presetBusy}
                                aria-label={`Set preset ${p.name} as default`}
                                title="Set as Default on reboot"
                                onClick={() =>
                                  void handleUpdatePreset(p, { setDefault: true })
                                }
                                className="rounded border border-border bg-elevated px-1.5 py-0.5 text-[10px] font-mono text-zinc-300 hover:border-amber-500/50 hover:text-amber-300"
                              >
                                Set Default
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                type="button"
                                disabled={presetBusy}
                                aria-label={`Update preset ${p.name} with current layout`}
                                title="Overwrite with current layout"
                                onClick={() =>
                                  void handleUpdatePreset(p, { overwriteConfig: true })
                                }
                                className="rounded border border-border bg-elevated p-1 text-zinc-300 hover:border-emerald-500/50 hover:text-emerald-300"
                              >
                                <Save className="h-3 w-3" aria-hidden="true" />
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                type="button"
                                disabled={presetBusy}
                                aria-label={`Delete preset ${p.name}`}
                                onClick={() => void handleDeletePreset(p)}
                                className="rounded border border-rose-500/30 bg-rose-500/10 p-1 text-rose-300 hover:bg-rose-500/20"
                              >
                                <Trash2 className="h-3 w-3" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {isAdmin && (
                  <form
                    onSubmit={handleSaveNewPreset}
                    data-testid="tv-preset-admin-form"
                    className="space-y-2 border-t border-border/60 pt-2"
                  >
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        aria-label="New preset name"
                        value={newPresetName}
                        onChange={(e) => setNewPresetName(e.target.value)}
                        placeholder="Preset name (e.g. NOC Main Wall)"
                        className="min-w-0 flex-1 rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500"
                      />
                      <button
                        type="submit"
                        disabled={presetBusy || !newPresetName.trim()}
                        className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                      >
                        <Save className="h-3 w-3" aria-hidden="true" />
                        <span>Save</span>
                      </button>
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        aria-label="Set as default preset on reboot"
                        checked={newPresetDefault}
                        onChange={(e) => setNewPresetDefault(e.target.checked)}
                        className="rounded border-border bg-canvas"
                      />
                      <span>Auto-load as Default on fresh browser / reboot</span>
                    </label>
                  </form>
                )}

                {presetNotice && (
                  <p role="status" className="text-[11px] text-cyan-200">
                    {presetNotice}
                  </p>
                )}
              </div>

              {/* Graph Time Range */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Graph History Window
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {TV_RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={!customWindow && cfg.range === r}
                      onClick={() => handleSelectPresetRange(r)}
                      className={`rounded border px-2 py-1.5 text-xs font-mono ${
                        !customWindow && cfg.range === r
                          ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                          : "border-border bg-elevated text-zinc-200"
                      }`}
                    >
                      {r === "30d" ? "30d (1m)" : r}
                    </button>
                  ))}
                </div>
              </div>

              {/* Screen Orientation */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Display Orientation
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {(["landscape", "portrait"] as TvOrientation[]).map((ori) => (
                    <button
                      key={ori}
                      type="button"
                      aria-pressed={cfg.orientation === ori}
                      data-testid={`tv-drawer-layout-ori-${ori}`}
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, orientation: ori }))
                      }
                      className={`rounded-md border px-3 py-2 text-xs ${
                        cfg.orientation === ori
                          ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                          : "border-border bg-elevated font-medium text-zinc-200"
                      }`}
                    >
                      {ori === "landscape"
                        ? "Landscape (16:9)"
                        : "Portrait (9:16)"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Layout Mode, Flow & Custom Width/Height */}
              <div className="space-y-2.5 rounded-md border border-border bg-canvas p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Columns, Scroll Flow &amp; Custom Size
                </p>
                <LayoutPresetPills
                  testIdPrefix="tv-drawer-layout"
                  preset={cfg.layoutMode}
                  customCols={cfg.customCols}
                  onSelectPreset={(layoutMode, cols) =>
                    updateConfig((prev) => ({
                      ...prev,
                      layoutMode,
                      customCols: cols !== undefined ? cols : prev.customCols,
                    }))
                  }
                />
                {cfg.layoutMode === "single-row" && (
                  <div
                    role="group"
                    aria-label="1-Row card columns"
                    className="flex items-center gap-1.5"
                  >
                    <span className="font-mono text-[10px] text-zinc-400">Row Cols:</span>
                    {[0, 2, 3, 4].map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        aria-pressed={cfg.customCols === cnt}
                        data-testid={`tv-drawer-layout-rowcols-${cnt}`}
                        onClick={() =>
                          updateConfig((prev) => ({ ...prev, customCols: cnt }))
                        }
                        className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                          cfg.customCols === cnt
                            ? "border-cyan-500 bg-cyan-500 font-semibold text-zinc-950"
                            : "border-border bg-elevated text-zinc-300"
                        }`}
                      >
                        {cnt === 0 ? "Auto" : cnt}
                      </button>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: "auto", label: "Auto Flow" },
                      { id: "scroll", label: "Scroll ↓" },
                      { id: "slides", label: "Slides" },
                    ] as Array<{ id: FlowMode; label: string }>
                  ).map((fm) => (
                    <button
                      key={fm.id}
                      type="button"
                      aria-pressed={cfg.flowMode === fm.id}
                      data-testid={`tv-drawer-layout-flow-${fm.id}`}
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, flowMode: fm.id }))
                      }
                      className={`rounded border px-2 py-1 text-[11px] font-mono ${
                        cfg.flowMode === fm.id
                          ? "border-cyan-500 bg-cyan-500 font-semibold text-zinc-950"
                          : "border-border bg-elevated text-zinc-200"
                      }`}
                    >
                      {fm.label}
                    </button>
                  ))}
                </div>
                <DisplaySizeControls
                  testIdPrefix="tv-drawer-layout"
                  widthSpec={cfg.widthSpec}
                  onChangeWidthSpec={(widthSpec) =>
                    updateConfig((prev) => ({ ...prev, widthSpec }))
                  }
                  allowAutoWidth={false}
                  showRowCardWidth={cfg.layoutMode === "single-row"}
                  rowCardWidth={cfg.rowCardWidth}
                  onChangeRowCardWidth={(rowCardWidth) =>
                    updateConfig((prev) => ({ ...prev, rowCardWidth }))
                  }
                  chartHeight={cfg.chartHeight}
                  onChangeChartHeight={(chartHeight) =>
                    updateConfig((prev) => ({ ...prev, chartHeight }))
                  }
                  compact
                  onReset={() =>
                    updateConfig((prev) => ({
                      ...prev,
                      layoutMode: DEFAULT_TV_CONFIG.layoutMode,
                      customCols: DEFAULT_TV_CONFIG.customCols,
                      flowMode: DEFAULT_TV_CONFIG.flowMode,
                      widthSpec: DEFAULT_TV_CONFIG.widthSpec,
                      rowCardWidth: DEFAULT_TV_CONFIG.rowCardWidth,
                      chartHeight: DEFAULT_TV_CONFIG.chartHeight,
                    }))
                  }
                />
              </div>

              {/* Rotation Interval */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Carousel Rotation Interval
                </p>
                <div className="grid grid-cols-5 gap-1.5">
                  {[10, 15, 30, 60, 0].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      aria-pressed={cfg.rotateSec === sec}
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, rotateSec: sec }), false)
                      }
                      className={`rounded border px-2 py-1.5 text-xs font-mono ${
                        cfg.rotateSec === sec
                          ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                          : "border-border bg-elevated text-zinc-200"
                      }`}
                    >
                      {sec === 0 ? "Static" : `${sec}s`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Cards Per Page */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Cards Per Page (7:3 Graph Fit)
                </p>
                <div className="space-y-2">
                  <button
                    type="button"
                    aria-pressed={cfg.cardsPerPage === 0}
                    data-testid="tv-cards-auto-btn"
                    onClick={() =>
                      updateConfig((prev) => ({ ...prev, cardsPerPage: 0 }))
                    }
                    className={`w-full rounded border px-3 py-2 text-left text-xs font-mono ${
                      cfg.cardsPerPage === 0
                        ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                        : "border-border bg-elevated text-zinc-200"
                    }`}
                  >
                    Auto Best Fit ({gridLayout.cols}×{gridLayout.rows} ·{" "}
                    {gridLayout.cardsPerPage} cards · ~7:3)
                  </button>
                  <div className="grid grid-cols-3 gap-2">
                    {MANUAL_CARD_OPTIONS.map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        aria-pressed={cfg.cardsPerPage === cnt}
                        onClick={() =>
                          updateConfig((prev) => ({ ...prev, cardsPerPage: cnt }))
                        }
                        className={`rounded border px-3 py-1.5 text-xs font-mono ${
                          cfg.cardsPerPage === cnt
                            ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                            : "border-border bg-elevated text-zinc-200"
                        }`}
                      >
                        {cnt} Cards
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Protocol Focus & Split Slides */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                    Protocol Focus (ICMP, Query, HTTP, TCP)
                  </p>
                  {(cfg.protocols.length > 0 || cfg.ipVersion !== "all") && (
                    <button
                      type="button"
                      onClick={() =>
                        updateConfig((prev) => ({
                          ...prev,
                          protocols: [],
                          ipVersion: "all",
                        }))
                      }
                      className="text-xs text-emerald-400 underline"
                    >
                      All Protocols
                    </button>
                  )}
                </div>

                <div className="space-y-2.5 rounded-md border border-border bg-canvas p-3">
                  <div className="grid grid-cols-2 gap-1.5">
                    {PROTOCOL_FAMILIES.map((meta) => {
                      const active = cfg.protocols.includes(meta.id);
                      const count = protocolCounts[meta.id] ?? 0;
                      return (
                        <button
                          key={meta.id}
                          type="button"
                          aria-pressed={active}
                          data-testid={`tv-drawer-proto-${meta.id}`}
                          onClick={() => toggleProtocolFilter(meta.id)}
                          className={`flex items-center justify-between rounded border px-2.5 py-1.5 text-xs font-mono ${
                            active
                              ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                              : "border-border bg-elevated text-zinc-200 hover:border-zinc-500"
                          }`}
                        >
                          <span>{meta.shortLabel}</span>
                          <span className={active ? "text-zinc-900" : "text-zinc-400"}>
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2">
                    <span className="text-[11px] font-mono text-zinc-400">IP Family</span>
                    <div className="inline-flex rounded border border-border bg-elevated p-0.5">
                      {(["all", "ipv4", "ipv6"] as const).map((ip) => (
                        <button
                          key={ip}
                          type="button"
                          aria-pressed={cfg.ipVersion === ip}
                          onClick={() =>
                            updateConfig((prev) => ({ ...prev, ipVersion: ip }))
                          }
                          className={`rounded px-2 py-0.5 text-[11px] font-mono uppercase ${
                            cfg.ipVersion === ip
                              ? "bg-cyan-500 font-semibold text-zinc-950"
                              : "text-zinc-300"
                          }`}
                        >
                          {ip}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-center justify-between gap-2 border-t border-border/70 pt-2 text-xs text-zinc-200">
                    <span>Separate slides by protocol</span>
                    <input
                      type="checkbox"
                      data-testid="tv-drawer-split-protocol"
                      checked={cfg.splitByProtocol}
                      onChange={(e) =>
                        updateConfig((prev) => ({
                          ...prev,
                          splitByProtocol: e.target.checked,
                        }))
                      }
                    />
                  </label>
                </div>
              </div>

              {/* Probe Display Mode & Probe Filter */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                    Probe Display &amp; Filter
                  </p>
                  {cfg.probes.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, probes: [] }))
                      }
                      className="text-xs text-emerald-400 underline"
                    >
                      Show All Probes
                    </button>
                  )}
                </div>
                <div className="space-y-2.5 rounded-md border border-border bg-canvas p-3">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(
                      [
                        { id: "per-probe", label: "Per-Probe Cards" },
                        { id: "per-target", label: "Per-Target (Focal)" },
                      ] as Array<{ id: TvProbeDisplayMode; label: string }>
                    ).map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        aria-pressed={cfg.probeDisplayMode === mode.id}
                        data-testid={`tv-drawer-probemode-${mode.id}`}
                        onClick={() =>
                          updateConfig((prev) => ({
                            ...prev,
                            probeDisplayMode: mode.id,
                          }))
                        }
                        className={`rounded border px-2.5 py-1.5 text-xs font-mono ${
                          cfg.probeDisplayMode === mode.id
                            ? "border-cyan-500 bg-cyan-500 font-semibold text-zinc-950"
                            : "border-border bg-elevated text-zinc-200"
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>

                  {cfg.probeDisplayMode === "per-probe" && (
                    <label className="flex items-center justify-between gap-2 border-t border-border/70 pt-2 text-xs text-zinc-200">
                      <span>Group cards/slides by probe</span>
                      <input
                        type="checkbox"
                        data-testid="tv-drawer-group-probe"
                        checked={cfg.groupByProbe}
                        onChange={(e) =>
                          updateConfig((prev) => ({
                            ...prev,
                            groupByProbe: e.target.checked,
                          }))
                        }
                      />
                    </label>
                  )}

                  <div className="max-h-32 overflow-y-auto space-y-1.5 border-t border-border/70 pt-2">
                    {(data?.probes ?? []).length === 0 ? (
                      <p className="text-xs text-zinc-400">No probes available.</p>
                    ) : (
                      (data?.probes ?? []).map((p) => (
                        <label
                          key={p.id}
                          className="flex items-center justify-between gap-2 text-xs text-zinc-200"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={cfg.probes.includes(p.id)}
                              onChange={() => toggleProbeFilter(p.id)}
                            />
                            <span className="truncate">{p.name}</span>
                          </span>
                          {p.location_label && (
                            <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                              {p.location_label}
                            </span>
                          )}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Group Filter */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                    Target Groups Filter
                  </p>
                  {cfg.groups.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, groups: [] }))
                      }
                      className="text-xs text-emerald-400 underline"
                    >
                      Show All Groups
                    </button>
                  )}
                </div>
                <div className="max-h-36 overflow-y-auto space-y-1.5 rounded-md border border-border bg-canvas p-3">
                  <label className="flex items-center justify-between gap-2 text-xs text-zinc-200">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        data-testid="tv-group-ungrouped"
                        checked={cfg.groups.includes(UNGROUPED_GROUP_TOKEN)}
                        onChange={() => toggleGroupFilter(UNGROUPED_GROUP_TOKEN)}
                      />
                      <span>Ungrouped / Custom Targets</span>
                    </span>
                    <span className="font-mono text-[11px] text-zinc-400">
                      {ungroupedCount}
                    </span>
                  </label>
                  {(data?.groups ?? []).length === 0 ? (
                    <p className="text-xs text-zinc-400">No named groups configured.</p>
                  ) : (
                    (data?.groups ?? []).map((g) => {
                      const checked = cfg.groups.includes(g.id);
                      return (
                        <label
                          key={g.id}
                          className="flex items-center gap-2 text-xs text-zinc-200"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleGroupFilter(g.id)}
                          />
                          <span>{g.name}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Spotlight & Auto-Switch Policy */}
              <div className="space-y-2.5 rounded-md border border-border bg-canvas p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Spotlight &amp; Auto-Switch
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: "off", label: "Off (Default)" },
                      { id: "vip", label: "VIP Only" },
                      { id: "all", label: "Alert / Warn" },
                    ] as Array<{ id: TvSpotlightMode; label: string }>
                  ).map((sm) => (
                    <button
                      key={sm.id}
                      type="button"
                      aria-pressed={cfg.spotlightMode === sm.id}
                      data-testid={`tv-drawer-spotlight-${sm.id}`}
                      onClick={() =>
                        updateConfig((prev) => ({
                          ...prev,
                          spotlightMode: sm.id,
                          autoSwitchSpotlight:
                            sm.id === "off" ? false : prev.autoSwitchSpotlight,
                        }))
                      }
                      className={`rounded border px-2 py-1.5 text-[11px] font-mono ${
                        cfg.spotlightMode === sm.id
                          ? "border-amber-500 bg-amber-500 font-semibold text-zinc-950"
                          : "border-border bg-elevated text-zinc-200"
                      }`}
                    >
                      {sm.label}
                    </button>
                  ))}
                </div>
                <label
                  className={`flex items-start justify-between gap-2 border-t border-border/70 pt-2 text-xs ${
                    cfg.spotlightMode === "off" ? "text-zinc-500" : "text-zinc-200"
                  }`}
                >
                  <div>
                    <span className="block">Auto-switch to Spotlight on loss/down</span>
                    <span className="block text-[10px] text-zinc-400">
                      Ignores minor latency spikes; in VIP Only mode, only pinned VIP targets jump.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    data-testid="tv-drawer-auto-switch"
                    disabled={cfg.spotlightMode === "off"}
                    checked={cfg.spotlightMode !== "off" && cfg.autoSwitchSpotlight}
                    onChange={(e) =>
                      updateConfig((prev) => ({
                        ...prev,
                        autoSwitchSpotlight: e.target.checked,
                      }))
                    }
                    className="mt-0.5"
                  />
                </label>
              </div>

              {/* Alert Audio Chime */}
              <div className="flex items-center justify-between rounded-md border border-border bg-canvas p-3">
                <label className="flex items-center gap-2 text-xs text-zinc-200">
                  <input
                    type="checkbox"
                    checked={cfg.sound}
                    onChange={(e) =>
                      updateConfig((prev) => ({ ...prev, sound: e.target.checked }), false)
                    }
                  />
                  <span>Play audio chime on new target outage</span>
                </label>
                <button
                  type="button"
                  onClick={playAlertChime}
                  className="rounded border border-border bg-elevated px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
                >
                  Test Chime
                </button>
              </div>

              {/* Test Highlight & Auto-Switch (30s Simulation — Admin only) */}
              {isAdmin && (
                <div
                  data-testid="tv-simulate-panel"
                  className="rounded-md border border-border bg-canvas p-3 space-y-2"
                >
                  <label
                    htmlFor="sim-target-select"
                    className="block text-xs font-semibold uppercase tracking-wider text-zinc-300"
                  >
                    Test Highlight &amp; Auto-Switch (30s Simulation)
                  </label>
                  <select
                    id="sim-target-select"
                    value={simTargetId}
                    onChange={(e) => setSimTargetId(e.target.value)}
                    className="w-full rounded border border-border bg-elevated px-2.5 py-1.5 text-xs text-zinc-100"
                  >
                    {(data?.targets ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.host})
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      disabled={simRunning}
                      data-testid="tv-simulate-spike-btn"
                      onClick={() => void handleSimulateAnomaly("high_latency")}
                      className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-1.5 text-[11px] font-semibold text-amber-300"
                    >
                      Spike RTT (30s)
                    </button>
                    <button
                      type="button"
                      disabled={simRunning}
                      data-testid="tv-simulate-loss-btn"
                      onClick={() => void handleSimulateAnomaly("intermittent_loss")}
                      className="rounded border border-rose-500/40 bg-rose-500/15 px-2 py-1.5 text-[11px] font-semibold text-rose-300"
                    >
                      Packet Loss (30s)
                    </button>
                    <button
                      type="button"
                      disabled={simRunning}
                      data-testid="tv-simulate-clear-btn"
                      onClick={() => void handleSimulateAnomaly("clear")}
                      className="rounded border border-border bg-elevated px-2 py-1.5 text-[11px] font-medium text-zinc-200"
                    >
                      Clear Sim
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Injects a 30s synthetic spike into the in-memory rolling cache to test the TV Spotlight slide and event-driven auto-switch.
                  </p>
                </div>
              )}

              {/* Persistent Kiosk URL */}
              <div>
                <label
                  htmlFor="kiosk-url-input"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-zinc-300"
                >
                  Reboot-Safe Kiosk URL
                </label>
                <div className="flex gap-2">
                  <input
                    id="kiosk-url-input"
                    type="text"
                    readOnly
                    value={kioskUrl}
                    className="w-full rounded border border-border bg-canvas px-2.5 py-1.5 text-xs font-mono text-zinc-200"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopyKioskUrl()}
                    className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Copy URL</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-zinc-400">
                  Bookmark or pass this URL to Chromium Kiosk (`--kiosk --app=...`) on your NOC TV. All settings persist in the URL query string.
                </p>
              </div>
            </div>

            {/* Pinned Non-Scrolling Footer */}
            <div className="flex shrink-0 items-center justify-end border-t border-border bg-surface px-5 py-3">
              <button
                type="button"
                data-testid="tv-config-ok-btn"
                onClick={() => setShowDrawer(false)}
                className="rounded-md bg-emerald-500 px-5 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <KeyboardShortcutsModal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </div>
  );
}

function partitionSummary(probesOnline: number, totalProbes: number, incidents: number): string {
  return `Probes ${probesOnline}/${totalProbes} · Incidents ${incidents}`;
}
