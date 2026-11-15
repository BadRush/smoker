"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Copy,
  Flame,
  FolderPlus,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import {
  ApiError,
  apiRequest,
  type Probe,
  type Target,
  type TargetGroup,
  type TargetInput,
} from "@/lib/api";

export default function TargetsPage() {
  const router = useRouter();
  const [targets, setTargets] = useState<Target[]>([]);
  const [groups, setGroups] = useState<TargetGroup[]>([]);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Target Form Modal
  const [showTargetModal, setShowTargetModal] = useState(false);
  const [editingTarget, setEditingTarget] = useState<Target | null>(null);
  const [tName, setTName] = useState("");
  const [tHost, setTHost] = useState("");
  const [tType, setTType] = useState<"icmp" | "tcp" | "http" | "dns">("icmp");
  const [tPortOrPath, setTPortOrPath] = useState("");
  const [tGroupId, setTGroupId] = useState<string>("");
  const [tInterval, setTInterval] = useState(1);
  const [tTimeout, setTTimeout] = useState(1000);
  const [tEnabled, setTEnabled] = useState(true);
  const [tAutoMtr, setTAutoMtr] = useState(true);
  const [tMtrThresh, setTMtrThresh] = useState(3);
  const [tPinnedOnTv, setTPinnedOnTv] = useState(false);
  const [tLatencyWarnMs, setTLatencyWarnMs] = useState(0);
  const [tProbeOverrides, setTProbeOverrides] = useState<Record<string, number>>({});
  const [tAssignAll, setTAssignAll] = useState(true);
  const [tProbeIds, setTProbeIds] = useState<string[]>([]);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [simNotice, setSimNotice] = useState<string | null>(null);

  // Group Form Modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<TargetGroup | null>(null);
  const [gName, setGName] = useState("");
  const [gDesc, setGDesc] = useState("");
  const handledQueryEditRef = useRef(false);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [tRes, gRes, pRes] = await Promise.all([
        apiRequest<Target[]>("/api/targets"),
        apiRequest<TargetGroup[]>("/api/groups"),
        apiRequest<Probe[]>("/api/probes"),
      ]);
      setTargets(tRes);
      setGroups(gRes);
      setProbes(pRes);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load targets");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const populateTargetForm = useCallback((t: Target, asCopy: boolean) => {
    setFormErr(null);
    setEditingTarget(asCopy ? null : t);
    setTName(asCopy ? `${t.name} (Copy)` : t.name);
    setTHost(t.host);
    setTType(t.probe_type);
    setTPortOrPath(t.port_or_path ?? "");
    setTGroupId(t.group_id ?? "");
    setTInterval(t.interval_sec);
    setTTimeout(t.timeout_ms);
    setTEnabled(t.enabled);
    setTAutoMtr(t.auto_mtr_on_loss);
    setTMtrThresh(t.mtr_loss_threshold || 3);
    setTPinnedOnTv(Boolean(t.pinned_on_tv));
    setTLatencyWarnMs(t.latency_warn_ms || 0);
    setTProbeOverrides(t.probe_latency_overrides ?? {});
    setTAssignAll(t.assign_all_probes);
    setTProbeIds(t.probe_ids ?? []);
    setShowTargetModal(true);
  }, []);

  useEffect(() => {
    if (loading || handledQueryEditRef.current || targets.length === 0) return;
    if (typeof window === "undefined") return;
    const editId = new URLSearchParams(window.location.search).get("edit");
    if (!editId) return;
    handledQueryEditRef.current = true;
    const matched = targets.find((t) => t.id === editId);
    if (matched) {
      populateTargetForm(matched, false);
    }
  }, [loading, targets, populateTargetForm]);

  function openCreateTarget() {
    setFormErr(null);
    setEditingTarget(null);
    setTName("");
    setTHost("");
    setTType("icmp");
    setTPortOrPath("");
    setTGroupId("");
    setTInterval(1);
    setTTimeout(1000);
    setTEnabled(true);
    setTAutoMtr(true);
    setTMtrThresh(3);
    setTPinnedOnTv(false);
    setTLatencyWarnMs(0);
    setTProbeOverrides({});
    setTAssignAll(true);
    setTProbeIds([]);
    setShowTargetModal(true);
  }

  function openCreateGroup() {
    setEditingGroup(null);
    setGName("");
    setGDesc("");
    setShowGroupModal(true);
  }

  function openEditGroup(g: TargetGroup) {
    setEditingGroup(g);
    setGName(g.name);
    setGDesc(g.description ?? "");
    setShowGroupModal(true);
  }

  function buildTargetPayload(t: {
    name: string;
    host: string;
    probe_type: TargetInput["probe_type"];
    port_or_path?: string;
    group_id?: string | null;
    interval_sec: number;
    timeout_ms: number;
    enabled: boolean;
    auto_mtr_on_loss: boolean;
    mtr_loss_threshold: number;
    pinned_on_tv?: boolean;
    latency_warn_ms?: number;
    probe_latency_overrides?: Record<string, number>;
    assign_all_probes: boolean;
    probe_ids: string[];
  }): TargetInput {
    return {
      name: t.name.trim(),
      host: t.host.trim(),
      probe_type: t.probe_type,
      port_or_path: (t.port_or_path ?? "").trim(),
      group_id: t.group_id || null,
      interval_sec: Number(t.interval_sec),
      timeout_ms: Number(t.timeout_ms),
      enabled: t.enabled,
      auto_mtr_on_loss: t.auto_mtr_on_loss,
      mtr_loss_threshold: Number(t.mtr_loss_threshold) || 3,
      pinned_on_tv: Boolean(t.pinned_on_tv),
      latency_warn_ms: Number(t.latency_warn_ms) || 0,
      probe_latency_overrides: t.probe_latency_overrides ?? {},
      assign_all_probes: t.assign_all_probes,
      probe_ids: t.assign_all_probes ? [] : t.probe_ids,
    };
  }

  async function handleSaveTarget(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    if (!tName.trim() || !tHost.trim()) {
      setFormErr("Name and host are required.");
      return;
    }
    setSaving(true);
    const payload = buildTargetPayload({
      name: tName,
      host: tHost,
      probe_type: tType,
      port_or_path: tPortOrPath,
      group_id: tGroupId || null,
      interval_sec: tInterval,
      timeout_ms: tTimeout,
      enabled: tEnabled,
      auto_mtr_on_loss: tAutoMtr,
      mtr_loss_threshold: tMtrThresh,
      pinned_on_tv: tPinnedOnTv,
      latency_warn_ms: tLatencyWarnMs,
      probe_latency_overrides: tProbeOverrides,
      assign_all_probes: tAssignAll,
      probe_ids: tProbeIds,
    });
    try {
      await apiRequest(
        editingTarget ? `/api/targets/${editingTarget.id}` : "/api/targets",
        {
          method: editingTarget ? "PUT" : "POST",
          body: JSON.stringify(payload),
        }
      );
      setShowTargetModal(false);
      setEditingTarget(null);
      setTName("");
      setTHost("");
      setTPortOrPath("");
      await loadAll();
    } catch (err) {
      setFormErr(
        err instanceof ApiError
          ? err.detail
          : editingTarget
          ? "Update target failed"
          : "Create target failed"
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled(t: Target) {
    setError(null);
    try {
      await apiRequest(`/api/targets/${t.id}`, {
        method: "PUT",
        body: JSON.stringify(buildTargetPayload({ ...t, enabled: !t.enabled })),
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Toggle target state failed");
    }
  }

  async function handleTogglePinTv(t: Target) {
    setError(null);
    try {
      await apiRequest(`/api/targets/${t.id}`, {
        method: "PUT",
        body: JSON.stringify(
          buildTargetPayload({ ...t, pinned_on_tv: !t.pinned_on_tv })
        ),
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Toggle TV pin failed");
    }
  }

  async function handleSimulateSpike(t: Target) {
    setError(null);
    try {
      await apiRequest(`/api/targets/${t.id}/simulate`, {
        method: "POST",
        body: JSON.stringify({ mode: "high_latency", duration_sec: 30 }),
      });
      setSimNotice(
        `Simulated 30s high-latency spike on "${t.name}". Open /tv to see it auto-switch to the Highlight Spotlight slide!`
      );
      setTimeout(() => setSimNotice(null), 6000);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Simulate spike failed");
    }
  }

  async function handleSaveGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!gName.trim()) return;
    try {
      await apiRequest(
        editingGroup ? `/api/groups/${editingGroup.id}` : "/api/groups",
        {
          method: editingGroup ? "PUT" : "POST",
          body: JSON.stringify({ name: gName.trim(), description: gDesc.trim() }),
        }
      );
      setShowGroupModal(false);
      setEditingGroup(null);
      setGName("");
      setGDesc("");
      await loadAll();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.detail
          : editingGroup
          ? "Update group failed"
          : "Create group failed"
      );
    }
  }

  async function handleQuickPresets() {
    setSaving(true);
    try {
      await apiRequest("/api/targets/presets", { method: "POST" });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Preset creation failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTarget(id: string) {
    await apiRequest(`/api/targets/${id}`, { method: "DELETE" });
    await loadAll();
  }

  async function handleDeleteGroup(id: string) {
    await apiRequest(`/api/groups/${id}`, { method: "DELETE" });
    await loadAll();
  }

  return (
    <NocShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-zinc-50">
              Targets &amp; Groups (Zero-CLI Sync)
            </h1>
            <p className="text-xs text-zinc-400">
              Changes sync instantaneously to all connected probes via WebSocket.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleQuickPresets()}
              className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/25"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Add Public Presets</span>
            </button>
            <button
              type="button"
              onClick={openCreateGroup}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-600"
            >
              <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Add Group</span>
            </button>
            <button
              type="button"
              onClick={openCreateTarget}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Add Target</span>
            </button>
          </div>
        </div>

        {groups.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <span
                key={g.id}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-zinc-300"
              >
                <span>{g.name}</span>
                <button
                  type="button"
                  aria-label={`Edit group ${g.name}`}
                  onClick={() => openEditGroup(g)}
                  className="text-zinc-400 hover:text-emerald-400"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete group ${g.name}`}
                  onClick={() => void handleDeleteGroup(g.id)}
                  className="text-zinc-400 hover:text-rose-400"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
            {error}
          </div>
        )}

        {simNotice && (
          <div role="status" className="rounded-md border border-emerald-500/40 bg-emerald-500/15 p-3 text-xs text-emerald-300">
            {simNotice}
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-surface" />
            ))}
          </div>
        ) : targets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-10 text-center text-sm text-zinc-400">
            No targets configured yet. Click &ldquo;Add Target&rdquo; or &ldquo;Add Starter Presets&rdquo; to start probing.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-elevated/60 text-zinc-400 uppercase font-mono">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Host / Endpoint</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Interval / Warn RTT</th>
                  <th className="px-4 py-3">Auto MTR</th>
                  <th className="px-4 py-3">Probes</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {targets.map((t) => (
                  <tr
                    key={t.id}
                    className={`hover:bg-elevated/40 ${t.enabled ? "" : "opacity-75"}`}
                  >
                    <td className="px-4 py-3 font-semibold text-zinc-100">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link href={`/targets/${t.id}`} className="hover:text-emerald-400">
                          {t.name}
                        </Link>
                        {t.pinned_on_tv && (
                          <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono uppercase text-amber-300">
                            <Pin className="h-2.5 w-2.5" aria-hidden="true" />
                            VIP TV
                          </span>
                        )}
                        {!t.enabled && (
                          <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono uppercase text-amber-300">
                            Paused
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-300">
                      {t.host}
                      {t.port_or_path ? ` (${t.port_or_path})` : ""}
                    </td>
                    <td className="px-4 py-3 font-mono uppercase text-emerald-400">
                      {t.probe_type}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-zinc-300">
                      {t.interval_sec}s /{" "}
                      {t.latency_warn_ms && t.latency_warn_ms > 0
                        ? `${t.latency_warn_ms}ms warn`
                        : "Auto Best-Path"}
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-300">
                      {t.auto_mtr_on_loss ? `>= ${t.mtr_loss_threshold} loss` : "Off"}
                    </td>
                    <td className="px-4 py-3 text-zinc-300">
                      {t.assign_all_probes ? "All Probes" : `${t.probe_ids.length} assigned`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleTogglePinTv(t)}
                          aria-label={`${t.pinned_on_tv ? "Unpin" : "Pin"} target ${t.name} on TV`}
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                            t.pinned_on_tv
                              ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                              : "border-border bg-elevated text-zinc-200 hover:border-amber-500/50"
                          }`}
                        >
                          <Pin className="h-3 w-3" aria-hidden="true" />
                          <span>{t.pinned_on_tv ? "Pinned" : "Pin TV"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSimulateSpike(t)}
                          aria-label={`Simulate high latency on ${t.name}`}
                          className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-1 text-xs text-zinc-200 hover:border-amber-500/50 hover:text-amber-300"
                        >
                          <Flame className="h-3 w-3" aria-hidden="true" />
                          <span>Test Spike</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleEnabled(t)}
                          aria-label={`${t.enabled ? "Pause" : "Resume"} target ${t.name}`}
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                            t.enabled
                              ? "border-border bg-elevated text-zinc-200 hover:border-amber-500/50 hover:text-amber-300"
                              : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                          }`}
                        >
                          {t.enabled ? (
                            <Pause className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <Play className="h-3 w-3" aria-hidden="true" />
                          )}
                          <span>{t.enabled ? "Pause" : "Resume"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => populateTargetForm(t, false)}
                          aria-label={`Edit target ${t.name}`}
                          className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-1 text-zinc-200 hover:border-emerald-500/50 hover:text-emerald-300"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => populateTargetForm(t, true)}
                          aria-label={`Duplicate target ${t.name}`}
                          className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-1 text-zinc-200 hover:border-cyan-500/50 hover:text-cyan-300"
                        >
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteTarget(t.id)}
                          aria-label={`Delete target ${t.name}`}
                          className="inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-rose-300 hover:bg-rose-500/20"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Create / Edit Target Modal */}
        {showTargetModal && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="target-modal-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          >
            <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
              <div className="mb-4 flex items-center justify-between">
                <h2 id="target-modal-title" className="text-base font-bold text-zinc-100">
                  {editingTarget
                    ? `Edit Target: ${editingTarget.name}`
                    : "Add Monitoring Target"}
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setShowTargetModal(false);
                    setEditingTarget(null);
                  }}
                  aria-label="Close modal"
                  className="rounded p-1 text-zinc-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleSaveTarget} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="t-name" className="mb-1 block text-xs text-zinc-300">
                      Target Name *
                    </label>
                    <input
                      id="t-name"
                      type="text"
                      value={tName}
                      onChange={(e) => setTName(e.target.value)}
                      placeholder="e.g. Metro Core Gateway"
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
                    />
                  </div>
                  <div>
                    <label htmlFor="t-group" className="mb-1 block text-xs text-zinc-300">
                      Group
                    </label>
                    <select
                      id="t-group"
                      value={tGroupId}
                      onChange={(e) => setTGroupId(e.target.value)}
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
                    >
                      <option value="">Ungrouped</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="t-type" className="mb-1 block text-xs text-zinc-300">
                      Probe Protocol
                    </label>
                    <select
                      id="t-type"
                      value={tType}
                      onChange={(e) =>
                        setTType(e.target.value as "icmp" | "tcp" | "http" | "dns")
                      }
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
                    >
                      <option value="icmp">ICMP Echo</option>
                      <option value="tcp">TCP SYN-ACK Port</option>
                      <option value="http">HTTP / HTTPS</option>
                      <option value="dns">DNS Query</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="t-host" className="mb-1 block text-xs text-zinc-300">
                      Host / IP / URL *
                    </label>
                    <input
                      id="t-host"
                      type="text"
                      value={tHost}
                      onChange={(e) => setTHost(e.target.value)}
                      placeholder={tType === "http" ? "https://api.example.com" : "1.1.1.1"}
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
                    />
                  </div>
                </div>

                {tType !== "icmp" && (
                  <div>
                    <label htmlFor="t-port" className="mb-1 block text-xs text-zinc-300">
                      {tType === "tcp"
                        ? "TCP Port *"
                        : tType === "dns"
                        ? "Query Domain|Type (e.g. cloudflare.com|A)"
                        : "HTTP Path (optional)"}
                    </label>
                    <input
                      id="t-port"
                      type="text"
                      value={tPortOrPath}
                      onChange={(e) => setTPortOrPath(e.target.value)}
                      placeholder={
                        tType === "tcp"
                          ? "443"
                          : tType === "dns"
                          ? "example.com|A"
                          : "/healthz"
                      }
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
                    />
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor="t-interval" className="mb-1 block text-xs text-zinc-300">
                      Interval (seconds)
                    </label>
                    <input
                      id="t-interval"
                      type="number"
                      min={1}
                      max={300}
                      value={tInterval}
                      onChange={(e) => setTInterval(Number(e.target.value))}
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
                    />
                  </div>
                  <div>
                    <label htmlFor="t-timeout" className="mb-1 block text-xs text-zinc-300">
                      Timeout (ms)
                    </label>
                    <input
                      id="t-timeout"
                      type="number"
                      min={100}
                      max={10000}
                      value={tTimeout}
                      onChange={(e) => setTTimeout(Number(e.target.value))}
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
                    />
                  </div>
                  <div>
                    <label htmlFor="t-warn-ms" className="mb-1 block text-xs text-zinc-300">
                      Warn RTT (0 = Auto)
                    </label>
                    <input
                      id="t-warn-ms"
                      type="number"
                      min={0}
                      max={10000}
                      value={tLatencyWarnMs}
                      onChange={(e) => setTLatencyWarnMs(Number(e.target.value))}
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
                    />
                  </div>
                </div>

                {probes.length > 0 && (
                  <div className="rounded border border-border bg-canvas p-3 space-y-2">
                    <p className="text-xs font-medium text-zinc-300">
                      Per-Probe High-Latency Override (ms, 0 = Auto Best-Path Baseline):
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {probes.map((p) => (
                        <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                          <label htmlFor={`probe-ov-${p.id}`} className="truncate text-zinc-300">
                            {p.name}
                          </label>
                          <input
                            id={`probe-ov-${p.id}`}
                            type="number"
                            min={0}
                            max={10000}
                            value={tProbeOverrides[p.id] ?? 0}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setTProbeOverrides((prev) => {
                                const next = { ...prev };
                                if (val > 0) {
                                  next[p.id] = val;
                                } else {
                                  delete next[p.id];
                                }
                                return next;
                              });
                            }}
                            className="w-20 rounded border border-border bg-elevated px-2 py-1 font-mono text-zinc-100"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2 border-t border-border pt-3">
                  <label className="flex items-center gap-2 text-xs text-zinc-200">
                    <input
                      type="checkbox"
                      checked={tEnabled}
                      onChange={(e) => setTEnabled(e.target.checked)}
                      className="rounded border-border bg-canvas"
                    />
                    <span>Monitoring enabled (active polling on probes)</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-amber-300 font-medium">
                    <input
                      type="checkbox"
                      checked={tPinnedOnTv}
                      onChange={(e) => setTPinnedOnTv(e.target.checked)}
                      className="rounded border-border bg-canvas"
                    />
                    <span>Pin to TV Spotlight Page (Always feature multi-probe breakdown on /tv)</span>
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs text-zinc-200">
                      <input
                        type="checkbox"
                        checked={tAutoMtr}
                        onChange={(e) => setTAutoMtr(e.target.checked)}
                        className="rounded border-border bg-canvas"
                      />
                      <span>Trigger automatic MTR snapshot on consecutive losses</span>
                    </label>
                    {tAutoMtr && (
                      <div className="flex items-center gap-1.5">
                        <label htmlFor="t-mtr-thresh" className="text-xs text-zinc-400">
                          Loss threshold:
                        </label>
                        <input
                          id="t-mtr-thresh"
                          type="number"
                          min={1}
                          max={100}
                          value={tMtrThresh}
                          onChange={(e) => setTMtrThresh(Number(e.target.value))}
                          className="w-16 rounded border border-border bg-canvas px-2 py-1 text-xs font-mono text-zinc-100"
                        />
                      </div>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-zinc-200">
                    <input
                      type="checkbox"
                      checked={tAssignAll}
                      onChange={(e) => setTAssignAll(e.target.checked)}
                      className="rounded border-border bg-canvas"
                    />
                    <span>Assign to all active &amp; future probes</span>
                  </label>
                </div>

                {!tAssignAll && probes.length > 0 && (
                  <div className="rounded border border-border bg-canvas p-3 space-y-1.5">
                    <p className="text-xs font-medium text-zinc-400">Select Probes:</p>
                    {probes.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-xs text-zinc-200">
                        <input
                          type="checkbox"
                          checked={tProbeIds.includes(p.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setTProbeIds((prev) => [...prev, p.id]);
                            } else {
                              setTProbeIds((prev) => prev.filter((id) => id !== p.id));
                            }
                          }}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                )}

                {formErr && (
                  <p role="alert" className="text-xs text-rose-400">
                    {formErr}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowTargetModal(false);
                      setEditingTarget(null);
                    }}
                    className="rounded-md border border-border bg-elevated px-3 py-2 text-xs text-zinc-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
                  >
                    {saving
                      ? "Saving..."
                      : editingTarget
                      ? "Update & Sync to Probes"
                      : "Save & Sync to Probes"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Group Modal */}
        {showGroupModal && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-modal-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          >
            <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl">
              <h2 id="group-modal-title" className="mb-4 text-base font-bold text-zinc-100">
                {editingGroup ? "Edit Target Group" : "Create Target Group"}
              </h2>
              <form onSubmit={handleSaveGroup} className="space-y-4">
                <div>
                  <label htmlFor="g-name" className="mb-1 block text-xs text-zinc-300">
                    Group Name *
                  </label>
                  <input
                    id="g-name"
                    type="text"
                    value={gName}
                    onChange={(e) => setGName(e.target.value)}
                    placeholder="e.g. Metro Backhaul"
                    className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
                  />
                </div>
                <div>
                  <label htmlFor="g-desc" className="mb-1 block text-xs text-zinc-300">
                    Description
                  </label>
                  <input
                    id="g-desc"
                    type="text"
                    value={gDesc}
                    onChange={(e) => setGDesc(e.target.value)}
                    className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowGroupModal(false);
                      setEditingGroup(null);
                    }}
                    className="rounded-md border border-border bg-elevated px-3 py-2 text-xs text-zinc-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950"
                  >
                    {editingGroup ? "Update Group" : "Create Group"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </NocShell>
  );
}
