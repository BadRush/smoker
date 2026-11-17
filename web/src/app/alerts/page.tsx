"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Pencil,
  Plus,
  Power,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import { formatDateTime24 } from "@/lib/date-format";
import {
  ApiError,
  apiRequest,
  type AlertChannel,
  type AlertRule,
  type Incident,
  type Probe,
  type Target,
  type TargetGroup,
} from "@/lib/api";

type RuleScope = "global" | "group" | "target";
type RuleMetric =
  | "loss_pct"
  | "latency_p95"
  | "jitter"
  | "probe_offline"
  | "baseline_spike_pct";

function parseTelegramHint(hint: string): { chatId: string; threadId: string } {
  const parts = hint.split("·").map((s) => s.trim());
  let chatId = "";
  let threadId = "";
  for (const p of parts) {
    if (p.startsWith("chat:")) {
      chatId = p.slice(5).trim();
    } else if (p.startsWith("thread:")) {
      threadId = p.slice(7).trim();
    }
  }
  return { chatId, threadId };
}

function formatDurationSeconds(startIso: string, endIso?: string | null): string {
  if (!endIso) return "Ongoing";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s (${sec}s)`;
  return `${s}s`;
}

export default function AlertsPage() {
  const router = useRouter();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [groups, setGroups] = useState<TargetGroup[]>([]);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Rule form
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [rName, setRName] = useState("");
  const [rScope, setRScope] = useState<RuleScope>("target");
  const [rTargetId, setRTargetId] = useState("");
  const [rGroupId, setRGroupId] = useState("");
  const [rMetric, setRMetric] = useState<RuleMetric>("loss_pct");
  const [rThreshold, setRThreshold] = useState(20);
  const [rDuration, setRDuration] = useState(30);
  const [rQuorum, setRQuorum] = useState(2);
  const [rCooldownSec, setRCooldownSec] = useState(0);
  const [rConfirmSec, setRConfirmSec] = useState(0);
  const [rRecoverSec, setRRecoverSec] = useState(45);
  const [rChannelIds, setRChannelIds] = useState<string[]>([]);
  const [rEnabled, setREnabled] = useState(true);

  // Channel form
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [cType, setCType] = useState<"telegram" | "webhook">("telegram");
  const [cName, setCName] = useState("");
  const [cBotToken, setCBotToken] = useState("");
  const [cChatId, setCChatId] = useState("");
  const [cThreadId, setCThreadId] = useState("");
  const [cWebhookUrl, setCWebhookUrl] = useState("");
  const [cEnabled, setCEnabled] = useState(true);

  const loadAlerts = useCallback(async () => {
    try {
      const [incRes, ruleRes, chanRes, tRes, pRes, gRes] = await Promise.all([
        apiRequest<Incident[]>("/api/alerts/incidents"),
        apiRequest<AlertRule[]>("/api/alerts/rules"),
        apiRequest<AlertChannel[]>("/api/alerts/channels"),
        apiRequest<Target[]>("/api/targets"),
        apiRequest<Probe[]>("/api/probes"),
        apiRequest<TargetGroup[]>("/api/groups").catch(() => [] as TargetGroup[]),
      ]);
      setIncidents(Array.isArray(incRes) ? incRes : []);
      setRules(Array.isArray(ruleRes) ? ruleRes : []);
      setChannels(Array.isArray(chanRes) ? chanRes : []);
      setTargets(Array.isArray(tRes) ? tRes : []);
      setProbes(Array.isArray(pRes) ? pRes : []);
      setGroups(Array.isArray(gRes) ? gRes : []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  const targetMap = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const channelMap = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);

  const getEffectiveProbeCount = useCallback(
    (target: Target): number => {
      return target.assign_all_probes ? probes.length : target.probe_ids.length;
    },
    [probes.length]
  );

  const selectedTarget =
    rScope === "target" && rTargetId ? targetMap.get(rTargetId) : undefined;
  const selectedTargetProbeCount = selectedTarget
    ? getEffectiveProbeCount(selectedTarget)
    : null;
  const formQuorumTooHigh =
    rMetric !== "probe_offline" &&
    rScope === "target" &&
    selectedTargetProbeCount !== null &&
    selectedTargetProbeCount > 0 &&
    Number(rQuorum) > selectedTargetProbeCount;

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  function resetRuleForm() {
    setEditingRuleId(null);
    setRName("");
    setRScope("target");
    setRTargetId("");
    setRGroupId("");
    setRMetric("loss_pct");
    setRThreshold(20);
    setRDuration(30);
    setRQuorum(2);
    setRCooldownSec(0);
    setRConfirmSec(0);
    setRRecoverSec(45);
    setRChannelIds([]);
    setREnabled(true);
  }

  function startEditRule(rule: AlertRule) {
    setEditingRuleId(rule.id);
    setRName(rule.name);
    setRMetric(rule.metric);
    if (rule.metric === "probe_offline" || (!rule.target_id && !rule.group_id)) {
      setRScope("global");
      setRTargetId("");
      setRGroupId("");
    } else if (rule.target_id) {
      setRScope("target");
      setRTargetId(rule.target_id);
      setRGroupId("");
    } else if (rule.group_id) {
      setRScope("group");
      setRGroupId(rule.group_id);
      setRTargetId("");
    }
    setRThreshold(rule.threshold_value);
    setRDuration(rule.duration_sec);
    setRQuorum(rule.quorum_min_probes);
    setRCooldownSec(rule.cooldown_sec ?? 0);
    setRConfirmSec(rule.confirm_sec ?? 0);
    setRRecoverSec(rule.recover_sec ?? 45);
    setRChannelIds(rule.channel_ids ?? []);
    setREnabled(rule.enabled);
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (rMetric !== "probe_offline") {
      if (rScope === "target" && !rTargetId) {
        setFeedback("Please select a target or change rule scope to Group / Global.");
        return;
      }
      if (rScope === "group" && !rGroupId) {
        setFeedback("Please select a target group or change rule scope.");
        return;
      }
    }
    const payload = {
      name: rName.trim(),
      target_id:
        rMetric === "probe_offline" || rScope !== "target" ? null : rTargetId || null,
      group_id:
        rMetric === "probe_offline" || rScope !== "group" ? null : rGroupId || null,
      metric: rMetric,
      threshold_value: Number(rThreshold),
      duration_sec: Number(rDuration),
      quorum_min_probes: Number(rQuorum),
      cooldown_sec: Number(rCooldownSec),
      confirm_sec: Number(rConfirmSec),
      recover_sec: Number(rRecoverSec),
      channel_ids: rChannelIds,
      enabled: editingRuleId ? rEnabled : true,
    };

    try {
      if (editingRuleId) {
        await apiRequest(`/api/alerts/rules/${editingRuleId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        setFeedback("Alert rule updated.");
      } else {
        await apiRequest("/api/alerts/rules", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setFeedback("Alert rule created.");
      }
      resetRuleForm();
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to save rule");
    }
  }

  async function handleToggleRule(rule: AlertRule) {
    setFeedback(null);
    try {
      await apiRequest(`/api/alerts/rules/${rule.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: rule.name,
          target_id: rule.target_id ?? null,
          group_id: rule.group_id ?? null,
          metric: rule.metric,
          threshold_value: rule.threshold_value,
          duration_sec: rule.duration_sec,
          quorum_min_probes: rule.quorum_min_probes,
          cooldown_sec: rule.cooldown_sec,
          confirm_sec: rule.confirm_sec ?? 0,
          recover_sec: rule.recover_sec ?? 45,
          channel_ids: rule.channel_ids ?? [],
          enabled: !rule.enabled,
        }),
      });
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to toggle rule");
    }
  }

  function resetChannelForm() {
    setEditingChannelId(null);
    setCType("telegram");
    setCName("");
    setCBotToken("");
    setCChatId("");
    setCThreadId("");
    setCWebhookUrl("");
    setCEnabled(true);
  }

  function startEditChannel(ch: AlertChannel) {
    setEditingChannelId(ch.id);
    setCType(ch.type);
    setCName(ch.name);
    setCBotToken("");
    setCWebhookUrl("");
    setCEnabled(ch.enabled);
    if (ch.type === "telegram") {
      const parsed = parseTelegramHint(ch.config_hint);
      setCChatId(parsed.chatId);
      setCThreadId(parsed.threadId);
    } else {
      setCChatId("");
      setCThreadId("");
    }
  }

  async function handleSaveChannel(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    const trimmedThreadId = cThreadId.trim();
    if (cType === "telegram" && trimmedThreadId !== "" && !/^[1-9]\d*$/.test(trimmedThreadId)) {
      setFeedback("Telegram Thread ID must be a positive integer.");
      return;
    }

    try {
      if (editingChannelId) {
        await apiRequest(`/api/alerts/channels/${editingChannelId}`, {
          method: "PUT",
          body: JSON.stringify({
            name: cName.trim(),
            bot_token: cBotToken.trim() || undefined,
            chat_id: cType === "telegram" ? cChatId.trim() || undefined : undefined,
            thread_id:
              cType === "telegram"
                ? trimmedThreadId !== ""
                  ? Number(trimmedThreadId)
                  : null
                : undefined,
            webhook_url:
              cType === "webhook" ? cWebhookUrl.trim() || undefined : undefined,
            enabled: cEnabled,
          }),
        });
        setFeedback("Notification channel updated.");
      } else {
        await apiRequest("/api/alerts/channels", {
          method: "POST",
          body: JSON.stringify({
            type: cType,
            name: cName.trim(),
            bot_token: cBotToken.trim(),
            chat_id: cChatId.trim(),
            thread_id:
              cType === "telegram" && trimmedThreadId !== ""
                ? Number(trimmedThreadId)
                : undefined,
            webhook_url: cWebhookUrl.trim(),
            enabled: true,
          }),
        });
        setFeedback("Notification channel encrypted and saved.");
      }
      resetChannelForm();
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to save channel");
    }
  }

  async function handleToggleChannel(ch: AlertChannel) {
    setFeedback(null);
    try {
      await apiRequest(`/api/alerts/channels/${ch.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to toggle channel");
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
            Require quorum across N independent locations before sending Telegram/Webhook notifications. Default sends once on start, escalation, and restore.
          </p>
        </div>

        {feedback && (
          <div
            role="status"
            className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs text-cyan-200"
          >
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
                    <th className="py-2 pr-4">LOCATIONS</th>
                    <th className="py-2 pr-4">SUMMARY</th>
                    <th className="py-2 pr-4">START</th>
                    <th className="py-2">SLA DURATION</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {incidents.map((inc) => (
                    <tr key={inc.id}>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                              inc.status === "open"
                                ? "bg-rose-500/20 text-rose-300"
                                : "bg-emerald-500/15 text-emerald-400"
                            }`}
                          >
                            {inc.status === "open" ? inc.severity || "open" : "ok"}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 pr-4 font-sans text-zinc-100">
                        {inc.rule_name} ·{" "}
                        <span className="text-zinc-400">{inc.target_name}</span>
                      </td>
                      <td className="py-2 pr-4 text-zinc-300">
                        {inc.affected_probes.join(", ")}
                      </td>
                      <td className="py-2 pr-4 font-sans text-zinc-300">{inc.summary}</td>
                      <td className="py-2 pr-4 text-zinc-400">
                        {formatDateTime24(inc.started_at)}
                      </td>
                      <td className="py-2 text-zinc-300">
                        {formatDurationSeconds(inc.started_at, inc.resolved_at)}
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
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">
                {editingRuleId ? "Edit Alert Rule" : "Quorum Alert Rules"}
              </h2>
              {editingRuleId && (
                <button
                  type="button"
                  onClick={resetRuleForm}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-zinc-300 hover:bg-elevated"
                >
                  <X className="h-3 w-3" />
                  <span>Cancel</span>
                </button>
              )}
            </div>

            <form onSubmit={handleSaveRule} className="space-y-3 border-b border-border pb-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  placeholder="Rule name (e.g. Global Connection Check)"
                  aria-label="Rule name"
                  value={rName}
                  onChange={(e) => setRName(e.target.value)}
                  className="rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
                />
                <select
                  aria-label="Alert metric"
                  value={rMetric}
                  onChange={(e) => setRMetric(e.target.value as RuleMetric)}
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
                    aria-label="Rule scope"
                    value={rScope}
                    onChange={(e) => {
                      const nextScope = e.target.value as RuleScope;
                      setRScope(nextScope);
                      if (nextScope !== "target") setRTargetId("");
                      if (nextScope !== "group") setRGroupId("");
                    }}
                    className="rounded border border-border bg-canvas px-2 py-1.5 text-xs text-zinc-100"
                  >
                    <option value="target">Single Target</option>
                    <option value="group">Target Group</option>
                    <option value="global">All Targets (Global)</option>
                  </select>
                )}

                {rMetric !== "probe_offline" && rScope === "target" && (
                  <select
                    aria-label="Target"
                    value={rTargetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setRTargetId(nextId);
                      const t = targetMap.get(nextId);
                      if (t) {
                        const cnt = getEffectiveProbeCount(t);
                        if (cnt > 0 && cnt < rQuorum) {
                          setRQuorum(cnt);
                        }
                      }
                    }}
                    className="rounded border border-border bg-canvas px-2 py-1.5 text-xs text-zinc-100"
                  >
                    <option value="">Select Target...</option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}

                {rMetric !== "probe_offline" && rScope === "group" && (
                  <select
                    aria-label="Target group"
                    value={rGroupId}
                    onChange={(e) => setRGroupId(e.target.value)}
                    className="rounded border border-border bg-canvas px-2 py-1.5 text-xs text-zinc-100"
                  >
                    <option value="">Select Group...</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}

                {rMetric !== "probe_offline" && rScope === "global" && (
                  <div className="flex items-center rounded border border-dashed border-border bg-canvas/50 px-2 py-1.5 text-[11px] text-zinc-400">
                    All active targets
                  </div>
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

              {formQuorumTooHigh && (
                <p
                  role="status"
                  data-testid="alert-quorum-warning"
                  className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    Target &ldquo;{selectedTarget?.name}&rdquo; is only assigned to{" "}
                    {selectedTargetProbeCount} probe(s); quorum {rQuorum} will never trigger.
                  </span>
                </p>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span>Window (s):</span>
                  <input
                    type="number"
                    min={5}
                    aria-label="Evaluation window seconds"
                    value={rDuration}
                    onChange={(e) => setRDuration(Number(e.target.value))}
                    className="w-24 rounded border border-border bg-canvas px-2 py-1 font-mono text-zinc-100"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span>Repeat reminder:</span>
                  <select
                    aria-label="Repeat reminder"
                    value={rCooldownSec}
                    onChange={(e) => setRCooldownSec(Number(e.target.value))}
                    className="rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-100"
                  >
                    <option value={0}>Off (Once + Restored)</option>
                    <option value={300}>Every 5 min</option>
                    <option value={900}>Every 15 min</option>
                    <option value={1800}>Every 30 min</option>
                    <option value={3600}>Every 1 hour</option>
                    {![0, 300, 900, 1800, 3600].includes(rCooldownSec) && (
                      <option value={rCooldownSec}>Every {rCooldownSec}s</option>
                    )}
                  </select>
                </label>

                <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span>Confirm after (anti-blip):</span>
                  <select
                    aria-label="Confirm delay"
                    value={rConfirmSec}
                    onChange={(e) => setRConfirmSec(Number(e.target.value))}
                    className="rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-100"
                  >
                    <option value={0}>Auto (25s Down / 60s Warn)</option>
                    <option value={10}>10s (Fast)</option>
                    <option value={25}>25s (Down default)</option>
                    <option value={60}>60s (Intermittent)</option>
                    <option value={120}>2 min</option>
                    <option value={300}>5 min</option>
                    {![0, 10, 25, 60, 120, 300].includes(rConfirmSec) && (
                      <option value={rConfirmSec}>{rConfirmSec}s (custom)</option>
                    )}
                  </select>
                </label>

                <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span>Recover after (anti-flap):</span>
                  <select
                    aria-label="Recovery delay"
                    value={rRecoverSec}
                    onChange={(e) => setRRecoverSec(Number(e.target.value))}
                    className="rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-100"
                  >
                    <option value={45}>45s stable (Recommended)</option>
                    <option value={0}>Instant (0s)</option>
                    <option value={30}>30s stable</option>
                    <option value={60}>60s stable</option>
                    <option value={120}>2 min stable</option>
                    {![0, 30, 45, 60, 120].includes(rRecoverSec) && (
                      <option value={rRecoverSec}>{rRecoverSec}s (custom)</option>
                    )}
                  </select>
                </label>
              </div>

              {channels.length > 0 && (
                <div className="space-y-1.5 rounded border border-border/70 bg-canvas/50 p-2.5">
                  <p className="text-[11px] text-zinc-400">
                    Target Channels (optional — empty sends to all enabled channels):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {channels.map((ch) => {
                      const checked = rChannelIds.includes(ch.id);
                      return (
                        <label
                          key={ch.id}
                          className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${
                            checked
                              ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                              : "border-border bg-elevated/40 text-zinc-300"
                          }`}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Route to channel ${ch.name}`}
                            checked={checked}
                            onChange={(e) => {
                              setRChannelIds((prev) =>
                                e.target.checked
                                  ? [...prev, ch.id]
                                  : prev.filter((id) => id !== ch.id)
                              );
                            }}
                          />
                          <span>{ch.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{editingRuleId ? "Update Rule" : "Add Rule"}</span>
                </button>
              </div>
            </form>

            <div className="space-y-2">
              {rules.map((r) => {
                const ruleTarget = r.target_id ? targetMap.get(r.target_id) : undefined;
                const ruleGroup = r.group_id ? groupMap.get(r.group_id) : undefined;
                const ruleProbeCnt = ruleTarget ? getEffectiveProbeCount(ruleTarget) : null;
                const quorumUnreachable =
                  r.metric !== "probe_offline" &&
                  ruleProbeCnt !== null &&
                  ruleProbeCnt > 0 &&
                  r.quorum_min_probes > ruleProbeCnt;
                const scopeLabel =
                  r.metric === "probe_offline"
                    ? "FLEET PROBES"
                    : r.target_id
                    ? `TARGET: ${ruleTarget?.name ?? r.target_id}`
                    : r.group_id
                    ? `GROUP: ${ruleGroup?.name ?? r.group_id}`
                    : "GLOBAL (ALL TARGETS)";
                const routedNames = (r.channel_ids ?? [])
                  .map((cid) => channelMap.get(cid)?.name)
                  .filter(Boolean);

                return (
                  <div
                    key={r.id}
                    className={`flex items-center justify-between gap-2 rounded border border-border bg-elevated/40 px-3 py-2 text-xs ${
                      !r.enabled ? "opacity-60" : ""
                    }`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="font-semibold text-zinc-100">{r.name}</p>
                        <span className="rounded border border-border bg-canvas px-1.5 py-0.5 text-[10px] font-mono text-zinc-300">
                          {scopeLabel}
                        </span>
                        {!r.enabled && (
                          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] font-mono text-zinc-300">
                            DISABLED
                          </span>
                        )}
                        {quorumUnreachable && (
                          <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono text-amber-300">
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            <span>
                              Quorum {r.quorum_min_probes} &gt; {ruleProbeCnt} probe(s)
                            </span>
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-[11px] text-zinc-400">
                        {r.metric === "latency_p95" ? "High Latency (P95)" : r.metric} &gt;={" "}
                        {r.threshold_value} · {r.duration_sec}s · quorum{" "}
                        {r.quorum_min_probes} · confirm{" "}
                        {(r.confirm_sec ?? 0) === 0 ? "auto (25s/60s)" : `${r.confirm_sec}s`}{" "}
                        · recover {(r.recover_sec ?? 45)}s ·{" "}
                        {r.cooldown_sec === 0
                          ? "once + restored"
                          : `repeat ${r.cooldown_sec}s`}
                        {routedNames.length > 0 ? ` · to: ${routedNames.join(", ")}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        aria-label={`${r.enabled ? "Disable" : "Enable"} rule ${r.name}`}
                        onClick={() => void handleToggleRule(r)}
                        title={r.enabled ? "Disable rule" : "Enable rule"}
                        className={`rounded p-1 ${
                          r.enabled
                            ? "text-emerald-400 hover:bg-emerald-500/10"
                            : "text-zinc-500 hover:bg-zinc-800"
                        }`}
                      >
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Edit rule ${r.name}`}
                        onClick={() => startEditRule(r)}
                        className="rounded p-1 text-zinc-400 hover:text-cyan-300"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete rule ${r.name}`}
                        onClick={async () => {
                          await apiRequest(`/api/alerts/rules/${r.id}`, {
                            method: "DELETE",
                          });
                          if (editingRuleId === r.id) resetRuleForm();
                          await loadAlerts();
                        }}
                        className="rounded p-1 text-zinc-500 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Notification Channels */}
          <section className="rounded-lg border border-border bg-surface p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">
                {editingChannelId
                  ? "Edit Notification Channel"
                  : "Notification Channels (Telegram & Webhook)"}
              </h2>
              {editingChannelId && (
                <button
                  type="button"
                  onClick={resetChannelForm}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-zinc-300 hover:bg-elevated"
                >
                  <X className="h-3 w-3" />
                  <span>Cancel</span>
                </button>
              )}
            </div>

            <form
              onSubmit={handleSaveChannel}
              className="space-y-3 border-b border-border pb-4"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  aria-label="Channel type"
                  disabled={Boolean(editingChannelId)}
                  value={cType}
                  onChange={(e) => setCType(e.target.value as "telegram" | "webhook")}
                  className="rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100 disabled:opacity-60"
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
                <div className="grid gap-2 sm:grid-cols-3">
                  <input
                    type="password"
                    placeholder={
                      editingChannelId
                        ? "Bot Token (blank = keep)"
                        : "Bot Token"
                    }
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
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Thread ID (optional)"
                    aria-label="Telegram thread ID"
                    value={cThreadId}
                    onChange={(e) => setCThreadId(e.target.value)}
                    className="rounded border border-border bg-canvas px-3 py-1.5 text-xs font-mono text-zinc-100"
                  />
                </div>
              ) : (
                <input
                  type="url"
                  placeholder={
                    editingChannelId
                      ? "Webhook URL (leave blank to keep existing)"
                      : "https://discord.com/api/webhooks/..."
                  }
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
                  <span>{editingChannelId ? "Update Channel" : "Save Channel"}</span>
                </button>
              </div>
            </form>

            <div className="space-y-2">
              {channels.map((c) => (
                <div
                  key={c.id}
                  className={`flex items-center justify-between gap-2 rounded border border-border bg-elevated/40 px-3 py-2 text-xs ${
                    !c.enabled ? "opacity-60" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-zinc-100">
                      {c.name}{" "}
                      <span className="ml-1 font-mono uppercase text-[10px] text-cyan-400">
                        {c.type}
                      </span>
                      {!c.enabled && (
                        <span className="ml-1.5 rounded bg-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                          DISABLED
                        </span>
                      )}
                    </p>
                    <p className="truncate font-mono text-[11px] text-zinc-400">
                      {c.config_hint}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
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
                      aria-label={`${c.enabled ? "Disable" : "Enable"} channel ${c.name}`}
                      onClick={() => void handleToggleChannel(c)}
                      title={c.enabled ? "Disable channel" : "Enable channel"}
                      className={`rounded p-1 ${
                        c.enabled
                          ? "text-emerald-400 hover:bg-emerald-500/10"
                          : "text-zinc-500 hover:bg-zinc-800"
                      }`}
                    >
                      <Power className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Edit channel ${c.name}`}
                      onClick={() => startEditChannel(c)}
                      className="rounded p-1 text-zinc-400 hover:text-cyan-300"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete channel ${c.name}`}
                      onClick={async () => {
                        await apiRequest(`/api/alerts/channels/${c.id}`, {
                          method: "DELETE",
                        });
                        if (editingChannelId === c.id) resetChannelForm();
                        await loadAlerts();
                      }}
                      className="rounded p-1 text-zinc-500 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
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
