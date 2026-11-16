"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  Flame,
  LayoutGrid,
  Maximize2,
  Pause,
  Pin,
  Play,
  Radio,
  Search,
  Settings2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { SmokeChartPanel } from "@/components/charts/SmokeChartPanel";
import { TargetZoomModal } from "@/components/charts/TargetZoomModal";
import {
  DisplaySizeControls,
  LayoutPresetPills,
} from "@/components/layout/DisplaySizeControls";
import { ProtocolFilterChips } from "@/components/targets/ProtocolFilterChips";
import {
  apiRequest,
  type BatchSeriesResponse,
  type MatrixSnapshot,
  type ProbeSeries,
} from "@/lib/api";
import { formatDateTime24 } from "@/lib/date-format";
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
  groupSummariesByProbe,
  loadTvConfigFromStorage,
  MANUAL_CARD_OPTIONS,
  parseTvConfig,
  partitionTargetsForTv,
  resolveTvFlowMode,
  saveTvConfigToStorage,
  selectFocalProbeCell,
  serializeTvConfig,
  TV_RANGES,
  UNGROUPED_GROUP_TOKEN,
  type TargetHealthSummary,
  type TvGridLayout,
  type TvOrientation,
  type TvProbeDisplayMode,
  type TvRange,
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
  const focalSeries = focalCell
    ? mergeProbeSeriesWithCell(
        seriesMap.get(focalCell.probe_id),
        focalCell,
        focalProbeLabel,
        range
      )
    : null;

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
      {/* Compact Header (2 tight rows: Target + Status, Host + Multi-Probe Switcher) */}
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

          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-mono font-semibold leading-tight ${vis.badgeClass}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${vis.dotClass}`} />
            {vis.label}
          </span>
        </div>

        <div className="flex h-4 items-center justify-between gap-2 min-w-0 text-[11px]">
          <div className="flex items-center gap-1.5 min-w-0">
            {isPerProbeCard && (
              <span
                data-testid="tv-card-probe-badge"
                title={
                  item.focalProbeLocation
                    ? `${focalProbeLabel} · ${item.focalProbeLocation}`
                    : focalProbeLabel
                }
                className="inline-flex shrink-0 items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/15 px-1.5 py-0 text-[10px] font-mono font-semibold text-cyan-300"
              >
                <Radio className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                <span className="max-w-[115px] truncate">{focalProbeLabel}</span>
              </span>
            )}
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

      {/* Focal 7:3 SmokePing Chart Panel */}
      <div
        data-testid={isHighlight ? "tv-highlight-probe-row" : "tv-focal-probe-row"}
        className="flex shrink-0 flex-col overflow-hidden"
      >
        {!focalCell || !focalSeries ? (
          <button
            type="button"
            onClick={() => onZoomTarget(target.id)}
            data-testid="zoom-chart-btn"
            style={{ height: layout.panelHeight }}
            className="flex w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-canvas/50 px-2 text-center text-xs font-mono text-zinc-400 cursor-zoom-in transition-colors hover:border-emerald-500/40 hover:text-zinc-200"
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
        ) : (
          <SmokeChartPanel
            compact
            fillHeight
            fixedHeight={layout.panelHeight}
            syncKey={`tv-${isHighlight ? "hi" : "grid"}-${target.id}`}
            series={focalSeries}
            targetName={target.name}
            targetHost={target.host}
            rangeLabel={range}
            windowSec={rangeKeyToSeconds(range)}
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
          />
        )}
      </div>

      {/* Compact Footer */}
      <div className="flex h-[18px] shrink-0 items-center justify-between border-t border-border/50 pt-0.5 text-[10px] font-mono tabular-nums text-zinc-400">
        <span className="truncate">
          {isPerProbeCard
            ? `${focalProbeLabel}${item.focalProbeLocation ? ` · ${item.focalProbeLocation}` : ""} · Every ${target.interval_sec}s`
            : cells.length > 1
            ? `${cells.length} probes · Every ${target.interval_sec}s`
            : `Every ${target.interval_sec}s`}
        </span>
        <span className="shrink-0">
          Peak {formatMs(item.maxP95Ms)}
          {item.maxLossPct > 0 ? ` · Loss ${formatLoss(item.maxLossPct)}` : ""}
        </span>
      </div>
    </article>
  );
}

export default function NocTvWallboardPage() {
  const [cfg, setCfg] = useState<TvWallConfig>(DEFAULT_TV_CONFIG);
  const [urlHydrated, setUrlHydrated] = useState(false);
  const [data, setData] = useState<MatrixSnapshot | null>(null);
  const [seriesByRange, setSeriesByRange] = useState<
    Record<string, Record<string, ProbeSeries[]>>
  >({});
  const seriesByTarget = useMemo(
    () => seriesByRange[cfg.range] ?? {},
    [seriesByRange, cfg.range]
  );
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [countdown, setCountdown] = useState(DEFAULT_TV_CONFIG.rotateSec);
  const [paused, setPaused] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showLayoutBar, setShowLayoutBar] = useState(false);
  const [copied, setCopied] = useState(false);
  const [clockText, setClockText] = useState<string>("");
  const [simTargetId, setSimTargetId] = useState<string>("");
  const [simRunning, setSimRunning] = useState<boolean>(false);
  const [selectedProbeByTarget, setSelectedProbeByTarget] = useState<Record<string, string>>({});
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [impairedOnly, setImpairedOnly] = useState<boolean>(false);
  const [zoomTargetId, setZoomTargetId] = useState<string | null>(null);
  const [stageBox, setStageBox] = useState<{ width: number; height: number }>({
    width: 1900,
    height: 988,
  });

  const mainRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const prevImpairedIdsRef = useRef<Set<string>>(new Set());
  const hasSeededImpairedRef = useRef<boolean>(false);

  const handleOpenZoomTarget = useCallback((targetId: string) => {
    setZoomTargetId(targetId);
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
    const hasSearch = window.location.search.length > 1;
    const initial = hasSearch
      ? parseTvConfig(window.location.search)
      : loadTvConfigFromStorage() ?? DEFAULT_TV_CONFIG;
    setCfg(initial);
    setCountdown(initial.rotateSec);
    setUrlHydrated(true);
  }, []);

  // Sync config updates to URL query parameters and localStorage without triggering router navigation
  const updateConfig = useCallback(
    (updater: (prev: TvWallConfig) => TvWallConfig, resetPage = true) => {
      setCfg((prev) => {
        const next = updater(prev);
        if (typeof window !== "undefined") {
          const qs = serializeTvConfig(next);
          const nextUrl = `${window.location.pathname}?${qs}`;
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

  const loadTvMatrix = useCallback(async () => {
    try {
      setError(null);
      const snap = await apiRequest<MatrixSnapshot>("/api/tv/matrix");
      setData(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load NOC TV matrix");
    }
  }, []);

  useEffect(() => {
    void loadTvMatrix();
    const poll = setInterval(() => {
      void loadTvMatrix();
    }, 5000);
    return () => clearInterval(poll);
  }, [loadTvMatrix]);

  // Live 24h + date clock ticker
  useEffect(() => {
    const updateClock = () => {
      setClockText(formatDateTime24(new Date()));
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

  const wsState = useLiveSocket(["matrix"], handleLiveEvent, { scope: "tv" });

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

  // Event-Driven Auto-Switch + Audio Chime when a target newly enters an impaired state
  useEffect(() => {
    if (!data) return;
    const currentImpaired = new Set(
      partitioned.pinnedAlerts.map((a) => a.target.id)
    );
    if (!hasSeededImpairedRef.current) {
      hasSeededImpairedRef.current = true;
      prevImpairedIdsRef.current = currentImpaired;
      return;
    }

    let hasNewImpaired = false;
    for (const id of currentImpaired) {
      if (!prevImpairedIdsRef.current.has(id)) {
        hasNewImpaired = true;
        break;
      }
    }
    prevImpairedIdsRef.current = currentImpaired;

    if (hasNewImpaired) {
      if (cfg.sound) {
        playAlertChime();
      }
      if (
        cfg.rotateSec > 0 &&
        !paused &&
        partitioned.highlightSlideIdx !== null
      ) {
        setPageIdx(partitioned.highlightSlideIdx);
        setCountdown(cfg.rotateSec);
      }
    }
  }, [
    data,
    partitioned.pinnedAlerts,
    partitioned.highlightSlideIdx,
    cfg.sound,
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

  const loadVisibleSeries = useCallback(async () => {
    if (!urlHydrated || !visibleIdsKey) return;
    const requestedRange = cfg.range;
    try {
      const res = await apiRequest<BatchSeriesResponse>(
        `/api/tv/series?range=${requestedRange}&ids=${encodeURIComponent(visibleIdsKey)}`
      );
      setSeriesByRange((prev) => ({
        ...prev,
        [requestedRange]: {
          ...(prev[requestedRange] ?? {}),
          ...res.targets,
        },
      }));
    } catch {
      // Fall back gracefully to live rolling cache if batch series fetch temporarily fails
    }
  }, [urlHydrated, visibleIdsKey, cfg.range]);

  useEffect(() => {
    if (!urlHydrated || !visibleIdsKey) return;
    void loadVisibleSeries();
    const isLongRange =
      cfg.range === "12h" || cfg.range === "24h" || cfg.range === "7d";
    const intervalMs = isLongRange ? 60_000 : 15_000;
    const poll = setInterval(() => {
      void loadVisibleSeries();
    }, intervalMs);
    return () => clearInterval(poll);
  }, [urlHydrated, visibleIdsKey, cfg.range, loadVisibleSeries]);

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
      if (mode !== "clear" && nextPart.highlightSlideIdx !== null) {
        setPageIdx(nextPart.highlightSlideIdx);
        setCountdown(cfg.rotateSec);
        setShowDrawer(false);
      } else if (mode === "clear") {
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

  // Keyboard shortcuts: "/" opens Search & Protocol Filter bar, "Escape" closes bar or drawer
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") {
        if (zoomTargetId !== null) return;
        if (showSearch) {
          setShowSearch(false);
          return;
        }
        if (showLayoutBar) {
          setShowLayoutBar(false);
          return;
        }
        if (showDrawer) {
          setShowDrawer(false);
        }
      } else if (e.key === "/" && !inInput && !showDrawer && zoomTargetId === null) {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 30);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomTargetId, showSearch, showLayoutBar, showDrawer]);

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

  const kioskUrl = useMemo(() => {
    const qs = serializeTvConfig(cfg);
    if (typeof window === "undefined" || !urlHydrated) {
      return `/tv?${qs}`;
    }
    return `${window.location.origin}/tv?${qs}`;
  }, [cfg, urlHydrated]);

  async function handleCopyKioskUrl() {
    try {
      await navigator.clipboard.writeText(kioskUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function handleToggleFullscreen() {
    if (typeof document === "undefined") return;
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
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

  const isCustomLayoutActive =
    cfg.layoutMode !== DEFAULT_TV_CONFIG.layoutMode ||
    cfg.customCols !== DEFAULT_TV_CONFIG.customCols ||
    cfg.flowMode !== DEFAULT_TV_CONFIG.flowMode ||
    cfg.widthSpec !== DEFAULT_TV_CONFIG.widthSpec ||
    cfg.rowCardWidth !== DEFAULT_TV_CONFIG.rowCardWidth ||
    cfg.chartHeight !== DEFAULT_TV_CONFIG.chartHeight;

  const layoutBadgeText = useMemo(() => {
    if (cfg.layoutMode === "single-col") return "1-Col";
    if (cfg.layoutMode === "single-row") return "1-Row";
    if (cfg.layoutMode === "cols" && cfg.customCols > 0) return `${cfg.customCols}-Col`;
    return `${gridLayout.cols}-Col`;
  }, [cfg.layoutMode, cfg.customCols, gridLayout.cols]);

  return (
    <div
      data-testid="noc-tv-root"
      data-orientation={cfg.orientation}
      data-flow={effectiveFlow}
      data-layout={cfg.layoutMode}
      className="flex h-screen w-screen flex-col overflow-hidden bg-canvas text-zinc-100 select-none"
    >
      {/* Top TV Display Bar */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-1.5 xl:gap-2 border-b border-border bg-surface px-2.5 sm:px-3 xl:px-4 overflow-hidden">
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-400">
              <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <h1
              aria-label="Smoker TV Display"
              className="whitespace-nowrap text-xs xl:text-sm font-bold tracking-wider uppercase text-zinc-100"
            >
              <span className="hidden 2xl:inline">Smoker </span>
              <span>TV</span>
              <span className="hidden md:inline"> Display</span>
            </h1>
          </div>

          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] xl:text-[11px] font-mono uppercase ${
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

          <span className="hidden 2xl:inline-block rounded border border-border bg-elevated px-2 py-0.5 text-[11px] font-mono uppercase text-zinc-300">
            {cfg.orientation === "portrait" ? "Portrait 9:16" : "Landscape 16:9"}
          </span>
        </div>

        {/* Center KPIs & Graph Range Selector */}
        <div className="flex items-center gap-2 xl:gap-4 min-w-0 shrink">
          <div className="hidden 2xl:flex items-center gap-4 text-xs font-mono tabular-nums">
            <div>
              <span className="text-zinc-400 mr-1.5">PROBES</span>
              <span className="font-bold text-emerald-400">
                {kpis.probesOnline}/{kpis.totalProbes}
              </span>
            </div>
            <div>
              <span className="text-zinc-400 mr-1.5">HEALTHY</span>
              <span className="font-bold text-zinc-100">
                {kpis.healthyTargets}/{partitioned.totalFiltered}
              </span>
            </div>
            <div>
              <span className="text-zinc-400 mr-1.5">INCIDENTS</span>
              <span
                className={`font-bold ${
                  (data?.active_incidents ?? 0) > 0
                    ? "text-rose-400"
                    : "text-emerald-400"
                }`}
              >
                {data?.active_incidents ?? 0}
              </span>
            </div>
          </div>

          {/* TV Time Range Menu */}
          <div
            role="group"
            aria-label="TV Graph time range"
            data-testid="tv-range-selector"
            className="hidden lg:inline-flex items-center rounded border border-border bg-canvas/80 p-0.5"
          >
            {TV_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={cfg.range === r}
                onClick={() => updateConfig((prev) => ({ ...prev, range: r }), false)}
                className={`rounded px-1.5 xl:px-2 py-0.5 text-[10px] xl:text-[11px] font-mono font-medium transition-colors ${
                  cfg.range === r
                    ? "bg-emerald-500 text-zinc-950 font-semibold"
                    : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          {clockText && (
            <div className="hidden 2xl:block border-l border-border pl-3 text-xs font-mono tabular-nums text-zinc-300">
              {clockText}
            </div>
          )}
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-1 xl:gap-1.5 shrink-0">
          {partitioned.highlightItems.length > 0 && (
            <button
              type="button"
              data-testid="tv-spotlight-btn"
              onClick={() => {
                if (partitioned.highlightSlideIdx !== null) {
                  setPageIdx(partitioned.highlightSlideIdx);
                  setCountdown(cfg.rotateSec);
                }
              }}
              className={`inline-flex items-center gap-1 rounded border px-1.5 xl:px-2 py-1 text-[11px] xl:text-xs font-mono font-semibold ${
                activeSlide.kind === "highlight"
                  ? "border-amber-400 bg-amber-400 text-zinc-950"
                  : "border-amber-500/40 bg-amber-500/15 text-amber-300"
              }`}
            >
              <Flame className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="hidden xl:inline">SPOTLIGHT </span>(
                {partitioned.highlightItems.length})
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setPageIdx((p) => (p + 1) % totalSlides);
              setCountdown(cfg.rotateSec);
            }}
            aria-label="Next TV Display slide"
            className="flex items-center gap-1 rounded border border-border bg-elevated px-1.5 sm:px-2 xl:px-2.5 py-1 text-[11px] xl:text-xs font-mono tabular-nums text-zinc-200 hover:border-zinc-500"
          >
            <span>
              {effectiveFlow === "scroll" && activeSlide.kind !== "highlight"
                ? `SCROLL · ${partitioned.totalFiltered}`
                : `${activeSlide.label} · ${safeSlideIdx + 1}/${totalSlides}`}
            </span>
            {cfg.rotateSec > 0 && totalSlides > 1 && !paused && effectiveFlow === "slides" && (
              <span className="hidden sm:inline text-zinc-400">· {countdown}s</span>
            )}
          </button>

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
            className="hidden sm:inline-flex items-center justify-center rounded border border-border bg-elevated p-1.5 text-zinc-200 hover:border-zinc-500"
          >
            {cfg.rotateSec === 0 || paused ? (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            onClick={() => updateConfig((prev) => ({ ...prev, sound: !prev.sound }), false)}
            aria-label={cfg.sound ? "Mute alert chime" : "Enable alert chime"}
            className={`hidden md:inline-flex items-center justify-center rounded border p-1.5 ${
              cfg.sound
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-border bg-elevated text-zinc-300"
            }`}
          >
            {cfg.sound ? (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            data-testid="tv-probe-mode-btn"
            aria-pressed={cfg.probeDisplayMode === "per-probe"}
            title={
              cfg.probeDisplayMode === "per-probe"
                ? "Showing 1 graph card per Target × Probe (click for compact Per-Target)"
                : "Showing 1 focal graph per Target (click to split every probe)"
            }
            onClick={() =>
              updateConfig((prev) => ({
                ...prev,
                probeDisplayMode:
                  prev.probeDisplayMode === "per-probe" ? "per-target" : "per-probe",
              }))
            }
            className={`inline-flex items-center gap-1 rounded border px-1.5 xl:px-2 py-1 text-[11px] font-mono ${
              cfg.probeDisplayMode === "per-probe"
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-300"
                : "border-border bg-elevated text-zinc-200 hover:border-zinc-500"
            }`}
          >
            <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">
              {cfg.probeDisplayMode === "per-probe" ? "Per-Probe" : "Per-Target"}
            </span>
          </button>

          <button
            type="button"
            data-testid="tv-layout-toggle-btn"
            aria-label="Configure display layout, columns, and custom width"
            aria-expanded={showLayoutBar}
            aria-pressed={showLayoutBar || isCustomLayoutActive}
            onClick={() => setShowLayoutBar((prev) => !prev)}
            className={`inline-flex items-center gap-1 rounded border px-1.5 xl:px-2 py-1 text-[11px] font-mono ${
              showLayoutBar || isCustomLayoutActive
                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                : "border-border bg-elevated text-zinc-200 hover:border-zinc-500"
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">{layoutBadgeText}</span>
          </button>

          <button
            type="button"
            data-testid="tv-search-toggle-btn"
            aria-label="Search and filter by protocol or host"
            aria-pressed={
              showSearch ||
              Boolean(searchQuery) ||
              impairedOnly ||
              cfg.protocols.length > 0 ||
              cfg.ipVersion !== "all" ||
              cfg.splitByProtocol
            }
            title="Search, Protocol Focus & Filters (Shortcut: /)"
            onClick={() => {
              setShowSearch((prev) => {
                const next = !prev;
                if (next) {
                  setTimeout(() => searchInputRef.current?.focus(), 30);
                }
                return next;
              });
            }}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[11px] font-mono ${
              showSearch ||
              searchQuery ||
              impairedOnly ||
              cfg.protocols.length > 0 ||
              cfg.ipVersion !== "all" ||
              cfg.splitByProtocol
                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                : "border-border bg-elevated text-zinc-200 hover:border-zinc-500"
            }`}
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {cfg.protocols.length > 0 || cfg.ipVersion !== "all" || cfg.splitByProtocol ? (
              <span className="hidden lg:inline uppercase">
                {[
                  ...cfg.protocols,
                  cfg.ipVersion !== "all" ? cfg.ipVersion : null,
                  cfg.splitByProtocol ? "Split" : null,
                ]
                  .filter(Boolean)
                  .join("·")}
              </span>
            ) : (
              <span className="hidden xl:inline text-zinc-300">Filter</span>
            )}
          </button>

          <button
            type="button"
            onClick={handleToggleFullscreen}
            aria-label="Toggle fullscreen"
            className="hidden lg:inline-flex items-center justify-center rounded border border-border bg-elevated p-1.5 text-zinc-200 hover:border-zinc-500"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => setShowDrawer(true)}
            aria-label="Configure TV Display"
            className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 xl:px-2.5 py-1 text-[11px] xl:text-xs font-medium text-zinc-100 hover:border-emerald-500/50"
          >
            <Settings2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">
              Configure<span className="hidden xl:inline"> TV</span>
            </span>
          </button>

          <Link
            href="/"
            className="hidden md:inline-flex items-center rounded border border-border bg-elevated px-2 xl:px-2.5 py-1 text-[11px] xl:text-xs font-medium text-zinc-300 hover:text-zinc-100"
          >
            Dashboard
          </Link>
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

        {/* Collapsible Quick Layout, Columns & Custom Width/Height Bar */}
        {showLayoutBar && (
          <div
            data-testid="tv-layout-bar"
            className="shrink-0 rounded-md border border-border bg-surface/95 px-3 py-2.5 text-xs shadow-lg space-y-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <LayoutPresetPills
                  testIdPrefix="tv-layout"
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
                    className="inline-flex items-center gap-1 border-l border-border pl-2"
                  >
                    <span className="font-mono text-[10px] text-zinc-400">Row Cols:</span>
                    {[0, 2, 3, 4].map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        aria-pressed={cfg.customCols === cnt}
                        data-testid={`tv-layout-rowcols-${cnt}`}
                        onClick={() =>
                          updateConfig((prev) => ({ ...prev, customCols: cnt }))
                        }
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
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

                <div
                  role="group"
                  aria-label="Orientation"
                  className="inline-flex items-center rounded border border-border bg-elevated p-0.5"
                >
                  {(["landscape", "portrait"] as TvOrientation[]).map((ori) => (
                    <button
                      key={ori}
                      type="button"
                      aria-pressed={cfg.orientation === ori}
                      data-testid={`tv-layout-ori-${ori}`}
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, orientation: ori }))
                      }
                      className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase ${
                        cfg.orientation === ori
                          ? "bg-emerald-500 font-semibold text-zinc-950"
                          : "text-zinc-300 hover:text-zinc-100"
                      }`}
                    >
                      {ori}
                    </button>
                  ))}
                </div>

                <div
                  role="group"
                  aria-label="Flow mode"
                  className="inline-flex items-center rounded border border-border bg-elevated p-0.5"
                >
                  {(
                    [
                      { id: "auto", label: `Auto (${effectiveFlow})` },
                      { id: "scroll", label: "Scroll ↓" },
                      { id: "slides", label: "Slides" },
                    ] as Array<{ id: FlowMode; label: string }>
                  ).map((fm) => (
                    <button
                      key={fm.id}
                      type="button"
                      aria-pressed={cfg.flowMode === fm.id}
                      data-testid={`tv-layout-flow-${fm.id}`}
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, flowMode: fm.id }))
                      }
                      className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                        cfg.flowMode === fm.id
                          ? "bg-cyan-500 font-semibold text-zinc-950"
                          : "text-zinc-300 hover:text-zinc-100"
                      }`}
                    >
                      {fm.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                aria-label="Close layout bar"
                onClick={() => setShowLayoutBar(false)}
                className="rounded p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1 lg:hidden border-t border-border/60 pt-2">
              <span className="mr-1 font-mono text-[10px] uppercase text-zinc-400">
                Range:
              </span>
              {TV_RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={cfg.range === r}
                  onClick={() => updateConfig((prev) => ({ ...prev, range: r }), false)}
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                    cfg.range === r
                      ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                      : "border-border bg-elevated text-zinc-300"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>

            <div className="border-t border-border/60 pt-2">
              <DisplaySizeControls
                testIdPrefix="tv-layout"
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
                  Multi-Probe Highlight &amp; Anomaly Spotlight ({activeSlide.items.length} Hosts · {cfg.range})
                </span>
              </div>
              <span className="hidden xl:inline shrink-0 font-mono text-[11px] text-zinc-200">
                Auto-switches on high latency / loss · Click probe chips to compare paths
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
          {cfg.widthSpec !== "full" ? ` · ${cfg.widthSpec}` : ""} · {cfg.range} ·{" "}
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
            fallbackSeries={seriesByTarget[zTarget.id] ?? []}
            onClose={() => setZoomTargetId(null)}
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
              {/* Graph Time Range */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Graph History Window
                </p>
                <div className="grid grid-cols-4 gap-1.5">
                  {TV_RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={cfg.range === r}
                      onClick={() =>
                        updateConfig((prev) => ({ ...prev, range: r }), false)
                      }
                      className={`rounded border px-2 py-1.5 text-xs font-mono ${
                        cfg.range === r
                          ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                          : "border-border bg-elevated text-zinc-200"
                      }`}
                    >
                      {r}
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

              {/* Test Highlight & Auto-Switch (30s Simulation) */}
              <div className="rounded-md border border-border bg-canvas p-3 space-y-2">
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
    </div>
  );
}

function partitionSummary(probesOnline: number, totalProbes: number, incidents: number): string {
  return `Probes ${probesOnline}/${totalProbes} · Incidents ${incidents}`;
}
