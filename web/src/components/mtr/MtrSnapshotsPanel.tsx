"use client";

import React, { useState } from "react";
import { AlertCircle, Play, Route } from "lucide-react";
import type { MTRSnapshot } from "@/lib/api";
import { formatDateTime24 } from "@/lib/date-format";

interface ProbeOption {
  id: string;
  name: string;
}

interface MtrSnapshotsPanelProps {
  snapshots: MTRSnapshot[];
  probes?: ProbeOption[];
  running?: boolean;
  errorMessage?: string | null;
  onRunNow?: (probeId?: string) => void;
}

export function MtrSnapshotsPanel({
  snapshots,
  probes = [],
  running = false,
  errorMessage = null,
  onRunNow,
}: MtrSnapshotsPanelProps) {
  const [selectedProbeId, setSelectedProbeId] = useState<string>("");
  const visibleSnapshots = selectedProbeId
    ? snapshots.filter((s) => s.probe_id === selectedProbeId)
    : snapshots;

  return (
    <section
      aria-label="MTR Path Snapshots"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Route className="h-4 w-4 text-cyan-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-zinc-100">
            MTR / Hop-by-Hop Diagnostics
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {probes.length > 0 && (
            <select
              aria-label="Select probe for manual MTR"
              value={selectedProbeId}
              onChange={(e) => setSelectedProbeId(e.target.value)}
              className="rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs font-mono text-zinc-200"
            >
              <option value="">All Online Probes</option>
              {probes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          {onRunNow && (
            <button
              type="button"
              onClick={() => onRunNow(selectedProbeId || undefined)}
              disabled={running}
              aria-busy={running}
              className="inline-flex items-center gap-2 rounded-md border border-cyan-500/40 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{running ? "Running MTR..." : "Run MTR Now"}</span>
            </button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      {visibleSnapshots.length === 0 ? (
        <div className="rounded border border-dashed border-border bg-canvas/50 p-6 text-center text-xs text-zinc-400">
          No MTR snapshots recorded yet. Snapshots trigger automatically on consecutive or intermittent packet loss, or on demand.
        </div>
      ) : (
        <div className="space-y-4">
          {visibleSnapshots.slice(0, 5).map((snap) => (
            <div key={snap.id} className="rounded-md border border-border bg-elevated/40 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs font-mono">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-zinc-100">{snap.probe_name}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      snap.trigger_reason === "auto_loss"
                        ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                        : "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    }`}
                  >
                    {snap.trigger_reason === "auto_loss" ? "AUTO LOSS" : "MANUAL"}
                  </span>
                </div>
                <span className="text-zinc-400">
                  {formatDateTime24(snap.captured_at)}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="border-b border-border bg-canvas/60 text-zinc-400">
                    <tr>
                      <th className="px-3 py-1.5">HOP</th>
                      <th className="px-3 py-1.5">IP ADDRESS / HOST</th>
                      <th className="px-3 py-1.5 text-right">LOSS %</th>
                      <th className="px-3 py-1.5 text-right">SENT/RECV</th>
                      <th className="px-3 py-1.5 text-right">BEST</th>
                      <th className="px-3 py-1.5 text-right">AVG</th>
                      <th className="px-3 py-1.5 text-right">WORST</th>
                      <th className="px-3 py-1.5 text-right">STDEV</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {snap.hops.map((hop) => (
                      <tr key={hop.hop} className="hover:bg-elevated/60">
                        <td className="px-3 py-1.5 text-zinc-400">{hop.hop}</td>
                        <td className="px-3 py-1.5 text-zinc-100">
                          {hop.ip === "*" ? (
                            <span className="text-zinc-400">* (no reply)</span>
                          ) : (
                            <div>
                              <span>{hop.ip}</span>
                              {hop.host && hop.host !== hop.ip && (
                                <span className="ml-2 text-[11px] text-zinc-400">
                                  ({hop.host})
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right font-semibold ${
                            hop.loss_pct > 0 ? "text-rose-400" : "text-emerald-400"
                          }`}
                        >
                          {hop.loss_pct.toFixed(1)}%
                        </td>
                        <td className="px-3 py-1.5 text-right text-zinc-300">
                          {hop.sent}/{hop.recv}
                        </td>
                        <td className="px-3 py-1.5 text-right text-zinc-300">
                          {hop.recv > 0 ? `${(hop.best_us / 1000).toFixed(1)} ms` : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right text-zinc-100">
                          {hop.recv > 0 ? `${(hop.avg_us / 1000).toFixed(1)} ms` : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right text-zinc-300">
                          {hop.recv > 0 ? `${(hop.worst_us / 1000).toFixed(1)} ms` : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right text-zinc-400">
                          {hop.recv > 0 ? `${(hop.stdev_us / 1000).toFixed(1)} ms` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
