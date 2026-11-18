"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  BellOff,
  ChevronLeft,
  ChevronRight,
  Copy,
  Flame,
  FolderPlus,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import { ProtocolFilterChips } from "@/components/targets/ProtocolFilterChips";
import {
  ApiError,
  apiRequest,
  type AlertRule,
  type MatrixCell,
  type MatrixSnapshot,
  type Probe,
  type Target,
  type TargetGroup,
  type TargetInput,
} from "@/lib/api";
import { formatMs, resolveTargetBestPathSummary } from "@/lib/smoke-math";
import {
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
  computeVisiblePageNumbers,
  DEFAULT_TARGET_FILTERS,
  filterAndSortTargets,
  hasActiveTargetFilters,
  matchesStatusAndProbe,
  orderTargetsForSections,
  PAGE_SIZE_OPTIONS,
  paginateItems,
  parseTargetTableFilters,
  serializeTargetTableFilters,
  type TargetPageSize,
  type TargetSortOption,
  type TargetStatusFilter,
  type TargetTableFilters,
} from "@/lib/target-table";

export default function TargetsPage() {
  const router = useRouter();
  const [targets, setTargets] = useState<Target[]>([]);
  const [groups, setGroups] = useState<TargetGroup[]>([]);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [matrixCells, setMatrixCells] = useState<MatrixCell[]>([]);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Target Form Modal
  const [showTargetModal, setShowTargetModal] = useState(false);
  const [editingTarget, setEditingTarget] = useState<Target | null>(null);
  const [tName, setTName] = useState("");
  const [tHost, setTHost] = useState("");
  const [tType, setTType] = useState<TargetInput["probe_type"]>("icmp");
  const [tPortOrPath, setTPortOrPath] = useState("");
  const [tGroupId, setTGroupId] = useState<string>("");
  const [tInterval, setTInterval] = useState(5);
  const [tTimeout, setTTimeout] = useState(1000);
  const [tEnabled, setTEnabled] = useState(true);
  const [tAutoMtr, setTAutoMtr] = useState(true);
  const [tMtrThresh, setTMtrThresh] = useState(3);
  const [tPinnedOnTv, setTPinnedOnTv] = useState(false);
  const [tLatencyWarnMs, setTLatencyWarnMs] = useState(0);
  const [tProbeOverrides, setTProbeOverrides] = useState<Record<string, number>>({});
  const [tAssignAll, setTAssignAll] = useState(true);
  const [tProbeIds, setTProbeIds] = useState<string[]>([]);
  const [tSyncRttAlert, setTSyncRttAlert] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [simNotice, setSimNotice] = useState<string | null>(null);

  // List Filters, Sorting, Grouping & Pagination (URL-synced)
  const [filters, setFilters] = useState<TargetTableFilters>(DEFAULT_TARGET_FILTERS);

  // Group Form Modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<TargetGroup | null>(null);
  const [gName, setGName] = useState("");
  const [gDesc, setGDesc] = useState("");
  const handledQueryEditRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setFilters(parseTargetTableFilters(window.location.search));
  }, []);

  const updateFilters = useCallback(
    (
      updater: (prev: TargetTableFilters) => TargetTableFilters,
      resetPage = true
    ) => {
      setFilters((prev) => {
        const updated = updater(prev);
        const next: TargetTableFilters = resetPage
          ? { ...updated, page: 1 }
          : updated;
        if (typeof window !== "undefined") {
          const qs = serializeTargetTableFilters(next, window.location.search);
          const nextUrl = qs
            ? `${window.location.pathname}?${qs}`
            : window.location.pathname;
          window.history.replaceState(null, "", nextUrl);
        }
        return next;
      });
    },
    []
  );

  const toggleProtocol = useCallback(
    (proto: ProtocolFamily) => {
      updateFilters((prev) => ({
        ...prev,
        protocols: prev.protocols.includes(proto)
          ? prev.protocols.filter((p) => p !== proto)
          : [...prev.protocols, proto],
      }));
    },
    [updateFilters]
  );

  const resetAllFilters = useCallback(() => {
    updateFilters((prev) => ({
      ...DEFAULT_TARGET_FILTERS,
      groupBy: prev.groupBy,
      pageSize: prev.pageSize,
    }));
  }, [updateFilters]);

  const groupMap = useMemo(() => {
    return new Map(groups.map((g) => [g.id, g.name]));
  }, [groups]);

  const probeNameMap = useMemo(() => {
    return new Map(probes.map((p) => [p.id, p.name]));
  }, [probes]);

  const overrideProbes = useMemo(() => {
    if (tAssignAll) return probes;
    const selected = new Set(tProbeIds);
    return probes.filter((p) => selected.has(p.id));
  }, [probes, tAssignAll, tProbeIds]);

  const modalBestPathSummary = useMemo(() => {
    return resolveTargetBestPathSummary(
      {
        id: editingTarget?.id ?? "__new__",
        assign_all_probes: tAssignAll,
        probe_ids: tProbeIds,
        latency_warn_ms: Number(tLatencyWarnMs) || 0,
        probe_latency_overrides: tProbeOverrides,
        timeout_ms: Number(tTimeout) || 1000,
      },
      matrixCells,
      probes
    );
  }, [
    editingTarget?.id,
    tAssignAll,
    tProbeIds,
    tLatencyWarnMs,
    tProbeOverrides,
    tTimeout,
    matrixCells,
    probes,
  ]);

  const modalBestPathByProbe = useMemo(() => {
    return new Map(modalBestPathSummary.probeEntries.map((e) => [e.probeId, e]));
  }, [modalBestPathSummary]);

  const existingTargetRttRule = useMemo(() => {
    if (!editingTarget) return null;
    return (
      alertRules.find(
        (r) => r.target_id === editingTarget.id && r.metric === "latency_p95"
      ) ?? null
    );
  }, [editingTarget, alertRules]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of targets) {
      const key = t.group_id ?? "ungrouped";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [targets]);

  const protocolCounts = useMemo(() => {
    const counts: Partial<Record<ProtocolFamily, number>> = {};
    for (const t of targets) {
      if (filters.group !== "all" && (t.group_id ?? "ungrouped") !== filters.group) {
        continue;
      }
      if (!matchesStatusAndProbe(t, filters.status, filters.probeId)) {
        continue;
      }
      if (!matchesProtocolAndIpFilter(t, [], filters.ipVersion)) {
        continue;
      }
      const fam = getProtocolFamily(t.probe_type);
      counts[fam] = (counts[fam] ?? 0) + 1;
    }
    return counts;
  }, [targets, filters.group, filters.status, filters.probeId, filters.ipVersion]);

  const filteredTargets = useMemo(
    () => filterAndSortTargets(targets, groupMap, filters),
    [targets, groupMap, filters]
  );

  const orderedTargets = useMemo(
    () => orderTargetsForSections(filteredTargets, groups, filters.groupBy),
    [filteredTargets, groups, filters.groupBy]
  );

  const paged = useMemo(
    () => paginateItems(orderedTargets, filters.page, filters.pageSize),
    [orderedTargets, filters.page, filters.pageSize]
  );

  const visiblePages = useMemo(
    () => computeVisiblePageNumbers(paged.safePage, paged.totalPages),
    [paged.safePage, paged.totalPages]
  );

  const pageSections = useMemo(() => {
    if (filters.groupBy === "protocol") {
      return groupItemsByProtocol(paged.pageItems, (t) => t).map((sec) => ({
        key: `proto:${sec.family.id}`,
        title: sec.family.label,
        badgeClass: sec.family.badgeClass,
        items: sec.items,
      }));
    }
    if (filters.groupBy === "group") {
      return groupItemsByTargetGroup(paged.pageItems, (t) => t, groups).map((sec) => ({
        key: `grp:${sec.id}`,
        title: sec.label,
        badgeClass: "border-border bg-elevated text-zinc-200",
        items: sec.items,
      }));
    }
    return [{ key: "all", title: "", badgeClass: undefined, items: paged.pageItems }];
  }, [paged.pageItems, filters.groupBy, groups]);

  const filtersActive = useMemo(() => hasActiveTargetFilters(filters), [filters]);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [tRes, gRes, pRes, mRes, rRes] = await Promise.all([
        apiRequest<Target[]>("/api/targets"),
        apiRequest<TargetGroup[]>("/api/groups"),
        apiRequest<Probe[]>("/api/probes"),
        apiRequest<MatrixSnapshot>("/api/matrix").catch(() => null as MatrixSnapshot | null),
        apiRequest<AlertRule[]>("/api/alerts/rules").catch(() => [] as AlertRule[]),
      ]);
      setTargets(tRes);
      setGroups(gRes);
      setProbes(pRes);
      setMatrixCells(Array.isArray(mRes?.cells) ? mRes.cells : []);
      setAlertRules(Array.isArray(rRes) ? rRes : []);
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
    setTSyncRttAlert(false);
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
    setTInterval(5);
    setTTimeout(1000);
    setTEnabled(true);
    setTAutoMtr(true);
    setTMtrThresh(3);
    setTPinnedOnTv(false);
    setTLatencyWarnMs(0);
    setTProbeOverrides({});
    setTAssignAll(true);
    setTProbeIds([]);
    setTSyncRttAlert(false);
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
    const dedupedProbeIds = t.assign_all_probes
      ? []
      : Array.from(new Set(t.probe_ids));
    const assignedSet = new Set(dedupedProbeIds);
    const cleanedOverrides: Record<string, number> = {};
    for (const [pid, val] of Object.entries(t.probe_latency_overrides ?? {})) {
      if (val > 0 && (t.assign_all_probes || assignedSet.has(pid))) {
        cleanedOverrides[pid] = val;
      }
    }
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
      probe_latency_overrides: cleanedOverrides,
      assign_all_probes: t.assign_all_probes,
      probe_ids: dedupedProbeIds,
    };
  }

  async function handleSaveTarget(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    if (!tName.trim() || !tHost.trim()) {
      setFormErr("Name and host are required.");
      return;
    }
    if (!tAssignAll && tProbeIds.length === 0) {
      setFormErr(
        "Select at least one probe when 'Assign to all active & future probes' is unchecked."
      );
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
      const savedTarget = await apiRequest<Target>(
        editingTarget ? `/api/targets/${editingTarget.id}` : "/api/targets",
        {
          method: editingTarget ? "PUT" : "POST",
          body: JSON.stringify(payload),
        }
      );
      if (tSyncRttAlert && savedTarget?.id) {
        const syncThreshold = Number(tLatencyWarnMs) || 0;
        const ruleToUpdate = existingTargetRttRule;
        if (ruleToUpdate) {
          await apiRequest(`/api/alerts/rules/${ruleToUpdate.id}`, {
            method: "PUT",
            body: JSON.stringify({
              name: ruleToUpdate.name,
              target_id: savedTarget.id,
              group_id: null,
              metric: "latency_p95",
              threshold_value: syncThreshold,
              duration_sec: ruleToUpdate.duration_sec,
              quorum_min_probes: ruleToUpdate.quorum_min_probes,
              cooldown_sec: ruleToUpdate.cooldown_sec,
              confirm_sec: ruleToUpdate.confirm_sec ?? 0,
              recover_sec: ruleToUpdate.recover_sec ?? 45,
              channel_ids: ruleToUpdate.channel_ids ?? [],
              enabled: true,
            }),
          });
        } else {
          await apiRequest("/api/alerts/rules", {
            method: "POST",
            body: JSON.stringify({
              name: `${savedTarget.name} High Latency`,
              target_id: savedTarget.id,
              group_id: null,
              metric: "latency_p95",
              threshold_value: syncThreshold,
              duration_sec: 30,
              quorum_min_probes: 1,
              cooldown_sec: 0,
              confirm_sec: 0,
              recover_sec: 45,
              channel_ids: [],
              enabled: true,
            }),
          });
        }
        setSimNotice(
          `Saved "${savedTarget.name}" and synced Telegram High-Latency (P95) rule (${
            syncThreshold > 0 ? `>= ${syncThreshold} ms` : "Auto Best-Path"
          }).`
        );
        setTimeout(() => setSimNotice(null), 6000);
      }
      setShowTargetModal(false);
      setEditingTarget(null);
      setTSyncRttAlert(false);
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

  function isTargetMuted(t: Target): boolean {
    return Boolean(t.muted_until && new Date(t.muted_until).getTime() > Date.now());
  }

  async function handleToggleMute(t: Target) {
    setError(null);
    const muted = isTargetMuted(t);
    try {
      await apiRequest(`/api/targets/${t.id}/mute`, {
        method: "POST",
        body: JSON.stringify({ duration: muted ? "off" : "1h" }),
      });
      setSimNotice(
        muted
          ? `Maintenance mute cleared for "${t.name}".`
          : `Alerts muted for 1 hour on "${t.name}".`
      );
      setTimeout(() => setSimNotice(null), 6000);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Toggle mute failed");
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
    if (filters.group === id) {
      updateFilters((prev) => ({ ...prev, group: "all" }));
    }
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

        {(groups.length > 0 || (groupCounts.get("ungrouped") ?? 0) > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {groups.map((g) => {
              const active = filters.group === g.id;
              const cnt = groupCounts.get(g.id) ?? 0;
              return (
                <span
                  key={g.id}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
                    active
                      ? "border-emerald-500/70 bg-emerald-500/15 text-emerald-200"
                      : "border-border bg-surface text-zinc-300"
                  }`}
                >
                  <button
                    type="button"
                    data-testid={`targets-group-pill-${g.id}`}
                    aria-pressed={active}
                    onClick={() =>
                      updateFilters((prev) => ({
                        ...prev,
                        group: prev.group === g.id ? "all" : g.id,
                      }))
                    }
                    className="inline-flex items-center gap-1.5 font-medium hover:text-emerald-300"
                  >
                    <span>{g.name}</span>
                    <span className="font-mono text-[10px] text-zinc-400">
                      {cnt}
                    </span>
                  </button>
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
              );
            })}
            {(groupCounts.get("ungrouped") ?? 0) > 0 && (
              <button
                type="button"
                data-testid="targets-group-pill-ungrouped"
                aria-pressed={filters.group === "ungrouped"}
                onClick={() =>
                  updateFilters((prev) => ({
                    ...prev,
                    group: prev.group === "ungrouped" ? "all" : "ungrouped",
                  }))
                }
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                  filters.group === "ungrouped"
                    ? "border-emerald-500/70 bg-emerald-500/15 text-emerald-200 font-medium"
                    : "border-border bg-surface text-zinc-300 hover:text-emerald-300"
                }`}
              >
                <span>Ungrouped</span>
                <span className="font-mono text-[10px] text-zinc-400">
                  {groupCounts.get("ungrouped") ?? 0}
                </span>
              </button>
            )}
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

        {!loading && targets.length > 0 && (
          <div className="space-y-2.5 rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[220px]">
                <Search
                  className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-500"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  data-testid="targets-search-input"
                  aria-label="Search configured targets"
                  placeholder="Search name, host/IP, port/domain, protocol, or group..."
                  value={filters.q}
                  onChange={(e) =>
                    updateFilters((prev) => ({ ...prev, q: e.target.value }))
                  }
                  className="w-full rounded-md border border-border bg-canvas pl-8 pr-7 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
                />
                {filters.q && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => updateFilters((prev) => ({ ...prev, q: "" }))}
                    className="absolute right-2 top-1.5 rounded p-0.5 text-zinc-400 hover:text-zinc-100"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              <select
                aria-label="Filter targets by group"
                data-testid="targets-group-filter"
                value={filters.group}
                onChange={(e) =>
                  updateFilters((prev) => ({ ...prev, group: e.target.value }))
                }
                className="rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="all">All Groups ({targets.length})</option>
                <option value="ungrouped">
                  Ungrouped ({groupCounts.get("ungrouped") ?? 0})
                </option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({groupCounts.get(g.id) ?? 0})
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter targets by status"
                data-testid="targets-status-filter"
                value={filters.status}
                onChange={(e) =>
                  updateFilters((prev) => ({
                    ...prev,
                    status: e.target.value as TargetStatusFilter,
                  }))
                }
                className="rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="all">All States</option>
                <option value="active">Active Only</option>
                <option value="paused">Paused Only</option>
                <option value="vip">VIP TV Pinned</option>
                <option value="auto_mtr">Auto-MTR Enabled</option>
              </select>

              <select
                aria-label="Filter targets by probe assignment"
                data-testid="targets-probe-filter"
                value={filters.probeId}
                onChange={(e) =>
                  updateFilters((prev) => ({ ...prev, probeId: e.target.value }))
                }
                className="rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="all">All Probe Scopes</option>
                <option value="assign_all">Broadcast (All Probes)</option>
                <option value="custom">Custom Assigned Only</option>
                {probes.map((p) => (
                  <option key={p.id} value={p.id}>
                    Monitored by: {p.name}
                  </option>
                ))}
              </select>

              <select
                aria-label="Sort targets by"
                data-testid="targets-sort-select"
                value={filters.sortBy}
                onChange={(e) =>
                  updateFilters((prev) => ({
                    ...prev,
                    sortBy: e.target.value as TargetSortOption,
                  }))
                }
                className="rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="name_asc">Sort: Name (A–Z)</option>
                <option value="name_desc">Sort: Name (Z–A)</option>
                <option value="protocol">Sort: Protocol</option>
                <option value="interval_asc">Sort: Poll Interval</option>
                <option value="newest">Sort: Newest First</option>
                <option value="oldest">Sort: Oldest First</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
              <ProtocolFilterChips
                compact
                testIdPrefix="targets-proto"
                selectedProtocols={filters.protocols}
                onToggleProtocol={toggleProtocol}
                onClearProtocols={() =>
                  updateFilters((prev) => ({ ...prev, protocols: [] }))
                }
                ipVersion={filters.ipVersion}
                onChangeIpVersion={(ip: IpFamilyFilter) =>
                  updateFilters((prev) => ({ ...prev, ipVersion: ip }))
                }
                protocolCounts={protocolCounts}
              />

              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label="Group target rows by"
                  className="inline-flex rounded-md border border-border bg-canvas p-0.5 text-xs"
                >
                  {(
                    [
                      { id: "protocol", label: "By Protocol" },
                      { id: "group", label: "By Group" },
                      { id: "none", label: "Flat" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={filters.groupBy === opt.id}
                      onClick={() =>
                        updateFilters((prev) => ({
                          ...prev,
                          groupBy: opt.id as GroupByMode,
                        }))
                      }
                      className={`rounded px-2.5 py-1 font-mono ${
                        filters.groupBy === opt.id
                          ? "bg-emerald-500 font-semibold text-zinc-950"
                          : "text-zinc-300 hover:text-zinc-100"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {filtersActive && (
                  <button
                    type="button"
                    data-testid="targets-reset-filters-btn"
                    onClick={resetAllFilters}
                    className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2.5 py-1 text-[11px] font-mono text-zinc-200 hover:border-emerald-500/50 hover:text-emerald-300"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    <span>Reset Filters</span>
                  </button>
                )}
              </div>
            </div>
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
        ) : paged.totalItems === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface p-8 text-center text-sm text-zinc-400">
            <span>No targets match the current search or filter criteria.</span>
            {filtersActive && (
              <button
                type="button"
                onClick={resetAllFilters}
                className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-mono text-emerald-300 hover:bg-emerald-500/25"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reset All Filters</span>
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
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
                  {pageSections.map((section) => (
                    <React.Fragment key={section.key}>
                      {section.title && (
                        <tr className="bg-elevated/45">
                          <td colSpan={7} className="border-y border-border/80 px-4 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`rounded border px-2 py-0.5 text-[11px] font-mono font-semibold ${
                                  section.badgeClass ?? "border-border bg-surface text-zinc-200"
                                }`}
                              >
                                {section.title}
                              </span>
                              <span className="text-[11px] font-mono text-zinc-400">
                                {section.items.length} on page
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                      {section.items.map((t) => (
                    <tr
                      key={t.id}
                      data-testid="target-row"
                      className={`hover:bg-elevated/40 ${t.enabled ? "" : "opacity-75"}`}
                    >
                      <td className="px-4 py-3 font-semibold text-zinc-100">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link href={`/targets/${t.id}`} className="hover:text-emerald-400">
                            {t.name}
                          </Link>
                          {t.group_id && groupMap.get(t.group_id) && (
                            <span className="rounded border border-border bg-canvas px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                              {groupMap.get(t.group_id)}
                            </span>
                          )}
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
                          {isTargetMuted(t) && (
                            <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono uppercase text-amber-300">
                              Muted
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-zinc-300">
                        {t.host}
                        {t.port_or_path ? ` (${t.port_or_path})` : ""}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase ${
                            getProtocolFamilyMeta(t.probe_type).badgeClass
                          }`}
                        >
                          {t.probe_type}
                        </span>
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
                      {t.assign_all_probes ? (
                        <span>All Probes</span>
                      ) : t.probe_ids.length === 0 ? (
                        <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-mono text-amber-300">
                          0 assigned
                        </span>
                      ) : (
                        (() => {
                          const names = t.probe_ids.map(
                            (id) => probeNameMap.get(id) ?? id
                          );
                          const preview =
                            names.length <= 2
                              ? names.join(", ")
                              : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
                          return (
                            <span title={names.join(", ")} className="font-mono text-[11px]">
                              {preview}
                            </span>
                          );
                        })()
                      )}
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
                          onClick={() => void handleToggleMute(t)}
                          aria-label={`${isTargetMuted(t) ? "Unmute" : "Mute"} target ${t.name}`}
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                            isTargetMuted(t)
                              ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                              : "border-border bg-elevated text-zinc-200 hover:border-amber-500/50 hover:text-amber-300"
                          }`}
                        >
                          {isTargetMuted(t) ? (
                            <Bell className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <BellOff className="h-3 w-3" aria-hidden="true" />
                          )}
                          <span>{isTargetMuted(t) ? "Unmute" : "Mute 1h"}</span>
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
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            </div>

            {/* Pagination Footer Bar */}
            <div
              data-testid="targets-pagination"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-xs"
            >
              <div className="flex flex-wrap items-center gap-3 font-mono text-zinc-400">
                <span data-testid="targets-pagination-summary">
                  Showing {paged.startIdx}–{paged.endIdx} of {paged.totalItems} target
                  {paged.totalItems === 1 ? "" : "s"}
                  {paged.totalItems !== targets.length
                    ? ` (filtered from ${targets.length})`
                    : ""}
                </span>
                <select
                  aria-label="Targets per page"
                  data-testid="targets-page-size"
                  value={filters.pageSize}
                  onChange={(e) =>
                    updateFilters((prev) => ({
                      ...prev,
                      pageSize: Number(e.target.value) as TargetPageSize,
                    }))
                  }
                  className="rounded border border-border bg-canvas px-2 py-1 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
                >
                  {PAGE_SIZE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {paged.totalPages > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    data-testid="targets-page-prev"
                    disabled={paged.safePage <= 1}
                    onClick={() =>
                      updateFilters(
                        (prev) => ({ ...prev, page: Math.max(1, paged.safePage - 1) }),
                        false
                      )
                    }
                    className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2.5 py-1 font-mono text-zinc-200 hover:border-zinc-500 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Prev</span>
                  </button>

                  {visiblePages.map((p, idx) =>
                    p === "ellipsis" ? (
                      <span
                        key={`ell-${idx}`}
                        className="px-1.5 font-mono text-zinc-500"
                      >
                        …
                      </span>
                    ) : (
                      <button
                        key={p}
                        type="button"
                        data-testid={`targets-page-${p}`}
                        aria-current={paged.safePage === p ? "page" : undefined}
                        onClick={() =>
                          updateFilters((prev) => ({ ...prev, page: p }), false)
                        }
                        className={`min-w-[30px] rounded border px-2 py-1 text-center font-mono ${
                          paged.safePage === p
                            ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                            : "border-border bg-elevated text-zinc-300 hover:border-zinc-500"
                        }`}
                      >
                        {p}
                      </button>
                    )
                  )}

                  <button
                    type="button"
                    data-testid="targets-page-next"
                    disabled={paged.safePage >= paged.totalPages}
                    onClick={() =>
                      updateFilters(
                        (prev) => ({
                          ...prev,
                          page: Math.min(paged.totalPages, paged.safePage + 1),
                        }),
                        false
                      )
                    }
                    className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2.5 py-1 font-mono text-zinc-200 hover:border-zinc-500 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
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
                        setTType(e.target.value as TargetInput["probe_type"])
                      }
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
                    >
                      <option value="icmp">ICMP Echo (IPv4/Auto)</option>
                      <option value="icmp6">ICMPv6 Echo (IPv6)</option>
                      <option value="tcp">TCP SYN-ACK Port (IPv4/Auto)</option>
                      <option value="tcp6">TCPv6 SYN-ACK Port (IPv6)</option>
                      <option value="http">HTTP / HTTPS (IPv4/Auto)</option>
                      <option value="http6">HTTP / HTTPS over IPv6</option>
                      <option value="dns">DNS Query (IPv4/Auto)</option>
                      <option value="dns6">DNSv6 Query (IPv6)</option>
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
                      placeholder={
                        tType === "http6"
                          ? "https://[2606:4700:4700::1111]/cdn-cgi/trace"
                          : tType === "http"
                          ? "https://api.example.com"
                          : tType.endsWith("6")
                          ? "2001:4860:4860::8888"
                          : "1.1.1.1"
                      }
                      className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
                    />
                  </div>
                </div>

                {tType !== "icmp" && tType !== "icmp6" && (
                  <div>
                    <label htmlFor="t-port" className="mb-1 block text-xs text-zinc-300">
                      {tType === "tcp" || tType === "tcp6"
                        ? "TCP Port *"
                        : tType === "dns" || tType === "dns6"
                        ? `Query Domain|Type (e.g. cloudflare.com|${tType === "dns6" ? "AAAA" : "A"})`
                        : "HTTP Path (optional)"}
                    </label>
                    <input
                      id="t-port"
                      type="text"
                      value={tPortOrPath}
                      onChange={(e) => setTPortOrPath(e.target.value)}
                      placeholder={
                        tType === "tcp" || tType === "tcp6"
                          ? "443"
                          : tType === "dns6"
                          ? "example.com|AAAA"
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

                {editingTarget && (
                  <div
                    data-testid="target-bestpath-callout"
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-cyan-500/35 bg-cyan-500/10 px-3 py-2 text-xs"
                  >
                    <div className="space-y-0.5">
                      <p className="font-mono text-cyan-200">
                        {modalBestPathSummary.primaryBaselineMs !== null
                          ? `Live Best-Path P25: ${formatMs(
                              modalBestPathSummary.primaryBaselineMs
                            )} → Auto Warn: ~${Math.round(
                              modalBestPathSummary.primaryAutoWarnMs
                            )} ms`
                          : "Live Best-Path P25: collecting samples (0 = adaptive Auto Best-Path)"}
                      </p>
                      <p className="text-[11px] text-zinc-400">
                        Sets card HIGH RTT badge, chart WARN line, &amp; Auto-MTR.
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {modalBestPathSummary.primaryBaselineMs !== null && (
                        <button
                          type="button"
                          onClick={() =>
                            setTLatencyWarnMs(
                              Math.round(modalBestPathSummary.primaryAutoWarnMs)
                            )
                          }
                          className="rounded border border-cyan-400/50 bg-canvas px-2 py-1 text-[11px] font-mono text-cyan-200 hover:bg-cyan-500/20"
                        >
                          Fill ~{Math.round(modalBestPathSummary.primaryAutoWarnMs)} ms
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setTLatencyWarnMs(0)}
                        className="rounded border border-border bg-canvas px-2 py-1 text-[11px] font-mono text-zinc-300 hover:text-white"
                      >
                        Set 0 (Auto)
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-2 border-t border-border pt-3">
                  <label className="flex items-center gap-2 text-xs text-zinc-200">
                    <input
                      type="checkbox"
                      checked={tAssignAll}
                      onChange={(e) => setTAssignAll(e.target.checked)}
                      className="rounded border-border bg-canvas"
                    />
                    <span>Assign to all active &amp; future probes</span>
                  </label>

                  {!tAssignAll && (
                    <div className="rounded border border-border bg-canvas p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-zinc-300">
                          Select Probes ({tProbeIds.length} selected):
                        </p>
                        {probes.length > 0 && (
                          <div className="flex items-center gap-2 text-[11px] font-mono">
                            <button
                              type="button"
                              onClick={() => setTProbeIds(probes.map((p) => p.id))}
                              className="text-emerald-400 hover:text-emerald-300"
                            >
                              Select All
                            </button>
                            <span className="text-zinc-600">|</span>
                            <button
                              type="button"
                              onClick={() => setTProbeIds([])}
                              className="text-zinc-400 hover:text-zinc-200"
                            >
                              Clear
                            </button>
                          </div>
                        )}
                      </div>
                      {probes.length === 0 ? (
                        <p className="text-xs text-amber-300">
                          No probes registered yet. Register a probe in /probes or enable &ldquo;Assign to all active &amp; future probes&rdquo;.
                        </p>
                      ) : (
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {probes.map((p) => (
                            <label key={p.id} className="flex items-center gap-2 text-xs text-zinc-200">
                              <input
                                type="checkbox"
                                checked={tProbeIds.includes(p.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setTProbeIds((prev) =>
                                      prev.includes(p.id) ? prev : [...prev, p.id]
                                    );
                                  } else {
                                    setTProbeIds((prev) => prev.filter((id) => id !== p.id));
                                  }
                                }}
                              />
                              <span className="truncate">{p.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      {tProbeIds.length === 1 && (
                        <p className="text-[11px] text-amber-300">
                          Note: Only 1 probe assigned — alert rules with quorum &ge; 2 will not fire for this target unless quorum is set to 1.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {overrideProbes.length > 0 && (
                  <div className="rounded border border-border bg-canvas p-3 space-y-2">
                    <p className="text-xs font-medium text-zinc-300">
                      Per-Probe High-Latency Override (ms, 0 = Auto Best-Path Baseline):
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {overrideProbes.map((p) => {
                        const bp = modalBestPathByProbe.get(p.id);
                        return (
                          <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                            <div className="min-w-0">
                              <label htmlFor={`probe-ov-${p.id}`} className="block truncate text-zinc-300">
                                {p.name}
                              </label>
                              {editingTarget && bp && (
                                <span className="block font-mono text-[10px] text-zinc-400">
                                  {bp.baselineMs !== null
                                    ? `Base ${formatMs(bp.baselineMs)} · Auto ~${Math.round(
                                        bp.autoWarnMs
                                      )} ms`
                                    : "Auto Best-Path"}
                                </span>
                              )}
                            </div>
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
                        );
                      })}
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
                </div>

                <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-zinc-100">
                      Telegram High-Latency Alert (RTT)
                    </span>
                    <span className="rounded border border-border bg-canvas px-2 py-0.5 font-mono text-[10px] text-zinc-300">
                      {existingTargetRttRule
                        ? `Rule "${existingTargetRttRule.name}": ${
                            existingTargetRttRule.threshold_value === 0
                              ? "Auto Best-Path"
                              : `>= ${existingTargetRttRule.threshold_value} ms`
                          }`
                        : "No Telegram RTT rule"}
                    </span>
                  </div>
                  <label className="flex items-start gap-2 text-xs text-zinc-200 cursor-pointer">
                    <input
                      type="checkbox"
                      aria-label="Sync Telegram RTT alert rule"
                      checked={tSyncRttAlert}
                      onChange={(e) => setTSyncRttAlert(e.target.checked)}
                      className="mt-0.5 rounded border-border bg-canvas"
                    />
                    <span>
                      Also {existingTargetRttRule ? "update" : "create"} Telegram High Latency (P95) rule using this Warn RTT (
                      <span className="font-mono text-cyan-300">
                        {Number(tLatencyWarnMs) > 0
                          ? `>= ${tLatencyWarnMs} ms`
                          : "0 = Auto Best-Path"}
                      </span>
                      )
                    </span>
                  </label>
                  {editingTarget && (
                    <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                      <span>Adjust Confirm/Recover/Channels in Alerts:</span>
                      <Link
                        href={`/alerts?target_id=${encodeURIComponent(
                          editingTarget.id
                        )}&metric=latency_p95${
                          Number(tLatencyWarnMs) > 0
                            ? `&threshold=${encodeURIComponent(String(Number(tLatencyWarnMs)))}`
                            : ""
                        }`}
                        className="font-mono font-semibold text-emerald-400 hover:underline"
                      >
                        Customize in /alerts &rarr;
                      </Link>
                    </div>
                  )}
                </div>

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
