"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Pencil, RefreshCw, ServerCrash } from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import { SmokeChartPanel } from "@/components/charts/SmokeChartPanel";
import { TimeRangePicker } from "@/components/charts/TimeRangePicker";
import { MtrSnapshotsPanel } from "@/components/mtr/MtrSnapshotsPanel";
import {
  ApiError,
  apiRequest,
  type MTRSnapshot,
  type TargetSeriesResponse,
} from "@/lib/api";
import {
  appendLiveTick,
  rangeKeyToSeconds,
  resolveEffectiveWarnMs,
} from "@/lib/smoke-math";
import {
  parseCustomWindowFromSearch,
  type CustomTimeWindow,
} from "@/lib/tv-config";
import { useLiveSocket, type LiveEventMessage } from "@/lib/useLiveSocket";

const RANGES = [
  "5m",
  "15m",
  "1h",
  "3h",
  "6h",
  "12h",
  "24h",
  "3d",
  "7d",
  "30d",
  "1y",
] as const;

const VALID_DETAIL_RANGES = new Set<string>(RANGES);

export default function TargetDetailPage() {
  const params = useParams<{ id: string }>();
  const targetId = params.id;
  const router = useRouter();

  const [rangeKey, setRangeKey] = useState<string>("5m");
  const [customWindow, setCustomWindow] = useState<CustomTimeWindow | null>(null);
  const [urlHydrated, setUrlHydrated] = useState(false);
  const [data, setData] = useState<TargetSeriesResponse | null>(null);
  const [mtrSnaps, setMtrSnaps] = useState<MTRSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningMtr, setRunningMtr] = useState(false);
  const [mtrError, setMtrError] = useState<string | null>(null);

  const mtrTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = new URLSearchParams(window.location.search);
    const parsedCustom = parseCustomWindowFromSearch(window.location.search);
    if (parsedCustom) {
      setCustomWindow(parsedCustom);
    } else {
      const r = qs.get("range") ?? "";
      if (VALID_DETAIL_RANGES.has(r)) {
        setRangeKey(r);
      }
    }
    setUrlHydrated(true);
  }, []);

  const syncUrlParams = useCallback(
    (nextRange: string, nextCustom: CustomTimeWindow | null) => {
      if (typeof window === "undefined") return;
      const qs = new URLSearchParams(window.location.search);
      if (nextCustom) {
        qs.delete("range");
        qs.set("from", String(nextCustom.fromSec));
        qs.set("to", String(nextCustom.toSec));
      } else {
        qs.delete("from");
        qs.delete("to");
        if (nextRange && nextRange !== "5m") {
          qs.set("range", nextRange);
        } else {
          qs.delete("range");
        }
      }
      const next = qs.toString();
      window.history.replaceState(
        null,
        "",
        next ? `${window.location.pathname}?${next}` : window.location.pathname
      );
    },
    []
  );

  const handleSelectPreset = useCallback(
    (nextRange: string) => {
      setCustomWindow(null);
      setRangeKey(nextRange);
      syncUrlParams(nextRange, null);
    },
    [syncUrlParams]
  );

  const handleApplyCustom = useCallback(
    (win: CustomTimeWindow) => {
      setCustomWindow(win);
      syncUrlParams(rangeKey, win);
    },
    [rangeKey, syncUrlParams]
  );

  const clearMtrTimers = useCallback(() => {
    for (const timer of mtrTimersRef.current) {
      clearTimeout(timer);
    }
    mtrTimersRef.current = [];
  }, []);

  useEffect(() => {
    return () => clearMtrTimers();
  }, [clearMtrTimers]);

  const loadDetail = useCallback(async () => {
    if (!urlHydrated) return;
    try {
      setError(null);
      const query = customWindow
        ? `from=${customWindow.fromSec}&to=${customWindow.toSec}`
        : `range=${rangeKey}`;
      const [seriesRes, mtrRes] = await Promise.all([
        apiRequest<TargetSeriesResponse>(
          `/api/targets/${targetId}/series?${query}`
        ),
        apiRequest<MTRSnapshot[]>(`/api/targets/${targetId}/mtr?limit=10`),
      ]);
      setData(seriesRes);
      setMtrSnaps(mtrRes);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
        return;
      }
      setError(
        err instanceof Error ? err.message : "Failed to load target telemetry"
      );
    } finally {
      setLoading(false);
    }
  }, [targetId, rangeKey, customWindow, urlHydrated, router]);

  useEffect(() => {
    if (!urlHydrated) return;
    setLoading(true);
    void loadDetail();
  }, [urlHydrated, loadDetail]);

  const handleLive = useCallback(
    (ev: LiveEventMessage) => {
      if (ev.type === "mtr_ready") {
        const raw = ev.data as
          | (MTRSnapshot & { error?: string })
          | { target_id?: string; probe_name?: string; error?: string };
        if (raw && raw.target_id === targetId) {
          clearMtrTimers();
          setRunningMtr(false);
          if ("error" in raw && raw.error) {
            const who = raw.probe_name ? `${raw.probe_name}: ` : "";
            setMtrError(`${who}${raw.error}`);
            return;
          }
          if ("hops" in raw && Array.isArray(raw.hops)) {
            setMtrError(null);
            setMtrSnaps((prev) =>
              [raw as MTRSnapshot, ...prev.filter((s) => s.id !== raw.id)].slice(0, 15)
            );
          }
        }
        return;
      }

      if (ev.type === "sample_tick" && !customWindow && rangeKey === "5m") {
        const payload = ev.data as {
          probe_id?: string;
          samples?: Array<{
            ts_ns: number;
            target_id: string;
            rtt_us?: number;
            jitter_us: number;
            is_loss: boolean;
          }>;
        };
        if (!payload.probe_id || !payload.samples) return;
        const recs = payload.samples.filter((s) => s.target_id === targetId);
        if (recs.length === 0) return;

        setData((prev) => {
          if (!prev) return prev;
          const nextSeries = prev.series.map((ps) => {
            if (ps.probe_id !== payload.probe_id) return ps;
            let updated = ps;
            for (const rec of recs) {
              const tsSec = Math.floor(rec.ts_ns / 1e9);
              const rttMs =
                !rec.is_loss && rec.rtt_us !== undefined
                  ? rec.rtt_us / 1000
                  : null;
              const jitMs = !rec.is_loss ? rec.jitter_us / 1000 : null;
              updated = appendLiveTick(
                updated,
                tsSec,
                rttMs,
                jitMs,
                rec.is_loss,
                300
              );
            }
            return updated;
          });
          return { ...prev, series: nextSeries };
        });
      }
    },
    [rangeKey, customWindow, targetId, clearMtrTimers]
  );

  const wsState = useLiveSocket([`target:${targetId}`], handleLive);

  async function handleRunMtr(probeId?: string) {
    clearMtrTimers();
    setMtrError(null);
    setRunningMtr(true);
    const triggeredAtMs = Date.now();
    try {
      const resp = await apiRequest<{ request_ids: string[] }>(
        `/api/targets/${targetId}/mtr/run`,
        {
          method: "POST",
          body: JSON.stringify(probeId ? { probe_id: probeId } : {}),
        }
      );
      if (!resp.request_ids || resp.request_ids.length === 0) {
        setRunningMtr(false);
        setMtrError("No online probes available to execute MTR.");
        return;
      }

      // HTTP fallback polling in case WS mtr_ready is delayed or disconnected
      const delays = [2500, 5500, 9500];
      delays.forEach((delay, idx) => {
        const timer = setTimeout(async () => {
          try {
            const latest = await apiRequest<MTRSnapshot[]>(
              `/api/targets/${targetId}/mtr?limit=10`
            );
            setMtrSnaps(latest);
            const arrived = latest.some(
              (s) => new Date(s.captured_at).getTime() >= triggeredAtMs - 2000
            );
            if (arrived) {
              clearMtrTimers();
              setRunningMtr(false);
              return;
            }
          } catch {
            // Keep waiting until final fallback tick
          }
          if (idx === delays.length - 1) {
            setRunningMtr(false);
          }
        }, delay);
        mtrTimersRef.current.push(timer);
      });
    } catch (err) {
      setRunningMtr(false);
      setMtrError(err instanceof Error ? err.message : "Failed to dispatch MTR");
    }
  }

  return (
    <NocShell wsState={wsState}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-elevated text-zinc-300 hover:text-white"
              aria-label="Back to Dashboard"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-xl font-bold text-zinc-50">
                  {data?.target.name ?? "Target Telemetry"}
                </h1>
                {data?.target && (
                  <span className="rounded border border-border bg-elevated px-2 py-0.5 text-xs font-mono uppercase text-emerald-400">
                    {data.target.probe_type} · {data.target.interval_sec}s
                  </span>
                )}
                {customWindow && (
                  <button
                    type="button"
                    onClick={() => handleSelectPreset(rangeKey)}
                    title="Viewing historical custom range — click to return to Live"
                    className="inline-flex items-center gap-1 rounded border border-cyan-500/45 bg-cyan-500/15 px-2 py-0.5 text-[11px] font-mono uppercase text-cyan-200 hover:bg-cyan-500/25"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                    Historical
                  </button>
                )}
              </div>
              <p className="truncate text-xs font-mono text-zinc-400">
                {data?.target.host}
                {data?.target.port_or_path ? ` (${data.target.port_or_path})` : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <TimeRangePicker
              value={rangeKey}
              customWindow={customWindow}
              allPresets={RANGES}
              onSelectPreset={handleSelectPreset}
              onApplyCustom={handleApplyCustom}
              ariaLabel="Time range selector"
              testId="target-detail-range-selector"
            />

            <Link
              href={`/targets?edit=${targetId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Edit Target</span>
            </Link>

            <button
              type="button"
              onClick={() => void loadDetail()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Reload</span>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-[260px] animate-pulse rounded-lg border border-border bg-surface"
              />
            ))}
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-8 text-center"
          >
            <ServerCrash className="h-8 w-8 text-rose-400" aria-hidden="true" />
            <p className="text-sm text-rose-200">{error}</p>
            <button
              type="button"
              onClick={() => void loadDetail()}
              className="rounded-md bg-rose-500/20 px-4 py-1.5 text-xs font-semibold text-rose-200"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {data?.series.map((s) => (
              <SmokeChartPanel
                key={s.probe_id}
                series={s}
                syncKey="smoker-target-sync"
                targetName={data.target.name}
                targetHost={data.target.host}
                rangeLabel={
                  customWindow
                    ? "CUSTOM"
                    : rangeKey === "5m"
                    ? "Live 5m"
                    : rangeKey
                }
                windowSec={customWindow ? null : rangeKeyToSeconds(rangeKey)}
                fixedBounds={
                  customWindow
                    ? [customWindow.fromSec, customWindow.toSec]
                    : null
                }
                baselineMs={s.baseline_ms ?? null}
                warnMs={resolveEffectiveWarnMs({
                  seriesWarnMs: s.warn_ms,
                  target: data.target,
                  probeId: s.probe_id,
                  series: s,
                })}
              />
            ))}

            <MtrSnapshotsPanel
              snapshots={mtrSnaps}
              probes={
                data?.series.map((s) => ({
                  id: s.probe_id,
                  name: s.probe_name,
                })) ?? []
              }
              running={runningMtr}
              errorMessage={mtrError}
              onRunNow={(probeId) => void handleRunMtr(probeId)}
            />
          </div>
        )}
      </div>
    </NocShell>
  );
}
