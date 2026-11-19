"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  Pencil,
  Plus,
  Power,
  Send,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import { formatDateTime24 } from "@/lib/date-format";
import {
  formatMs,
  resolveTargetBestPathSummary,
} from "@/lib/smoke-math";
import {
  ApiError,
  apiRequest,
  type AlertChannel,
  type AlertRule,
  type Incident,
  type MatrixCell,
  type MatrixSnapshot,
  type Probe,
  type SystemSettings,
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

interface RuleMetricMeta {
  label: string;
  shortLabel: string;
  unit: string;
  thresholdLabel: string;
  defaultThreshold: number;
  severityHint: string;
  warnOnly: boolean;
  usesThreshold: boolean;
}

const RULE_METRIC_META: Record<RuleMetric, RuleMetricMeta> = {
  loss_pct: {
    label: "Packet Loss (%)",
    shortLabel: "Packet Loss",
    unit: "%",
    thresholdLabel: "Loss Threshold (%)",
    defaultThreshold: 20,
    severityHint: "< 50% triggers WARN · >= 50% triggers CRITICAL (DOWN)",
    warnOnly: false,
    usesThreshold: true,
  },
  latency_p95: {
    label: "High Latency (P95)",
    shortLabel: "Latency (P95)",
    unit: "ms",
    thresholdLabel: "Threshold (ms · 0 = Auto)",
    defaultThreshold: 50,
    severityHint: "WARN severity · 0 = Auto Best-Path per probe/target",
    warnOnly: true,
    usesThreshold: true,
  },
  baseline_spike_pct: {
    label: "Baseline Spike % (Auto Best-Path)",
    shortLabel: "Baseline Spike",
    unit: "%",
    thresholdLabel: "Spike Above Baseline (%)",
    defaultThreshold: 100,
    severityHint: "WARN when latency jumps % above learned P25 best-path",
    warnOnly: true,
    usesThreshold: true,
  },
  jitter: {
    label: "Avg Jitter (ms)",
    shortLabel: "Avg Jitter",
    unit: "ms",
    thresholdLabel: "Jitter Threshold (ms)",
    defaultThreshold: 20,
    severityHint: "WARN when average delay variation hits threshold",
    warnOnly: true,
    usesThreshold: true,
  },
  probe_offline: {
    label: "Probe Offline (sec)",
    shortLabel: "Probe Offline",
    unit: "s",
    thresholdLabel: "Threshold (Uses Window)",
    defaultThreshold: 0,
    severityHint: "CRITICAL (DOWN) when probe stays offline >= Window (s)",
    warnOnly: false,
    usesThreshold: false,
  },
};

function formatRuleConditionSummary(
  metric: RuleMetric,
  thresholdValue: number,
  durationSec: number
): string {
  const meta = RULE_METRIC_META[metric];
  if (metric === "probe_offline") {
    return `${meta.shortLabel} >= ${durationSec}s`;
  }
  if (metric === "latency_p95" && thresholdValue <= 0) {
    return `${meta.shortLabel} >= Auto Best-Path`;
  }
  if (meta.unit === "%") {
    return `${meta.shortLabel} >= ${thresholdValue}%`;
  }
  return `${meta.shortLabel} >= ${thresholdValue} ${meta.unit}`;
}

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
  const [matrixCells, setMatrixCells] = useState<MatrixCell[]>([]);
  const [alertingEnabled, setAlertingEnabled] = useState(true);
  const [togglingAlerting, setTogglingAlerting] = useState(false);
  const [clearingIncidents, setClearingIncidents] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  const handledQueryPrefillRef = useRef(false);

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
  const [cSeverityFilter, setCSeverityFilter] = useState<"all" | "critical">("all");
  const [cEnabled, setCEnabled] = useState(true);

  // Target Maintenance Mute form
  const [muteTargetId, setMuteTargetId] = useState("");
  const [muteDuration, setMuteDuration] = useState("1h");

  const loadAlerts = useCallback(async () => {
    try {
      const [incRes, ruleRes, chanRes, tRes, pRes, gRes, mRes, settingsRes] = await Promise.all([
        apiRequest<Incident[]>("/api/alerts/incidents"),
        apiRequest<AlertRule[]>("/api/alerts/rules"),
        apiRequest<AlertChannel[]>("/api/alerts/channels"),
        apiRequest<Target[]>("/api/targets"),
        apiRequest<Probe[]>("/api/probes"),
        apiRequest<TargetGroup[]>("/api/groups").catch(() => [] as TargetGroup[]),
        apiRequest<MatrixSnapshot>("/api/matrix").catch(() => null as MatrixSnapshot | null),
        apiRequest<SystemSettings>("/api/settings").catch(() => null as SystemSettings | null),
      ]);
      const loadedProbes = Array.isArray(pRes) ? pRes : [];
      setIncidents(Array.isArray(incRes) ? incRes : []);
      setRules(Array.isArray(ruleRes) ? ruleRes : []);
      setChannels(Array.isArray(chanRes) ? chanRes : []);
      setTargets(Array.isArray(tRes) ? tRes : []);
      setProbes(loadedProbes);
      setGroups(Array.isArray(gRes) ? gRes : []);
      setMatrixCells(Array.isArray(mRes?.cells) ? mRes.cells : []);
      setAlertingEnabled(settingsRes?.alerting_enabled ?? true);

      const activeFleetCount =
        loadedProbes.filter((p) => p.status !== "offline").length || loadedProbes.length;
      if (activeFleetCount <= 1) {
        setRQuorum((prev) => (editingRuleId ? prev : 1));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
      }
    } finally {
      setLoading(false);
    }
  }, [router, editingRuleId]);

  const targetMap = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const channelMap = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);

  const activeProbeCount = useMemo(() => {
    const online = probes.filter((p) => p.status !== "offline").length;
    return online > 0 ? online : probes.length;
  }, [probes]);
  const defaultFleetQuorum = activeProbeCount <= 1 ? 1 : 2;

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

  const selectedBestPath = useMemo(() => {
    if (!selectedTarget) return null;
    return resolveTargetBestPathSummary(selectedTarget, matrixCells, probes);
  }, [selectedTarget, matrixCells, probes]);

  const computeRecommendedThreshold = useCallback(
    (metric: RuleMetric, scope: RuleScope, targetId: string): number => {
      if (metric === "latency_p95") {
        if (scope === "target" && targetId) {
          const tgt = targetMap.get(targetId);
          if (tgt) {
            return resolveTargetBestPathSummary(tgt, matrixCells, probes)
              .recommendedRuleThresholdMs;
          }
        }
        return 0; // Auto Best-Path per target & probe for Group / Global
      }
      return RULE_METRIC_META[metric].defaultThreshold;
    },
    [targetMap, matrixCells, probes]
  );

  useEffect(() => {
    if (loading || handledQueryPrefillRef.current || targets.length === 0) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const qTargetId = params.get("target_id");
    const qMetric = params.get("metric") as RuleMetric | null;
    const qThreshold = params.get("threshold");
    if (!qTargetId && !qMetric && !qThreshold) return;
    handledQueryPrefillRef.current = true;

    const validMetric: RuleMetric =
      qMetric && qMetric in RULE_METRIC_META ? qMetric : "latency_p95";
    setRMetric(validMetric);
    if (qTargetId && targetMap.has(qTargetId)) {
      const tgt = targetMap.get(qTargetId)!;
      setRScope("target");
      setRTargetId(qTargetId);
      setRGroupId("");
      setRName(`${tgt.name} RTT Alert`);
      const pCount = getEffectiveProbeCount(tgt);
      if (pCount > 0 && pCount < rQuorum) {
        setRQuorum(pCount);
      }
      if (qThreshold !== null && qThreshold !== "" && Number.isFinite(Number(qThreshold))) {
        setRThreshold(Number(qThreshold));
      } else {
        setRThreshold(
          resolveTargetBestPathSummary(tgt, matrixCells, probes)
            .recommendedRuleThresholdMs
        );
      }
    } else if (qThreshold !== null && qThreshold !== "" && Number.isFinite(Number(qThreshold))) {
      setRThreshold(Number(qThreshold));
    }
  }, [loading, targets, targetMap, matrixCells, probes, getEffectiveProbeCount, rQuorum]);

  const mutedTargets = useMemo(() => {
    const nowMs = Date.now();
    return targets.filter(
      (t) => t.muted_until && new Date(t.muted_until).getTime() > nowMs
    );
  }, [targets]);

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
    setRQuorum(defaultFleetQuorum);
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
    setCSeverityFilter("all");
    setCEnabled(true);
  }

  function startEditChannel(ch: AlertChannel) {
    setEditingChannelId(ch.id);
    setCType(ch.type);
    setCName(ch.name);
    setCBotToken("");
    setCWebhookUrl("");
    setCSeverityFilter(ch.severity_filter === "critical" ? "critical" : "all");
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
        const existingCh = channels.find((c) => c.id === editingChannelId);
        const includeSeverity =
          cSeverityFilter !== (existingCh?.severity_filter ?? "all") ||
          Boolean(existingCh?.severity_filter);
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
            ...(includeSeverity ? { severity_filter: cSeverityFilter } : {}),
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
            ...(cSeverityFilter !== "all" ? { severity_filter: cSeverityFilter } : {}),
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

  async function handleToggleAlertingMaster() {
    setFeedback(null);
    setTogglingAlerting(true);
    const nextEnabled = !alertingEnabled;
    try {
      const updated = await apiRequest<SystemSettings>("/api/alerts/status", {
        method: "PUT",
        body: JSON.stringify({ alerting_enabled: nextEnabled }),
      });
      setAlertingEnabled(updated?.alerting_enabled ?? nextEnabled);
      setFeedback(
        nextEnabled
          ? "Alerting & Incident History enabled — alert rules are actively evaluated."
          : "Alerting & Incident History turned OFF — no new incidents or notifications will be triggered while monitoring continues."
      );
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to update alerting status");
    } finally {
      setTogglingAlerting(false);
    }
  }

  async function handleAcknowledgeIncident(inc: Incident) {
    setFeedback(null);
    try {
      await apiRequest(`/api/alerts/incidents/${inc.id}/ack`, {
        method: "POST",
      });
      setFeedback("Incident acknowledged — repeat reminders silenced.");
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to acknowledge incident");
    }
  }

  async function handleCloseIncident(inc: Incident) {
    setFeedback(null);
    try {
      await apiRequest(`/api/alerts/incidents/${inc.id}/close`, {
        method: "POST",
      });
      setFeedback(
        "Incident manually closed. If the target is still impaired and the rule remains enabled, it may reopen after the confirm delay unless muted or set to Monitoring Only."
      );
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to close incident");
    }
  }

  async function handleClearIncidents(scope: "resolved" | "all") {
    setFeedback(null);
    setClearingIncidents(true);
    try {
      const res = await apiRequest<{ deleted: number; scope: string }>(
        `/api/alerts/incidents?scope=${scope}`,
        { method: "DELETE" }
      );
      setFeedback(
        scope === "all"
          ? `Cleared all incident history (${res?.deleted ?? 0} removed).`
          : `Cleared resolved incident history (${res?.deleted ?? 0} removed).`
      );
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to clear incident history");
    } finally {
      setClearingIncidents(false);
    }
  }

  async function handleMuteTarget(targetId: string, duration: string) {
    if (!targetId) return;
    setFeedback(null);
    try {
      await apiRequest(`/api/targets/${targetId}/mute`, {
        method: "POST",
        body: JSON.stringify({ duration }),
      });
      setFeedback(
        duration === "off"
          ? "Target maintenance mute cleared."
          : `Target alerts muted for ${duration}.`
      );
      await loadAlerts();
    } catch (err) {
      setFeedback(err instanceof ApiError ? err.detail : "Failed to update target mute");
    }
  }

  const openCount = incidents.filter((i) => i.status === "open").length;
  const resolvedCount = incidents.length - openCount;

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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <Bell className="h-4 w-4 text-rose-400" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-zinc-100">Incident History</h2>
              <button
                type="button"
                role="switch"
                aria-checked={alertingEnabled}
                aria-label="Toggle alerting and incident history"
                data-testid="alerting-master-toggle"
                disabled={togglingAlerting}
                onClick={() => void handleToggleAlertingMaster()}
                className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-mono font-semibold transition-colors disabled:opacity-50 ${
                  alertingEnabled
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                    : "border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    alertingEnabled ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
                <span>{alertingEnabled ? "Alerting: ON" : "Alerting: OFF"}</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {incidents.length > 0 && (
                <div className="flex items-center gap-1.5">
                  {resolvedCount > 0 && (
                    <button
                      type="button"
                      disabled={clearingIncidents}
                      aria-label="Clear resolved incident history"
                      onClick={() => void handleClearIncidents("resolved")}
                      className="inline-flex items-center gap-1 rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      <span>Clear Resolved</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={clearingIncidents}
                    aria-label="Clear all incident history"
                    onClick={() => void handleClearIncidents("all")}
                    className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                    <span>Clear All</span>
                  </button>
                </div>
              )}

              {targets.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <BellOff className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                  <select
                    aria-label="Mute target"
                    value={muteTargetId}
                    onChange={(e) => setMuteTargetId(e.target.value)}
                    className="rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-200"
                  >
                    <option value="">Maintenance Mute Target...</option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Mute duration"
                    value={muteDuration}
                    onChange={(e) => setMuteDuration(e.target.value)}
                    className="rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-200"
                  >
                    <option value="15m">15 min</option>
                    <option value="1h">1 hour</option>
                    <option value="4h">4 hours</option>
                    <option value="24h">24 hours</option>
                    <option value="off">Unmute</option>
                  </select>
                  <button
                    type="button"
                    disabled={!muteTargetId}
                    onClick={() => void handleMuteTarget(muteTargetId, muteDuration)}
                    className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                  >
                    <span>Apply Mute</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {!alertingEnabled && (
            <div
              data-testid="alerting-paused-banner"
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
            >
              <div className="flex items-center gap-2">
                <BellOff className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                <span>
                  <strong>Alerting &amp; Incident History is OFF.</strong> Probes, live graphs, and NOC TV continue monitoring normally, but no new incidents will be recorded and no Telegram/Webhook alerts will be sent.
                </span>
              </div>
            </div>
          )}

          {mutedTargets.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <span className="font-semibold">Muted Targets:</span>
              {mutedTargets.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1.5 rounded border border-amber-500/40 bg-canvas/70 px-2 py-0.5 font-mono text-[11px]"
                >
                  <span>
                    {t.name} (until {formatDateTime24(t.muted_until!)})
                  </span>
                  <button
                    type="button"
                    aria-label={`Unmute target ${t.name}`}
                    onClick={() => void handleMuteTarget(t.id, "off")}
                    className="text-amber-300 hover:text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

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
                    <th className="py-2 pr-4">SLA DURATION</th>
                    <th className="py-2 text-right">ACTIONS</th>
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
                          {inc.acknowledged_at && (
                            <span
                              title={`Acknowledged${inc.acknowledged_by ? ` by ${inc.acknowledged_by}` : ""}`}
                              className="rounded border border-cyan-500/40 bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-mono text-cyan-200"
                            >
                              ACK
                            </span>
                          )}
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
                      <td className="py-2 pr-4 text-zinc-300">
                        {formatDurationSeconds(inc.started_at, inc.resolved_at)}
                      </td>
                      <td className="py-2 text-right">
                        {inc.status === "open" && (
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {!inc.acknowledged_at && (
                              <button
                                type="button"
                                aria-label={`Acknowledge incident ${inc.id}`}
                                onClick={() => void handleAcknowledgeIncident(inc)}
                                className="inline-flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 font-sans text-[11px] text-cyan-200 hover:bg-cyan-500/20"
                              >
                                <Check className="h-3 w-3" aria-hidden="true" />
                                <span>Acknowledge</span>
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label={`Close incident ${inc.id}`}
                              onClick={() => void handleCloseIncident(inc)}
                              className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 font-sans text-[11px] text-rose-200 hover:bg-rose-500/20"
                            >
                              <XCircle className="h-3 w-3" aria-hidden="true" />
                              <span>Close</span>
                            </button>
                          </div>
                        )}
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

            <form onSubmit={handleSaveRule} className="space-y-3.5 border-b border-border pb-4">
              {!editingRuleId && (
                <div className="flex flex-wrap items-center gap-1.5 rounded border border-border/70 bg-canvas/60 px-2.5 py-2 text-[11px]">
                  <span className="inline-flex items-center gap-1 font-mono font-semibold text-zinc-400">
                    <Sparkles className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                    Presets:
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRMetric("loss_pct");
                      setRThreshold(50);
                      setRConfirmSec(25);
                    }}
                    className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 font-mono text-rose-200 hover:bg-rose-500/20"
                  >
                    Down (Loss &ge; 50%)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRMetric("loss_pct");
                      setRThreshold(20);
                      setRConfirmSec(0);
                    }}
                    className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-amber-200 hover:bg-amber-500/20"
                  >
                    Loss Warn (&ge; 20%)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRMetric("latency_p95");
                      setRConfirmSec(0);
                      setRThreshold(computeRecommendedThreshold("latency_p95", rScope, rTargetId));
                    }}
                    className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 font-mono text-cyan-200 hover:bg-cyan-500/20"
                  >
                    RTT Best-Path (P95)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRConfirmSec(10);
                      setRRecoverSec(0);
                    }}
                    className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-emerald-200 hover:bg-emerald-500/20"
                  >
                    Fast 10s Test
                  </button>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs">
                  <span className="block font-medium text-zinc-300">Rule Name</span>
                  <input
                    type="text"
                    placeholder="Rule name (e.g. Global Connection Check)"
                    aria-label="Rule name"
                    value={rName}
                    onChange={(e) => setRName(e.target.value)}
                    className="w-full rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
                  />
                </label>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-zinc-300">Condition Metric</span>
                    <span className="font-mono text-[10px] text-zinc-400">
                      {RULE_METRIC_META[rMetric].severityHint}
                    </span>
                  </div>
                  <select
                    aria-label="Alert metric"
                    value={rMetric}
                    onChange={(e) => {
                      const nextMetric = e.target.value as RuleMetric;
                      setRMetric(nextMetric);
                      if (!editingRuleId) {
                        setRThreshold(
                          computeRecommendedThreshold(nextMetric, rScope, rTargetId)
                        );
                      }
                    }}
                    className="w-full rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
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
              </div>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {rMetric !== "probe_offline" && (
                  <label className="block space-y-1 text-xs">
                    <span className="block font-medium text-zinc-300">Rule Scope</span>
                    <select
                      aria-label="Rule scope"
                      value={rScope}
                      onChange={(e) => {
                        const nextScope = e.target.value as RuleScope;
                        setRScope(nextScope);
                        if (nextScope !== "target") setRTargetId("");
                        if (nextScope !== "group") setRGroupId("");
                        if (activeProbeCount <= 1 && rQuorum > 1) {
                          setRQuorum(1);
                        }
                        if (!editingRuleId && rMetric === "latency_p95") {
                          setRThreshold(
                            computeRecommendedThreshold(
                              "latency_p95",
                              nextScope,
                              nextScope === "target" ? rTargetId : ""
                            )
                          );
                        }
                      }}
                      className="w-full rounded border border-border bg-canvas px-2 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="target">Single Target</option>
                      <option value="group">Target Group</option>
                      <option value="global">All Targets (Global)</option>
                    </select>
                  </label>
                )}

                {rMetric !== "probe_offline" && rScope === "target" && (
                  <label className="block space-y-1 text-xs">
                    <span className="block font-medium text-zinc-300">Target</span>
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
                        if (!editingRuleId && rMetric === "latency_p95") {
                          setRThreshold(
                            computeRecommendedThreshold("latency_p95", "target", nextId)
                          );
                        }
                      }}
                      className="w-full rounded border border-border bg-canvas px-2 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="">Select Target...</option>
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.alerts_enabled === false ? " (Monitor Only)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {rMetric !== "probe_offline" && rScope === "group" && (
                  <label className="block space-y-1 text-xs">
                    <span className="block font-medium text-zinc-300">Target Group</span>
                    <select
                      aria-label="Target group"
                      value={rGroupId}
                      onChange={(e) => setRGroupId(e.target.value)}
                      className="w-full rounded border border-border bg-canvas px-2 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="">Select Group...</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {rMetric !== "probe_offline" && rScope === "global" && (
                  <div className="space-y-1 text-xs">
                    <span className="block font-medium text-zinc-300">Target Scope</span>
                    <div className="flex items-center rounded border border-dashed border-border bg-canvas/50 px-2 py-1.5 text-[11px] text-zinc-400">
                      All active targets
                    </div>
                  </div>
                )}

                <div className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-zinc-300">
                      {RULE_METRIC_META[rMetric].thresholdLabel}
                    </span>
                    {rMetric === "latency_p95" && Number(rThreshold) === 0 && (
                      <span
                        data-testid="alert-auto-bestpath-badge"
                        className="rounded bg-cyan-500/15 px-1.5 py-0 text-[10px] font-mono text-cyan-300"
                      >
                        AUTO
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      disabled={!RULE_METRIC_META[rMetric].usesThreshold}
                      aria-label="Threshold"
                      value={rThreshold}
                      onChange={(e) => setRThreshold(Number(e.target.value))}
                      placeholder="Threshold"
                      className="w-full rounded border border-border bg-canvas px-2 py-1.5 pr-10 text-xs font-mono text-zinc-100 disabled:opacity-50"
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-zinc-400">
                      {RULE_METRIC_META[rMetric].usesThreshold
                        ? RULE_METRIC_META[rMetric].unit
                        : "Win"}
                    </span>
                  </div>
                </div>

                <div className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-zinc-300">Min. Probes</span>
                    <span className="font-mono text-[10px] text-zinc-400">
                      of {selectedTargetProbeCount ?? activeProbeCount}
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      min={1}
                      aria-label="Quorum min probes"
                      value={rQuorum}
                      onChange={(e) => setRQuorum(Number(e.target.value))}
                      placeholder="Quorum N"
                      className="w-full rounded border border-border bg-canvas px-2 py-1.5 pr-12 text-xs font-mono text-zinc-100"
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-zinc-500">
                      probes
                    </span>
                  </div>
                </div>
              </div>

              {rMetric === "latency_p95" && (
                <div
                  data-testid="alert-bestpath-helper"
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-2 text-[11px]"
                >
                  {rScope === "target" && selectedTarget && selectedBestPath ? (
                    <>
                      <div className="font-mono text-cyan-200 space-y-0.5">
                        <div>
                          Best-Path:{" "}
                          {selectedBestPath.probeEntries.length > 0
                            ? selectedBestPath.probeEntries
                                .map(
                                  (e) =>
                                    `${e.probeName} (${
                                      e.baselineMs !== null
                                        ? `P25 ${formatMs(e.baselineMs)}`
                                        : "no P25 yet"
                                    } → ~${Math.round(e.effectiveWarnMs)} ms)`
                                )
                                .join(" · ")
                            : "No probe assigned"}
                        </div>
                        {selectedTarget.latency_warn_ms > 0 && (
                          <div className="text-[10px] text-amber-200">
                            Target Warn RTT set to {selectedTarget.latency_warn_ms} ms
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        {selectedBestPath.concreteFillMs !== null && (
                          <button
                            type="button"
                            data-testid="alert-use-bestpath-btn"
                            onClick={() =>
                              setRThreshold(selectedBestPath.concreteFillMs!)
                            }
                            className="rounded border border-cyan-400/50 bg-canvas px-2 py-0.5 font-mono text-cyan-200 hover:bg-cyan-500/20"
                          >
                            Use {selectedBestPath.concreteFillMs} ms
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid="alert-use-auto-btn"
                          onClick={() => setRThreshold(0)}
                          className="rounded border border-border bg-canvas px-2 py-0.5 font-mono text-zinc-200 hover:border-cyan-400/50"
                        >
                          Use 0 (Auto)
                        </button>
                      </div>
                    </>
                  ) : (
                    <span className="font-mono text-cyan-200">
                      Scope Group / Global (atau pilih target): nilai 0 otomatis memakai Best-Path Warn RTT masing-masing jalur (target + probe).
                    </span>
                  )}
                </div>
              )}

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

              {selectedTarget?.alerts_enabled === false && (
                <p
                  role="status"
                  data-testid="alert-target-monitor-only-warning"
                  className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300"
                >
                  <BellOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    Target &ldquo;{selectedTarget.name}&rdquo; is set to <strong>Monitoring Only</strong> — alert rules will skip it until &ldquo;Include in Alerting&rdquo; is checked in /targets.
                  </span>
                </p>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span>
                    {rMetric === "probe_offline" ? "Offline Duration (s):" : "Window (s):"}
                  </span>
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
                          <span className="rounded bg-canvas/80 px-1 py-0 text-[9px] font-mono uppercase text-zinc-400">
                            {ch.severity_filter === "critical" ? "CRIT" : "ALL"}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {(() => {
                    if (!RULE_METRIC_META[rMetric].warnOnly) return null;
                    const targeted =
                      rChannelIds.length > 0
                        ? channels.filter((c) => rChannelIds.includes(c.id))
                        : channels.filter((c) => c.enabled);
                    const critChannels = targeted.filter(
                      (c) => c.severity_filter === "critical"
                    );
                    if (critChannels.length === 0) return null;
                    return (
                      <p
                        role="status"
                        data-testid="alert-critical-only-warning"
                        className="flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200"
                      >
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          Channel {critChannels.map((c) => c.name).join(", ")} uses Critical Only (DOWN + OK) and will ignore WARN alerts from {RULE_METRIC_META[rMetric].shortLabel}.
                        </span>
                      </p>
                    );
                  })()}
                </div>
              )}

              <div
                data-testid="alert-rule-preview"
                className="rounded border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-zinc-200"
              >
                <span className="font-mono font-semibold text-emerald-300">Trigger Preview: </span>
                <span>
                  {(() => {
                    const sevLabel =
                      rMetric === "probe_offline" || (rMetric === "loss_pct" && Number(rThreshold) >= 50)
                        ? "[DOWN]"
                        : rMetric === "loss_pct"
                        ? "[WARN / DOWN >= 50%]"
                        : "[WARN]";
                    const scopeDesc =
                      rMetric === "probe_offline"
                        ? "Fleet Probes"
                        : rScope === "target"
                        ? selectedTarget?.name ?? "Selected Target"
                        : rScope === "group"
                        ? groups.find((g) => g.id === rGroupId)?.name ?? "Selected Group"
                        : "All Active Targets";
                    const destNames =
                      rChannelIds.length > 0
                        ? rChannelIds
                            .map((cid) => channelMap.get(cid)?.name)
                            .filter(Boolean)
                            .join(", ")
                        : "All enabled channels";
                    const confirmDesc =
                      rConfirmSec === 0
                        ? rMetric === "probe_offline" || (rMetric === "loss_pct" && Number(rThreshold) >= 50)
                          ? "25s (Auto Down)"
                          : "60s (Auto Warn)"
                        : `${rConfirmSec}s`;
                    return `Send ${sevLabel} to ${destNames || "All enabled channels"} when ${scopeDesc} hits ${formatRuleConditionSummary(
                      rMetric,
                      Number(rThreshold) || 0,
                      Number(rDuration) || 30
                    )} on >= ${rQuorum} probe(s) (confirm ${confirmDesc}, recover ${rRecoverSec}s).`;
                  })()}
                </span>
              </div>

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
                        {formatRuleConditionSummary(r.metric, r.threshold_value, r.duration_sec)}{" "}
                        · {r.duration_sec}s window · quorum {r.quorum_min_probes} · confirm{" "}
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
              <div className="grid gap-2 sm:grid-cols-3">
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
                <select
                  aria-label="Channel severity filter"
                  value={cSeverityFilter}
                  onChange={(e) =>
                    setCSeverityFilter(e.target.value as "all" | "critical")
                  }
                  className="rounded border border-border bg-canvas px-3 py-1.5 text-xs text-zinc-100"
                >
                  <option value="all">All Alerts (WARN + DOWN + OK)</option>
                  <option value="critical">Critical Only (DOWN + OK)</option>
                </select>
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
                      {c.severity_filter === "critical" && (
                        <span className="ml-1.5 rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] text-rose-300">
                          CRITICAL ONLY
                        </span>
                      )}
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
