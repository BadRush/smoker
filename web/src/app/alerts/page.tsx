"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCircle2, Plus, Send, Trash2 } from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import { formatDateTime24 } from "@/lib/date-format";
import {
  ApiError,
  apiRequest,
  type AlertChannel,
  type AlertRule,
  type Incident,
  type Target,
} from "@/lib/api";

export default function AlertsPage() {
  const router = useRouter();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Rule form
  const [rName, setRName] = useState("");
  const [rTargetId, setRTargetId] = useState("");
  const [rMetric, setRMetric] = useState<
    "loss_pct" | "latency_p95" | "jitter" | "probe_offline" | "baseline_spike_pct"
  >("loss_pct");
  const [rThreshold, setRThreshold] = useState(20);
  const [rDuration, setRDuration] = useState(30);
  const [rQuorum, setRQuorum] = useState(2);

  // Channel form
  const [cType, setCType] = useState<"telegram" | "webhook">("telegram");
  const [cName, setCName] = useState("");
  const [cBotToken, setCBotToken] = useState("");
  const [cChatId, setCChatId] = useState("");
  const [cWebhookUrl, setCWebhookUrl] = useState("");

  const loadAlerts = useCallback(async () => {
    try {
      const [incRes, ruleRes, chanRes, tRes] = await Promise.all([
        apiRequest<Incident[]>("/api/alerts/incidents"),
        apiRequest<AlertRule[]>("/api/alerts/rules"),
        apiRequest<AlertChannel[]>("/api/alerts/channels"),
        apiRequest<Target[]>("/api/targets"),
      ]);
      setIncidents(incRes);
      setRules(ruleRes);
      setChannels(chanRes);
      setTargets(tRes);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  async function handleCreateRule(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest("/api/alerts/rules", {
        method: "POST",
        body: JSON.stringify({
          name: rName.trim(),
          target_id: rMetric === "probe_offline" ? null : rTargetId || null,
          metric: rMetric,
          threshold_value: Number(rThreshold),
          duration_sec: Number(rDuration),
          quorum_min_probes: Number(rQuorum),
          cooldown_sec: 300,
          enabled: true,
        }),
      });
      setRName("");
      await loadAlerts();
      setFeedback("Alert rule created.");
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to create rule");
    }
  }

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest("/api/alerts/channels", {
        method: "POST",
        body: JSON.stringify({
          type: cType,
          name: cName.trim(),
          bot_token: cBotToken.trim(),
          chat_id: cChatId.trim(),
          webhook_url: cWebhookUrl.trim(),
          enabled: true,
        }),
      });
      setCName("");
      setCBotToken("");
      setCChatId("");
      setCWebhookUrl("");
      await loadAlerts();
      setFeedback("Notification channel encrypted and saved.");
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to save channel");
    }
  }

  async function handleTestChannel(id: string) {
    setFeedback(null);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>(
        `/api/alerts/channels/${id}/test`,
        { method: "POST" }
      );
      setFeedback(res.message);
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Test delivery failed");
    }
  }

  const openCount = incidents.filter((i) => i.status === "open").length;

  return (
    <NocShell activeIncidents={openCount}>
      <div className="space-y-8">
        <div>
          <h1 className="text-xl font-bold text-zinc-50">
            Smart Quorum Alerts &amp; Channels
          </h1>
          <p className="text-xs text-zinc-400">
            Require quorum across N independent probes before firing alerts to eliminate single-Metro false alarms.
          </p>
        </div>

        {feedback && (
          <div role="status" className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs text-cyan-200">
            {feedback}
          </div>
        )}

        {/* Incidents Log */}
        <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-rose-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-zinc-100">Incident History</h2>
          </div>
          {loading ? (
            <div className="h-24 animate-pulse rounded bg-elevated" />
          ) : incidents.length === 0 ? (
            <div className="flex items-center gap-2 rounded border border-dashed border-border p-4 text-xs text-zinc-400">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              <span>All clear — no quorum incidents triggered.</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="border-b border-border text-zinc-400">
                  <tr>
                    <th className="py-2 pr-4">STATUS</th>
                    <th className="py-2 pr-4">RULE / TARGET</th>
                    <th className="py-2 pr-4">AFFECTED PROBES</th>
                    <th className="py-2 pr-4">SUMMARY</th>
                    <th className="py-2">STARTED</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {incidents.map((inc) => (
                    <tr key={inc.id}>
                      <td className="py-2 pr-4">
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                            inc.status === "open"
                              ? "bg-rose-500/20 text-rose-300"
                              : "bg-emerald-500/15 text-emerald-400"
                          }`}
                        >
                          {inc.status}
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-sans text-zinc-100">
                        {inc.rule_name} · <span className="text-zinc-400">{inc.target_name}</span>
                      </td>
                      <td className="py-2 pr-4 text-zinc-300">
                        {inc.affected_probes.join(", ")}
                      </td>
                      <td className="py-2 pr-4 font-sans text-zinc-300">{inc.summary}</td>
                      <td className="py-2 text-zinc-400">
                        {formatDateTime24(inc.started_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Quorum Rules */}
          <section className="rounded-lg border border-border bg-surface p-4 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-100">Quorum Alert Rules</h2>
            <form onSubmit={handleCreateRule} className="space-y-3 border-b border-border pb-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  placeholder="Rule name (e.g. Core Loss)"
                  aria-label="Rule name"
                  value={rName}
                  onChange={(e) => setRName(e.target.value)}
                  className="rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
                />
                <select
                  aria-label="Alert metric"
                  value={rMetric}
                  onChange={(e) =>
                    setRMetric(
                      e.target.value as
                        | "loss_pct"
                        | "latency_p95"
                        | "jitter"
                        | "probe_offline"
                        | "baseline_spike_pct"
                    )
                  }
                  className="rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
                >
                  <option value="loss_pct">Packet Loss (%)</option>
                  <option value="baseline_spike_pct">
                    Baseline Spike % (Auto Best-Path)
                  </option>
                  <option value="latency_p95">High Latency (P95)</option>
                  <option value="jitter">Avg Jitter (ms)</option>
                  <option value="probe_offline">Probe Offline (sec)</option>
                </select>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                {rMetric !== "probe_offline" && (
                  <select
                    aria-label="Target"
                    value={rTargetId}
                    onChange={(e) => setRTargetId(e.target.value)}
                    className="sm:col-span-2 rounded border border-border bg-canvas px-2 py-1.5 text-xs text-zinc-100"
                  >
                    <option value="">Select Target...</option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="number"
                  aria-label="Threshold"
                  value={rThreshold}
                  onChange={(e) => setRThreshold(Number(e.target.value))}
                  placeholder="Threshold"
                  className="rounded border border-border bg-canvas px-2 py-1.5 text-xs font-mono text-zinc-100"
                />
                <input
                  type="number"
                  min={1}
                  aria-label="Quorum min probes"
                  value={rQuorum}
                  onChange={(e) => setRQuorum(Number(e.target.value))}
                  placeholder="Quorum N"
                  className="rounded border border-border bg-canvas px-2 py-1.5 text-xs font-mono text-zinc-100"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-zinc-400">
                  Window (s):
                  <input
                    type="number"
                    min={5}
                    value={rDuration}
                    onChange={(e) => setRDuration(Number(e.target.value))}
                    className="ml-2 w-16 rounded border border-border bg-canvas px-2 py-1 font-mono text-zinc-100"
                  />
                </label>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Add Rule</span>
                </button>
              </div>
            </form>

            <div className="space-y-2">
              {rules.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded border border-border bg-elevated/40 px-3 py-2 text-xs"
                >
                  <div>
                    <p className="font-semibold text-zinc-100">{r.name}</p>
                    <p className="font-mono text-[11px] text-zinc-400">
                      {r.metric === "latency_p95" ? "High Latency (P95)" : r.metric} &gt;= {r.threshold_value} · {r.duration_sec}s · quorum {r.quorum_min_probes}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete rule ${r.name}`}
                    onClick={async () => {
                      await apiRequest(`/api/alerts/rules/${r.id}`, { method: "DELETE" });
                      await loadAlerts();
                    }}
                    className="text-zinc-500 hover:text-rose-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Notification Channels */}
          <section className="rounded-lg border border-border bg-surface p-4 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-100">
              Notification Channels (Telegram &amp; Webhook)
            </h2>
            <form onSubmit={handleCreateChannel} className="space-y-3 border-b border-border pb-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  aria-label="Channel type"
                  value={cType}
                  onChange={(e) => setCType(e.target.value as "telegram" | "webhook")}
                  className="rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
                >
                  <option value="telegram">Telegram Bot</option>
                  <option value="webhook">Discord / Webhook</option>
                </select>
                <input
                  type="text"
                  placeholder="Channel Name"
                  aria-label="Channel name"
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  className="rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
                />
              </div>

              {cType === "telegram" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    type="password"
                    placeholder="Bot Token"
                    aria-label="Telegram bot token"
                    value={cBotToken}
                    onChange={(e) => setCBotToken(e.target.value)}
                    className="rounded border border-border bg-canvas px-3 py-1.5 text-xs font-mono text-zinc-100"
                  />
                  <input
                    type="text"
                    placeholder="Chat ID (e.g. -100...)"
                    aria-label="Telegram chat ID"
                    value={cChatId}
                    onChange={(e) => setCChatId(e.target.value)}
                    className="rounded border border-border bg-canvas px-3 py-1.5 text-xs font-mono text-zinc-100"
                  />
                </div>
              ) : (
                <input
                  type="url"
                  placeholder="https://discord.com/api/webhooks/..."
                  aria-label="Webhook URL"
                  value={cWebhookUrl}
                  onChange={(e) => setCWebhookUrl(e.target.value)}
                  className="w-full rounded border border-border bg-canvas px-3 py-1.5 text-xs font-mono text-zinc-100"
                />
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Save Channel</span>
                </button>
              </div>
            </form>

            <div className="space-y-2">
              {channels.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded border border-border bg-elevated/40 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-zinc-100">
                      {c.name}{" "}
                      <span className="ml-1 font-mono uppercase text-[10px] text-cyan-400">
                        {c.type}
                      </span>
                    </p>
                    <p className="truncate font-mono text-[11px] text-zinc-400">
                      {c.config_hint}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleTestChannel(c.id)}
                      className="inline-flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/20"
                    >
                      <Send className="h-3 w-3" aria-hidden="true" />
                      <span>Test</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete channel ${c.name}`}
                      onClick={async () => {
                        await apiRequest(`/api/alerts/channels/${c.id}`, {
                          method: "DELETE",
                        });
                        await loadAlerts();
                      }}
                      className="text-zinc-500 hover:text-rose-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </NocShell>
  );
}
