"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  Camera,
  Check,
  Crosshair,
  Download,
  LayoutGrid,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCrash,
  SlidersHorizontal,
  Table2,
} from "lucide-react";
import { MiniSparkline } from "@/components/charts/MiniSparkline";
import {
  SmokeChartPanel,
  type ExportButtonState,
  type SmokeChartPanelHandle,
} from "@/components/charts/SmokeChartPanel";
import { TargetZoomModal } from "@/components/charts/TargetZoomModal";
import {
  DisplaySizeControls,
  LayoutPresetPills,
} from "@/components/layout/DisplaySizeControls";
import { NocShell } from "@/components/layout/NocShell";
import { ProtocolFilterChips } from "@/components/targets/ProtocolFilterChips";
import {
  ApiError,
  apiRequest,
  type MatrixCell,
  type MatrixSnapshot,
  type Probe,
  type Target,
} from "@/lib/api";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  isDefaultDashboardLayout,
  loadDashboardLayout,
  resolveDashboardGrid,
  saveDashboardLayout,
  type DashboardLayoutConfig,
} from "@/lib/display-layout";
import { saveEvidenceBrandName } from "@/lib/export-chart-png";
import {
  formatCleanTargetTitle,
  getProtocolFamily,
  getProtocolFamilyMeta,
  groupItemsByProtocol,
  groupItemsByTargetGroup,
  matchesProtocolAndIpFilter,
  type GroupByMode,
  type IpFamilyFilter,
  type ProtocolFamily,
} from "@/lib/protocol-filters";
import {
  appendSparkPoint,
  formatLoss,
  formatMs,
  resolveEffectiveWarnMs,
  sparklineToProbeSeries,
  statusVisuals,
  type CellStatus,
} from "@/lib/smoke-math";
import { selectFocalProbeCell } from "@/lib/tv-config";
import { useLiveSocket, type LiveEventMessage } from "@/lib/useLiveSocket";

export type DashboardGroupBy = GroupByMode | "probe";

interface DashboardGridTargetCardProps {
  target: Target;
  assignedCells: Array<{ probe: Probe; cell: MatrixCell }>;
  groupLabel?: string;
  probeGridClass: string;
  fixedChartHeight?: number;
  rowCardStyle?: React.CSSProperties;
  onZoomClick: () => void;
}

function DashboardGridTargetCard({
  target: t,
  assignedCells,
  groupLabel,
  probeGridClass,
  fixedChartHeight,
  rowCardStyle,
  onZoomClick,
}: DashboardGridTargetCardProps) {
  const primaryChartRef = useRef<SmokeChartPanelHandle | null>(null);
  const [isChartZoomed, setIsChartZoomed] = useState(false);
  const [exportState, setExportState] = useState<ExportButtonState>("idle");

  const focalCell = selectFocalProbeCell(assignedCells.map((item) => item.cell));
  const worstStatus = (focalCell?.status as CellStatus) ?? "unknown";
  const vis = statusVisuals(worstStatus);
  const hasChartData = assignedCells.some((item) => item.cell.sparkline.length > 0);

  return (
    <article
      data-testid="grid-target-card"
      style={rowCardStyle}
      className="rounded-lg border border-border bg-surface p-3.5 space-y-2.5 flex flex-col justify-between"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/targets/${t.id}`}
              className="truncate text-sm font-semibold text-zinc-100 hover:text-emerald-400 transition-colors"
            >
              {formatCleanTargetTitle(t.name, t.probe_type)}
            </Link>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase ${
                getProtocolFamilyMeta(t.probe_type).badgeClass
              }`}
            >
              {t.probe_type}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs font-mono text-zinc-400">
            {t.host}
            {groupLabel ? ` · ${groupLabel}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {isChartZoomed && (
            <button
              type="button"
              onClick={() => primaryChartRef.current?.resetZoom()}
              data-testid="reset-zoom-btn"
              title="Reset time zoom to full window"
              aria-label="Reset zoom"
              className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-1 text-[10px] font-mono font-semibold text-amber-300 transition-colors hover:bg-amber-500/25"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            onClick={onZoomClick}
            data-testid="zoom-chart-btn"
            title="Zoom & inspect target graph"
            aria-label="Zoom graph"
            className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-1 text-[11px] font-mono text-zinc-200 hover:border-emerald-500/60 hover:text-emerald-300"
          >
            <Maximize2 className="h-3 w-3" aria-hidden="true" />
          </button>

          {hasChartData && (
            <button
              type="button"
              onClick={() => void primaryChartRef.current?.exportPng()}
              data-testid="copy-chart-png-btn"
              title="Copy evidence graph as PNG to clipboard"
              aria-label="Copy graph as PNG"
              className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-1 text-[11px] font-mono text-zinc-200 hover:border-cyan-500/60 hover:text-cyan-300"
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

          <Link
            href={`/targets?edit=${t.id}`}
            className="rounded border border-border bg-elevated px-2 py-1 text-[11px] font-medium text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Edit
          </Link>
          <Link
            href={`/targets/${t.id}`}
            className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-1 text-[11px] font-medium text-emerald-400 hover:border-emerald-500/60"
          >
            <span>Inspect</span>
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>

          <span
            data-testid="grid-card-status-badge"
            className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-mono font-semibold leading-tight ${vis.badgeClass}`}
          >
            {vis.label}
          </span>
        </div>
      </div>

      {assignedCells.length === 0 ? (
        <button
          type="button"
          onClick={onZoomClick}
          className="flex w-full items-center justify-center gap-2 rounded border border-dashed border-border p-4 text-center text-xs font-mono text-zinc-400 cursor-zoom-in hover:border-emerald-500/50 hover:text-zinc-200"
        >
          <Maximize2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
          <span>Waiting for probe telemetry (Click to open Zoom &amp; MTR)</span>
        </button>
      ) : (
        <div className={probeGridClass}>
          {assignedCells.map(({ probe, cell }, idx) => {
            const cellSeries = sparklineToProbeSeries(
              probe.id,
              probe.name,
              probe.location_label || "",
              cell.sparkline,
              cell.jitter_ms,
              cell.warn_ms ?? null,
              cell.baseline_ms ?? null
            );
            return (
              <SmokeChartPanel
                key={`${t.id}:${probe.id}`}
                ref={idx === 0 ? primaryChartRef : undefined}
                compact
                hideActions
                fixedHeight={fixedChartHeight}
                syncKey="matrix-grid"
                targetName={t.name}
                targetHost={t.host}
                rangeLabel="15m Live"
                intervalSec={t.interval_sec}
                baselineMs={cell.baseline_ms ?? null}
                warnMs={resolveEffectiveWarnMs({
                  cellWarnMs: cell.warn_ms,
                  target: t,
                  probeId: probe.id,
                  series: cellSeries,
                })}
                showThresholdMeta={false}
                series={cellSeries}
                onZoomClick={onZoomClick}
                onZoomStateChange={idx === 0 ? setIsChartZoomed : undefined}
                onExportStateChange={idx === 0 ? setExportState : undefined}
              />
            );
          })}
        </div>
      )}
    </article>
  );
}

export default function MatrixWallPage() {
  const router = useRouter();
  const [data, setData] = useState<MatrixSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [probeFilter, setProbeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedProtocols, setSelectedProtocols] = useState<ProtocolFamily[]>([]);
  const [ipVersion, setIpVersion] = useState<IpFamilyFilter>("all");
  const [groupBy, setGroupBy] = useState<DashboardGroupBy>("protocol");
  const [viewMode, setViewMode] = useState<"matrix" | "grid">("matrix");
  const [zoomTargetId, setZoomTargetId] = useState<string | null>(null);
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayoutConfig>(
    DEFAULT_DASHBOARD_LAYOUT
  );
  const [showLayoutCustomizer, setShowLayoutCustomizer] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const handledZoomQueryRef = useRef(false);

  useEffect(() => {
    setDashboardLayout(loadDashboardLayout());
  }, []);

  useEffect(() => {
    if (handledZoomQueryRef.current || !data || typeof window === "undefined") return;
    const zId = new URLSearchParams(window.location.search).get("zoom");
    handledZoomQueryRef.current = true;
    if (zId && data.targets.some((t) => t.id === zId)) {
      setZoomTargetId(zId);
    }
  }, [data]);

  const handleCloseZoom = useCallback(() => {
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (zoomTargetId !== null) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const isCtrlF = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
      if (isCtrlF || (e.key === "/" && !inInput)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === "Escape" && document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomTargetId]);

  const updateDashboardLayout = useCallback(
    (updater: (prev: DashboardLayoutConfig) => DashboardLayoutConfig) => {
      setDashboardLayout((prev) => {
        const next = updater(prev);
        saveDashboardLayout(next);
        return next;
      });
    },
    []
  );

  const resolvedGrid = useMemo(
    () => resolveDashboardGrid(dashboardLayout),
    [dashboardLayout]
  );

  const loadMatrix = useCallback(async () => {
    try {
      setError(null);
      const snap = await apiRequest<MatrixSnapshot>("/api/matrix");
      if (snap.brand_name !== undefined) {
        saveEvidenceBrandName(snap.brand_name);
      }
      setData(snap);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const qs = typeof window !== "undefined" ? window.location.search : "";
        router.replace(qs ? `/login?next=${encodeURIComponent(`/${qs}`)}` : "/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load matrix");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadMatrix();
    const poll = setInterval(() => {
      void loadMatrix();
    }, 5000);
    return () => clearInterval(poll);
  }, [loadMatrix]);

  const handleLiveEvent = useCallback(
    (ev: LiveEventMessage) => {
      if (ev.type === "probe_status" || ev.type === "incident_update") {
        void loadMatrix();
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
          const nextProbes = prev.probes.map((p) =>
            p.id === probeId
              ? {
                  ...p,
                  status: (payload.status ?? p.status) as typeof p.status,
                  pending_backlog_count:
                    payload.backlog_count ?? p.pending_backlog_count,
                }
              : p
          );
          const sampleMap = new Map(
            samples.map((s) => [s.target_id, s])
          );
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
          return { ...prev, probes: nextProbes, cells: nextCells };
        });
      }
    },
    [loadMatrix]
  );

  const wsState = useLiveSocket(["matrix"], handleLiveEvent);

  const cellIndex = useMemo(() => {
    const map = new Map<string, MatrixCell>();
    if (!data) return map;
    for (const c of data.cells) {
      map.set(`${c.target_id}:${c.probe_id}`, c);
    }
    return map;
  }, [data]);

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

  const toggleProtocol = useCallback((proto: ProtocolFamily) => {
    setSelectedProtocols((prev) =>
      prev.includes(proto) ? prev.filter((p) => p !== proto) : [...prev, proto]
    );
  }, []);

  const protocolCounts = useMemo(() => {
    const counts: Partial<Record<ProtocolFamily, number>> = {};
    if (!data) return counts;
    for (const t of data.targets) {
      if (groupFilter !== "all" && (t.group_id ?? "ungrouped") !== groupFilter) {
        continue;
      }
      const fam = getProtocolFamily(t.probe_type);
      counts[fam] = (counts[fam] ?? 0) + 1;
    }
    return counts;
  }, [data, groupFilter]);

  const visibleProbes = useMemo(() => {
    if (!data) return [];
    if (probeFilter === "all") return data.probes;
    return data.probes.filter((p) => p.id === probeFilter);
  }, [data, probeFilter]);

  const filteredTargets = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.targets.filter((t) => {
      if (groupFilter !== "all" && (t.group_id ?? "ungrouped") !== groupFilter) {
        return false;
      }
      if (
        probeFilter !== "all" &&
        !t.assign_all_probes &&
        !t.probe_ids.includes(probeFilter)
      ) {
        return false;
      }
      if (!matchesProtocolAndIpFilter(t, selectedProtocols, ipVersion)) {
        return false;
      }
      if (
        q &&
        !t.name.toLowerCase().includes(q) &&
        !t.host.toLowerCase().includes(q) &&
        !t.probe_type.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (statusFilter !== "all") {
        const checkProbes = probeFilter === "all" ? data.probes : visibleProbes;
        const hasStatus = checkProbes.some((p) => {
          const cell = cellIndex.get(`${t.id}:${p.id}`);
          return cell?.status === statusFilter;
        });
        if (!hasStatus) return false;
      }
      return true;
    });
  }, [
    data,
    search,
    groupFilter,
    probeFilter,
    visibleProbes,
    statusFilter,
    selectedProtocols,
    ipVersion,
    cellIndex,
  ]);

  const targetSections = useMemo((): Array<{
    key: string;
    probeId?: string;
    title: string;
    subtitle?: string;
    badgeClass?: string;
    targets: Target[];
  }> => {
    if (groupBy === "probe") {
      const sections: Array<{
        key: string;
        probeId?: string;
        title: string;
        subtitle?: string;
        badgeClass?: string;
        targets: Target[];
      }> = [];
      for (const p of visibleProbes) {
        const probeTargets = filteredTargets.filter(
          (t) => t.assign_all_probes || t.probe_ids.includes(p.id)
        );
        if (probeTargets.length > 0) {
          sections.push({
            key: `probe:${p.id}`,
            probeId: p.id,
            title: p.name,
            subtitle: [p.location_label, p.isp_asn].filter(Boolean).join(" · ") || undefined,
            badgeClass: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300",
            targets: probeTargets,
          });
        }
      }
      return sections;
    }
    if (groupBy === "protocol") {
      return groupItemsByProtocol(filteredTargets, (t) => t).map((sec) => ({
        key: `proto:${sec.family.id}`,
        title: sec.family.label,
        subtitle: sec.family.description,
        badgeClass: sec.family.badgeClass,
        targets: sec.items,
      }));
    }
    if (groupBy === "group") {
      return groupItemsByTargetGroup(filteredTargets, (t) => t, data?.groups ?? []).map(
        (sec) => ({
          key: `grp:${sec.id}`,
          title: sec.label,
          subtitle: sec.description,
          badgeClass: "border-border bg-elevated text-zinc-200",
          targets: sec.items,
        })
      );
    }
    return [
      {
        key: "all",
        title: "",
        subtitle: undefined,
        badgeClass: undefined,
        targets: filteredTargets,
      },
    ];
  }, [filteredTargets, groupBy, data?.groups, visibleProbes]);

  const kpis = useMemo(() => {
    if (!data) {
      return { online: 0, totalProbes: 0, backlog: 0, incidents: 0, targets: 0 };
    }
    let online = 0;
    let backlog = 0;
    for (const p of data.probes) {
      if (p.status !== "offline") online++;
      backlog += p.pending_backlog_count;
    }
    return {
      online,
      totalProbes: data.probes.length,
      backlog,
      incidents: data.active_incidents,
      targets: data.targets.length,
    };
  }, [data]);

  return (
    <NocShell
      wsState={wsState}
      activeIncidents={kpis.incidents}
      mainMaxWidth={viewMode === "grid" ? resolvedGrid.containerMaxWidth : null}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-50">
              NOC Dashboard
            </h1>
            <p className="text-xs text-zinc-400">
              Real-time multi-vantage latency &amp; loss grid — column red indicates probe/Metro uplink issue; row red indicates target outage.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Dashboard view mode"
              className="inline-flex rounded-md border border-border bg-surface p-0.5"
            >
              <button
                type="button"
                aria-pressed={viewMode === "matrix"}
                onClick={() => setViewMode("matrix")}
                className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
                  viewMode === "matrix"
                    ? "bg-emerald-500 font-semibold text-zinc-950"
                    : "font-medium text-zinc-300 hover:text-zinc-100"
                }`}
              >
                <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Matrix</span>
              </button>
              <button
                type="button"
                aria-pressed={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
                className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
                  viewMode === "grid"
                    ? "bg-emerald-500 font-semibold text-zinc-950"
                    : "font-medium text-zinc-300 hover:text-zinc-100"
                }`}
              >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Charts Grid</span>
              </button>
            </div>
            <Link
              href="/targets"
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 transition-colors"
            >
              + Manage Targets
            </Link>
            <button
              type="button"
              onClick={() => void loadMatrix()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-600"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* KPI Strip */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-zinc-400">Probes Online</p>
            <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-400">
              {kpis.online}
              <span className="text-sm text-zinc-400">/{kpis.totalProbes}</span>
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-zinc-400">Backfill Queue (WAL)</p>
            <p
              className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
                kpis.backlog > 0 ? "text-cyan-400" : "text-zinc-100"
              }`}
            >
              {kpis.backlog.toLocaleString()}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-zinc-400">Active Quorum Incidents</p>
            <p
              className={`mt-1 text-2xl font-bold font-mono tabular-nums ${
                kpis.incidents > 0 ? "text-rose-400" : "text-zinc-100"
              }`}
            >
              {kpis.incidents}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-zinc-400">Targets Monitored</p>
            <p className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-100">
              {kpis.targets}
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="space-y-2.5 rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500"
                aria-hidden="true"
              />
              <input
                ref={searchInputRef}
                type="search"
                placeholder="Search target name, protocol, or IP/host... (Ctrl+F)"
                aria-label="Search targets"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-md border border-border bg-canvas pl-9 pr-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <select
              aria-label="Filter by group"
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="rounded-md border border-border bg-canvas px-3 py-1.5 text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="all">All Groups</option>
              <option value="ungrouped">Ungrouped</option>
              {data?.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by probe"
              data-testid="dash-probe-filter"
              value={probeFilter}
              onChange={(e) => setProbeFilter(e.target.value)}
              className="rounded-md border border-border bg-canvas px-3 py-1.5 text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="all">All Probes</option>
              {data?.probes.map((p) => (
                <option key={p.id} value={p.id}>
                  Probe: {p.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border border-border bg-canvas px-3 py-1.5 text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="healthy">Healthy</option>
              <option value="degraded">Degraded</option>
              <option value="loss">Packet Loss</option>
              <option value="down">Down</option>
            </select>

            <div
              role="group"
              aria-label="Group rows by"
              className="inline-flex rounded-md border border-border bg-canvas p-0.5 text-xs"
            >
              {(
                [
                  { id: "protocol", label: "By Protocol" },
                  { id: "group", label: "By Group" },
                  { id: "probe", label: "By Probe" },
                  { id: "none", label: "Flat" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  data-testid={`dash-groupby-${opt.id}`}
                  aria-pressed={groupBy === opt.id}
                  onClick={() => setGroupBy(opt.id)}
                  className={`rounded px-2.5 py-1 font-mono transition-colors ${
                    groupBy === opt.id
                      ? "bg-emerald-500 font-semibold text-zinc-950"
                      : "text-zinc-300 hover:text-zinc-100"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
            <ProtocolFilterChips
              testIdPrefix="dash-proto"
              selectedProtocols={selectedProtocols}
              onToggleProtocol={toggleProtocol}
              onClearProtocols={() => setSelectedProtocols([])}
              ipVersion={ipVersion}
              onChangeIpVersion={setIpVersion}
              protocolCounts={protocolCounts}
            />
            <span className="text-xs font-mono text-zinc-400">
              Showing {filteredTargets.length} of {data?.targets.length ?? 0} targets
            </span>
          </div>
        </div>

        {/* 5 UI States */}
        {loading ? (
          <div className="space-y-3" aria-label="Loading matrix">
            {[1, 2, 3, 4].map((row) => (
              <div
                key={row}
                className="h-14 animate-pulse rounded-lg border border-border bg-surface"
              />
            ))}
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col items-center justify-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-8 text-center"
          >
            <ServerCrash className="h-8 w-8 text-rose-400" aria-hidden="true" />
            <p className="text-sm text-rose-200">{error}</p>
            <button
              type="button"
              onClick={() => void loadMatrix()}
              className="rounded-md border border-rose-500/40 bg-rose-500/20 px-4 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
            >
              Retry
            </button>
          </div>
        ) : !data || data.targets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface p-12 text-center">
            <Crosshair className="h-9 w-9 text-zinc-500" aria-hidden="true" />
            <h2 className="text-base font-semibold text-zinc-100">
              No Monitoring Targets Configured
            </h2>
            <p className="max-w-md text-xs text-zinc-400">
              Add your first ICMP, TCP, HTTP, or DNS target in the GUI. Smoker will push it live to all connected probes via WebSocket.
            </p>
            <Link
              href="/targets"
              className="mt-1 rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
            >
              + Add First Target
            </Link>
          </div>
        ) : filteredTargets.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-zinc-400">
            No targets match the current search or filter criteria.
          </div>
        ) : viewMode === "grid" ? (
          <div className="space-y-4">
            {/* Compact Grid Layout & Small-Monitor Readability Toolbar */}
            <div
              data-testid="dash-layout-bar"
              className="rounded-lg border border-border bg-surface/90 p-3 space-y-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-zinc-400">
                    Layout
                  </span>
                  <LayoutPresetPills
                    testIdPrefix="dash-layout"
                    preset={dashboardLayout.preset}
                    customCols={dashboardLayout.customCols}
                    onSelectPreset={(preset, cols) =>
                      updateDashboardLayout((prev) => ({
                        ...prev,
                        preset,
                        customCols: cols ?? prev.customCols,
                      }))
                    }
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="dash-probe-layout-btn"
                    aria-pressed={dashboardLayout.probeLayout === "single"}
                    onClick={() =>
                      updateDashboardLayout((prev) => ({
                        ...prev,
                        probeLayout: prev.probeLayout === "single" ? "auto" : "single",
                      }))
                    }
                    className={`rounded border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                      dashboardLayout.probeLayout === "single"
                        ? "border-cyan-500 bg-cyan-500 font-semibold text-zinc-950"
                        : "border-border bg-elevated text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                    }`}
                  >
                    1 Probe / Row
                  </button>

                  <button
                    type="button"
                    data-testid="dash-layout-customize-btn"
                    aria-expanded={showLayoutCustomizer}
                    onClick={() => setShowLayoutCustomizer((prev) => !prev)}
                    className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                      showLayoutCustomizer || !isDefaultDashboardLayout(dashboardLayout)
                        ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300"
                        : "border-border bg-elevated text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                    }`}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      Width &amp; Height
                      {dashboardLayout.widthSpec !== "auto" || dashboardLayout.chartHeight > 0
                        ? ` (${
                            dashboardLayout.widthSpec === "full"
                              ? "100%"
                              : dashboardLayout.widthSpec
                          }${
                            dashboardLayout.chartHeight > 0
                              ? ` · ${dashboardLayout.chartHeight}px`
                              : ""
                          })`
                        : ""}
                    </span>
                  </button>
                </div>
              </div>

              {showLayoutCustomizer && (
                <div className="border-t border-border/60 pt-2.5">
                  <DisplaySizeControls
                    testIdPrefix="dash-layout"
                    widthSpec={dashboardLayout.widthSpec}
                    onChangeWidthSpec={(widthSpec) =>
                      updateDashboardLayout((prev) => ({ ...prev, widthSpec }))
                    }
                    allowAutoWidth
                    showRowCardWidth={dashboardLayout.preset === "single-row"}
                    rowCardWidth={dashboardLayout.rowCardWidth}
                    onChangeRowCardWidth={(rowCardWidth) =>
                      updateDashboardLayout((prev) => ({ ...prev, rowCardWidth }))
                    }
                    chartHeight={dashboardLayout.chartHeight}
                    onChangeChartHeight={(chartHeight) =>
                      updateDashboardLayout((prev) => ({ ...prev, chartHeight }))
                    }
                    compact
                    onReset={() =>
                      updateDashboardLayout(() => ({ ...DEFAULT_DASHBOARD_LAYOUT }))
                    }
                  />
                </div>
              )}
            </div>

            <div className="space-y-6">
              {targetSections.map((section) => (
                <section key={section.key} className="space-y-3">
                  {section.title && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 pb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded border px-2 py-0.5 text-xs font-mono font-semibold ${
                            section.badgeClass ?? "border-border bg-elevated text-zinc-200"
                          }`}
                        >
                          {section.title}
                        </span>
                        {section.subtitle && (
                          <span className="hidden sm:inline text-xs text-zinc-400">
                            {section.subtitle}
                          </span>
                        )}
                      </div>
                      <span className="text-xs font-mono text-zinc-400">
                        {section.targets.length} target{section.targets.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  )}

                  <div
                    data-testid="dash-section-grid"
                    data-layout-preset={dashboardLayout.preset}
                    style={resolvedGrid.gridStyle}
                    className={resolvedGrid.gridClassName}
                  >
                    {section.targets.map((t: Target) => {
                      const sectionProbes = section.probeId
                        ? visibleProbes.filter((p) => p.id === section.probeId)
                        : visibleProbes;
                      const assignedCells = sectionProbes
                        .map((p) => ({ probe: p, cell: cellIndex.get(`${t.id}:${p.id}`) }))
                        .filter((item): item is { probe: typeof item.probe; cell: MatrixCell } =>
                          Boolean(item.cell)
                        );
                      const probeGridClass =
                        assignedCells.length <= 1 || dashboardLayout.probeLayout === "single"
                          ? "grid grid-cols-1 gap-2.5"
                          : "grid grid-cols-1 gap-2.5 sm:grid-cols-2";
                      return (
                        <DashboardGridTargetCard
                          key={`${section.key}:${t.id}`}
                          target={t}
                          assignedCells={assignedCells}
                          groupLabel={
                            groupBy !== "group" && t.group_id && groupMap.get(t.group_id)
                              ? groupMap.get(t.group_id)
                              : undefined
                          }
                          probeGridClass={probeGridClass}
                          fixedChartHeight={
                            dashboardLayout.chartHeight > 0
                              ? dashboardLayout.chartHeight
                              : dashboardLayout.preset === "single-row"
                              ? 280
                              : dashboardLayout.preset === "single-col"
                              ? 200
                              : undefined
                          }
                          rowCardStyle={
                            resolvedGrid.isRowStrip ? resolvedGrid.rowCardStyle : undefined
                          }
                          onZoomClick={() => setZoomTargetId(t.id)}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-elevated/60 text-xs">
                  <th className="sticky left-0 z-10 min-w-[230px] bg-elevated px-4 py-3 font-semibold text-zinc-300">
                    Target / Host
                  </th>
                  {visibleProbes.map((p) => (
                    <th
                      key={p.id}
                      className="min-w-[160px] border-l border-border px-3 py-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-semibold text-zinc-100">
                          {p.name}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono uppercase ${
                            p.status === "offline"
                              ? "bg-rose-500/20 text-rose-300"
                              : p.status === "syncing" || p.status === "buffering"
                              ? "bg-cyan-500/20 text-cyan-300"
                              : "bg-emerald-500/15 text-emerald-400"
                          }`}
                        >
                          {p.status}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between text-[11px] font-mono text-zinc-400">
                        <span className="truncate">{p.location_label || "—"}</span>
                        {p.pending_backlog_count > 0 && (
                          <span className="text-cyan-400">
                            +{p.pending_backlog_count}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {targetSections.map((section) => (
                  <React.Fragment key={section.key}>
                    {section.title && (
                      <tr className="bg-elevated/45">
                        <td
                          colSpan={1 + visibleProbes.length}
                          className="border-y border-border/80 px-4 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span
                                className={`rounded border px-2 py-0.5 text-[11px] font-mono font-semibold ${
                                  section.badgeClass ?? "border-border bg-surface text-zinc-200"
                                }`}
                              >
                                {section.title}
                              </span>
                              {section.subtitle && (
                                <span className="hidden sm:inline text-xs text-zinc-400">
                                  {section.subtitle}
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] font-mono text-zinc-400">
                              {section.targets.length} target
                              {section.targets.length === 1 ? "" : "s"}
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                    {section.targets.map((t) => (
                      <tr key={`${section.key}:${t.id}`} className="hover:bg-elevated/30">
                        <td className="sticky left-0 z-10 bg-surface px-4 py-3 border-r border-border">
                          <div className="flex items-start justify-between gap-2">
                            <Link
                              href={`/targets/${t.id}`}
                              className="group min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 rounded"
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-semibold text-zinc-100 group-hover:text-emerald-400 transition-colors">
                                  {formatCleanTargetTitle(t.name, t.probe_type)}
                                </span>
                                <span
                                  className={`rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase ${
                                    getProtocolFamilyMeta(t.probe_type).badgeClass
                                  }`}
                                >
                                  {t.probe_type}
                                </span>
                              </div>
                              <p className="truncate text-xs font-mono text-zinc-400 mt-0.5">
                                {t.host}
                                {groupBy !== "group" && t.group_id && groupMap.get(t.group_id)
                                  ? ` · ${groupMap.get(t.group_id)}`
                                  : ""}
                              </p>
                            </Link>
                            <div className="flex shrink-0 items-center gap-1 pt-0.5">
                              <button
                                type="button"
                                onClick={() => setZoomTargetId(t.id)}
                                title="Zoom multi-probe graph"
                                aria-label={`Zoom ${t.name}`}
                                className="rounded border border-border bg-elevated p-1 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-300"
                              >
                                <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                              <Link
                                href={`/targets/${t.id}`}
                                title="Open full detail page"
                                aria-label={`Inspect ${t.name}`}
                                className="rounded p-1 text-zinc-500 hover:text-emerald-400"
                              >
                                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                              </Link>
                            </div>
                          </div>
                        </td>

                        {visibleProbes.map((p) => {
                          const cell = cellIndex.get(`${t.id}:${p.id}`);
                          if (!cell) {
                            return (
                              <td
                                key={p.id}
                                className="border-l border-border px-3 py-3 text-center text-xs font-mono text-zinc-600"
                              >
                                Unassigned
                              </td>
                            );
                          }
                          const vis = statusVisuals(cell.status as CellStatus);
                          return (
                            <td
                              key={p.id}
                              className="border-l border-border p-1.5"
                            >
                              <Link
                                href={`/targets/${t.id}?probe=${p.id}`}
                                className={`block rounded-md border px-2.5 py-2 transition-colors ${vis.cellClass}`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-sm font-bold font-mono tabular-nums text-zinc-100">
                                    {formatMs(cell.p50_ms)}
                                  </span>
                                  <span
                                    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono font-semibold ${vis.badgeClass}`}
                                  >
                                    {vis.label}
                                  </span>
                                </div>
                                <div className="my-1.5">
                                  <MiniSparkline
                                    points={cell.sparkline ?? []}
                                    status={cell.status}
                                    warnMs={resolveEffectiveWarnMs({
                                      cellWarnMs: cell.warn_ms,
                                      target: t,
                                      probeId: p.id,
                                    })}
                                  />
                                </div>
                                <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-zinc-400">
                                  <span>jit {formatMs(cell.jitter_ms)}</span>
                                  <span
                                    className={
                                      cell.loss_pct > 0
                                        ? "text-rose-200 font-semibold"
                                        : ""
                                    }
                                  >
                                    loss {formatLoss(cell.loss_pct)}
                                  </span>
                                </div>
                              </Link>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {zoomTargetId && data && (() => {
          const zTarget = data.targets.find((t) => t.id === zoomTargetId);
          if (!zTarget) return null;
          return (
            <TargetZoomModal
              mode="dashboard"
              target={zTarget}
              groupName={zTarget.group_id ? groupMap.get(zTarget.group_id) : null}
              cells={data.cells}
              probeMap={probeMap}
              initialRange="3h"
              onClose={handleCloseZoom}
            />
          );
        })()}

        {kpis.incidents > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-400" aria-hidden="true" />
              <span>
                {kpis.incidents} active quorum incident(s) detected across probes.
              </span>
            </div>
            <Link
              href="/alerts"
              className="font-semibold text-rose-300 underline hover:text-rose-100"
            >
              Inspect Incidents
            </Link>
          </div>
        )}
      </div>
    </NocShell>
  );
}
