"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, X } from "lucide-react";
import { SmokeChartPanel } from "@/components/charts/SmokeChartPanel";
import { MtrSnapshotsPanel } from "@/components/mtr/MtrSnapshotsPanel";
import {
  apiRequest,
  type BatchSeriesResponse,
  type MatrixCell,
  type MTRSnapshot,
  type ProbeSeries,
  type Target,
  type TargetSeriesResponse,
} from "@/lib/api";
import {
  formatMs,
  mergeProbeSeriesWithCell,
  rangeKeyToSeconds,
  resolveEffectiveWarnMs,
  statusVisuals,
  type CellStatus,
  type ProbeSeriesInput,
} from "@/lib/smoke-math";
import { TV_RANGES, type TvRange } from "@/lib/tv-config";

interface TargetZoomModalProps {
  mode: "tv" | "dashboard";
  target: Target;
  groupName?: string | null;
  cells: MatrixCell[];
  probeMap: Map<string, string>;
  initialRange?: TvRange;
  fallbackSeries?: ProbeSeries[];
  onClose: () => void;
}

/**
 * Shared multi-probe zoom modal supporting both public TV endpoints and authenticated dashboard endpoints.
 */
export function TargetZoomModal({
  mode,
  target,
  groupName,
  cells,
  probeMap,
  initialRange = "3h",
  fallbackSeries = [],
  onClose,
}: TargetZoomModalProps) {
  const [zoomRange, setZoomRange] = useState<TvRange>(initialRange);
  const [zoomProbeFilter, setZoomProbeFilter] = useState<string>("");
  const [zoomSeries, setZoomSeries] = useState<ProbeSeries[]>([]);
  const [zoomMtrSnaps, setZoomMtrSnaps] = useState<MTRSnapshot[]>([]);
  const [zoomLoading, setZoomLoading] = useState<boolean>(true);
  const [runningMtr, setRunningMtr] = useState<boolean>(false);
  const [mtrErr, setMtrErr] = useState<string | null>(null);

  useEffect(() => {
    setZoomProbeFilter("");
  }, [target.id]);

  useEffect(() => {
    let cancelled = false;
    setZoomLoading(true);
    const seriesPromise =
      mode === "tv"
        ? apiRequest<BatchSeriesResponse>(
            `/api/tv/series?range=${zoomRange}&ids=${encodeURIComponent(target.id)}`
          )
            .then((res) => res.targets[target.id] ?? [])
            .catch(() => [])
        : apiRequest<TargetSeriesResponse>(
            `/api/targets/${encodeURIComponent(target.id)}/series?range=${zoomRange}`
          )
            .then((res) => res.series ?? [])
            .catch(() => []);

    const mtrUrl =
      mode === "tv"
        ? `/api/tv/targets/${encodeURIComponent(target.id)}/mtr?limit=10`
        : `/api/targets/${encodeURIComponent(target.id)}/mtr?limit=10`;

    const mtrPromise = apiRequest<MTRSnapshot[]>(mtrUrl).catch(() => []);

    void Promise.all([seriesPromise, mtrPromise]).then(([serList, mtrList]) => {
      if (cancelled) return;
      setZoomSeries(Array.isArray(serList) ? serList : []);
      setZoomMtrSnaps(Array.isArray(mtrList) ? mtrList : []);
      setZoomLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [mode, target.id, zoomRange]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const targetCells = useMemo(
    () => cells.filter((c) => c.target_id === target.id),
    [cells, target.id]
  );

  const mergedList = useMemo(() => {
    const rawList = zoomSeries.length > 0 ? zoomSeries : fallbackSeries;
    const rawByProbe = new Map(rawList.map((s) => [s.probe_id, s]));
    const items: Array<{ cell: MatrixCell; series: ProbeSeriesInput }> = targetCells.map(
      (cell) => ({
        cell,
        series: mergeProbeSeriesWithCell(
          rawByProbe.get(cell.probe_id),
          cell,
          probeMap.get(cell.probe_id) ?? "Probe",
          zoomRange
        ),
      })
    );

    // Include any series whose probe has not reported a matrix cell yet
    const seenProbes = new Set(targetCells.map((c) => c.probe_id));
    for (const s of rawList) {
      if (seenProbes.has(s.probe_id)) continue;
      items.push({
        cell: {
          target_id: target.id,
          probe_id: s.probe_id,
          p50_ms: s.p50_ms[s.p50_ms.length - 1] ?? null,
          p95_ms: s.p95_ms[s.p95_ms.length - 1] ?? null,
          baseline_ms: s.baseline_ms ?? null,
          warn_ms: s.warn_ms ?? null,
          jitter_ms: s.jitter_ms[s.jitter_ms.length - 1] ?? 0,
          loss_pct: s.loss_pct[s.loss_pct.length - 1] ?? 0,
          sample_count: s.timestamps.length,
          status: "unknown",
          sparkline: [],
        },
        series: s,
      });
    }
    return items;
  }, [zoomSeries, fallbackSeries, targetCells, probeMap, zoomRange, target.id]);

  const visibleProbes = useMemo(
    () =>
      zoomProbeFilter
        ? mergedList.filter((m) => m.cell.probe_id === zoomProbeFilter)
        : mergedList,
    [mergedList, zoomProbeFilter]
  );

  const mtrProbes = useMemo(
    () =>
      mergedList.length > 0
        ? mergedList.map(({ cell, series }) => ({
            id: cell.probe_id,
            name: series.probe_name,
          }))
        : Array.from(probeMap.entries()).map(([id, name]) => ({ id, name })),
    [mergedList, probeMap]
  );

  async function handleRunMtr(probeId?: string) {
    if (mode !== "dashboard") return;
    setRunningMtr(true);
    setMtrErr(null);
    try {
      await apiRequest(`/api/targets/${encodeURIComponent(target.id)}/mtr`, {
        method: "POST",
        body: JSON.stringify(probeId ? { probe_id: probeId } : {}),
      });
      setTimeout(() => {
        void apiRequest<MTRSnapshot[]>(
          `/api/targets/${encodeURIComponent(target.id)}/mtr?limit=10`
        )
          .then((snaps) => {
            setZoomMtrSnaps(Array.isArray(snaps) ? snaps : []);
          })
          .finally(() => setRunningMtr(false));
      }, 2500);
    } catch (err) {
      setMtrErr(err instanceof Error ? err.message : "Failed to trigger MTR");
      setRunningMtr(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tv-zoom-modal-title"
      data-testid="tv-zoom-modal"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-border bg-surface shadow-2xl overflow-hidden"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-elevated/60 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="tv-zoom-modal-title" className="text-base font-bold text-zinc-100">
                {target.name}
              </h2>
              <span className="rounded border border-border bg-canvas px-2 py-0.5 text-[11px] font-mono uppercase text-emerald-400">
                {target.probe_type}
              </span>
              {groupName ? (
                <span className="rounded border border-border bg-canvas px-2 py-0.5 text-[11px] font-mono text-zinc-300">
                  {groupName}
                </span>
              ) : (
                <span className="rounded border border-border bg-canvas px-2 py-0.5 text-[11px] font-mono text-zinc-400">
                  Ungrouped
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-zinc-400">
              {target.host} · Poll {target.interval_sec}s · Drag horizontally on any graph to zoom time window
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Zoom modal time range"
              data-testid="tv-zoom-range-selector"
              className="inline-flex items-center rounded border border-border bg-canvas p-0.5"
            >
              {TV_RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={zoomRange === r}
                  onClick={() => setZoomRange(r)}
                  className={`rounded px-2 py-1 text-xs font-mono font-medium transition-colors ${
                    zoomRange === r
                      ? "bg-emerald-500 text-zinc-950 font-semibold"
                      : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>

            {mode === "dashboard" && (
              <Link
                href={`/targets/${target.id}`}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs font-mono text-emerald-400 hover:border-emerald-500/60"
              >
                <span>Full Detail</span>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}

            <button
              type="button"
              data-testid="tv-zoom-close-btn"
              aria-label="Close zoom modal"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs font-mono text-zinc-200 hover:border-zinc-500 hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span>Close</span>
            </button>
          </div>
        </div>

        {mergedList.length > 1 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-canvas/50 px-4 py-2">
            <button
              type="button"
              aria-pressed={zoomProbeFilter === ""}
              onClick={() => setZoomProbeFilter("")}
              className={`rounded border px-2.5 py-1 text-xs font-mono ${
                zoomProbeFilter === ""
                  ? "border-emerald-500/60 bg-emerald-500/15 font-semibold text-emerald-200"
                  : "border-border bg-elevated text-zinc-300"
              }`}
            >
              All Probes ({mergedList.length})
            </button>
            {mergedList.map(({ cell }) => {
              const pName = probeMap.get(cell.probe_id) ?? "Probe";
              const cVis = statusVisuals((cell.status as CellStatus) || "unknown");
              const active = zoomProbeFilter === cell.probe_id;
              return (
                <button
                  key={cell.probe_id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setZoomProbeFilter(cell.probe_id)}
                  className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-mono ${
                    active
                      ? "border-emerald-500/60 bg-emerald-500/15 font-semibold text-emerald-200"
                      : "border-border bg-elevated text-zinc-300"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${cVis.dotClass}`} />
                  <span>{pName}</span>
                  <span className="text-zinc-400">
                    {cell.status === "down" ? "DOWN" : formatMs(cell.p50_ms)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
          {zoomLoading && zoomSeries.length === 0 ? (
            <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border bg-canvas/40 text-xs font-mono text-zinc-400">
              Loading high-resolution telemetry for {target.name}...
            </div>
          ) : visibleProbes.length === 0 ? (
            <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border bg-canvas/40 text-xs font-mono text-zinc-400">
              No probes reporting telemetry for this target yet.
            </div>
          ) : (
            visibleProbes.map(({ cell, series }) => (
              <SmokeChartPanel
                key={cell.probe_id}
                series={series}
                syncKey={`zoom-modal-${target.id}`}
                targetName={target.name}
                targetHost={target.host}
                rangeLabel={zoomRange}
                windowSec={rangeKeyToSeconds(zoomRange)}
                baselineMs={cell.baseline_ms ?? series.baseline_ms ?? null}
                warnMs={resolveEffectiveWarnMs({
                  cellWarnMs: cell.warn_ms,
                  seriesWarnMs: series.warn_ms,
                  target,
                  probeId: cell.probe_id,
                  series,
                })}
                showThresholdMeta
              />
            ))
          )}

          <MtrSnapshotsPanel
            snapshots={zoomMtrSnaps}
            probes={mtrProbes}
            running={runningMtr}
            errorMessage={mtrErr}
            onRunNow={mode === "dashboard" ? (probeId) => void handleRunMtr(probeId) : undefined}
          />
        </div>
      </div>
    </div>
  );
}
