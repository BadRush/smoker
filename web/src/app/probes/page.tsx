"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  Radio,
  ServerCrash,
  Trash2,
  X,
} from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import { formatDateTime24 } from "@/lib/date-format";
import {
  ApiError,
  apiRequest,
  type CreateProbeResponse,
  type Probe,
} from "@/lib/api";

export default function ProbesPage() {
  const router = useRouter();
  const [probes, setProbes] = useState<Probe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [editingProbe, setEditingProbe] = useState<Probe | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [ispAsn, setIspAsn] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [provisioned, setProvisioned] = useState<CreateProbeResponse | null>(
    null
  );
  const [uplinkMode, setUplinkMode] = useState<"public" | "routed">("public");
  const [routedAddr, setRoutedAddr] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadProbes = useCallback(async () => {
    try {
      setError(null);
      const res = await apiRequest<Probe[]>("/api/probes");
      setProbes(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load probes");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadProbes();
    const t = setInterval(() => void loadProbes(), 5000);
    return () => clearInterval(t);
  }, [loadProbes]);

  function openCreateModal() {
    setEditingProbe(null);
    setName("");
    setLocation("");
    setIspAsn("");
    setFormErr(null);
    setShowModal(true);
  }

  function openEditModal(probe: Probe) {
    setEditingProbe(probe);
    setName(probe.name);
    setLocation(probe.location_label);
    setIspAsn(probe.isp_asn);
    setFormErr(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingProbe(null);
    setFormErr(null);
  }

  async function handleSubmitProbe(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    const trimmedName = name.trim();
    const trimmedLoc = location.trim();
    const trimmedIsp = ispAsn.trim();
    if (trimmedName.length < 2 || trimmedName.length > 80) {
      setFormErr("Probe name must be 2 to 80 characters.");
      return;
    }
    if (trimmedLoc.length > 120) {
      setFormErr("Location label must be 120 characters or fewer.");
      return;
    }
    if (trimmedIsp.length > 120) {
      setFormErr("ISP / ASN must be 120 characters or fewer.");
      return;
    }

    setSaving(true);
    try {
      if (editingProbe) {
        await apiRequest<Probe>(`/api/probes/${editingProbe.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: trimmedName,
            location_label: trimmedLoc,
            isp_asn: trimmedIsp,
          }),
        });
        closeModal();
      } else {
        const res = await apiRequest<CreateProbeResponse>("/api/probes", {
          method: "POST",
          body: JSON.stringify({
            name: trimmedName,
            location_label: trimmedLoc,
            isp_asn: trimmedIsp,
          }),
        });
        setProvisioned(res);
        closeModal();
        setName("");
        setLocation("");
        setIspAsn("");
      }
      await loadProbes();
    } catch (err) {
      setFormErr(
        err instanceof ApiError
          ? err.detail
          : editingProbe
          ? "Update probe failed"
          : "Create probe failed"
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate(id: string) {
    try {
      const res = await apiRequest<CreateProbeResponse>(
        `/api/probes/${id}/rotate-token`,
        { method: "POST" }
      );
      setProvisioned(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Rotate token failed");
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiRequest(`/api/probes/${id}`, { method: "DELETE" });
      await loadProbes();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Delete probe failed");
    }
  }

  function wsEndpoint(): string {
    if (uplinkMode === "routed") {
      const fallbackHost =
        typeof window !== "undefined" ? window.location.host : "10.10.0.5:8080";
      const clean = routedAddr.trim().replace(/^wss?:\/\//i, "").replace(/\/ws\/probe\/?$/i, "").replace(/\/+$/, "");
      return `ws://${clean || fallbackHost}/ws/probe`;
    }
    if (typeof window === "undefined") return "wss://your-smoker-domain/ws/probe";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/probe`;
  }

  function copyText(key: string, text: string) {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }

  const setupCmdSnippet = provisioned
    ? `git clone https://github.com/BadRush/smoker.git && cd smoker && ./scripts/setup.sh --role probe --central-url "${wsEndpoint()}" --probe-token "${provisioned.token}" --yes`
    : "";

  const composeSnippet = provisioned
    ? `services:
  smoker-probe:
    build:
      context: https://github.com/BadRush/smoker.git
      dockerfile: deploy/docker/probe.Dockerfile
    container_name: smoker-probe
    restart: unless-stopped
    network_mode: host
    cap_add:
      - NET_RAW
    environment:
      CENTRAL_URL: ${wsEndpoint()}
      PROBE_TOKEN: ${provisioned.token}
      DATA_DIR: /data
      MAX_BUFFER_MB: "1024"
      MAX_BUFFER_HOURS: "168"
    volumes:
      - probe_remote_data:/data

volumes:
  probe_remote_data:`
    : "";

  const envSnippet = provisioned
    ? `CENTRAL_URL=${wsEndpoint()}
PROBE_TOKEN=${provisioned.token}
PROBE_TLS_INSECURE_SKIP_VERIFY=false
MAX_BUFFER_MB=1024
MAX_BUFFER_HOURS=168`
    : "";

  return (
    <NocShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-zinc-50">
              Fleet &amp; Probe Provisioning
            </h1>
            <p className="text-xs text-zinc-400">
              Manage distributed vantage probes. Remote probes push outbound over WSS and work behind NAT/CGNAT.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 transition-colors"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Add Probe</span>
          </button>
        </div>

        {/* One-time Enrollment Snippets */}
        {provisioned && (
          <div className="rounded-lg border border-cyan-500/40 bg-surface p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-bold text-cyan-300">
                  Probe Enrolled: {provisioned.probe.name}
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Copy this token or deployment snippet now. For security, the plaintext token is not stored and will not be displayed again.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setProvisioned(null)}
                aria-label="Close enrollment snippet"
                className="rounded p-1 text-zinc-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Uplink Transport Selector: Public Cloudflared/Nginx WSS vs Direct Routed LAN/VPN WS */}
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-canvas/60 p-2.5">
              <span className="text-[11px] font-mono uppercase tracking-wide text-zinc-400 mr-1">
                Uplink Path:
              </span>
              <button
                type="button"
                aria-pressed={uplinkMode === "public"}
                onClick={() => setUplinkMode("public")}
                className={`rounded border px-2.5 py-1 text-xs font-mono ${
                  uplinkMode === "public"
                    ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                    : "border-border bg-elevated text-zinc-300"
                }`}
              >
                Cloudflared / Nginx (WSS / Current Host)
              </button>
              <button
                type="button"
                aria-pressed={uplinkMode === "routed"}
                onClick={() => setUplinkMode("routed")}
                className={`rounded border px-2.5 py-1 text-xs font-mono ${
                  uplinkMode === "routed"
                    ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                    : "border-border bg-elevated text-zinc-300"
                }`}
              >
                Routed / LAN / VPN IP (Direct WS)
              </button>
              {uplinkMode === "routed" && (
                <input
                  type="text"
                  aria-label="Routed Central IP and port"
                  value={routedAddr}
                  onChange={(e) => setRoutedAddr(e.target.value)}
                  placeholder="e.g. 10.10.0.5:8080"
                  className="ml-auto w-52 rounded border border-border bg-surface px-2.5 py-1 text-xs font-mono text-zinc-100"
                />
              )}
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-mono text-zinc-400">
                <span>One-Line Setup Script (Recommended)</span>
                <button
                  type="button"
                  onClick={() => copyText("setup", setupCmdSnippet)}
                  className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
                >
                  {copiedKey === "setup" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedKey === "setup" ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <pre className="overflow-x-auto rounded border border-border bg-canvas p-3 text-xs font-mono text-zinc-200">
                {setupCmdSnippet}
              </pre>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-mono text-zinc-400">
                <span>docker-compose.yml (Remote Probe)</span>
                <button
                  type="button"
                  onClick={() => copyText("compose", composeSnippet)}
                  className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
                >
                  {copiedKey === "compose" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedKey === "compose" ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <pre className="overflow-x-auto rounded border border-border bg-canvas p-3 text-xs font-mono text-zinc-200">
                {composeSnippet}
              </pre>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-xs font-mono text-zinc-400">
                <span>.probe.env (for deploy/docker/probe-agent.compose.yml)</span>
                <button
                  type="button"
                  onClick={() => copyText("env", envSnippet)}
                  className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
                >
                  {copiedKey === "env" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedKey === "env" ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <pre className="overflow-x-auto rounded border border-border bg-canvas p-3 text-xs font-mono text-zinc-200">
                {envSnippet}
              </pre>
            </div>
          </div>
        )}

        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-lg border border-border bg-surface"
              />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-6 text-center text-sm text-rose-200">
            <ServerCrash className="mx-auto mb-2 h-6 w-6 text-rose-400" />
            {error}
          </div>
        ) : probes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-10 text-center text-sm text-zinc-400">
            No probes registered yet.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {probes.map((p) => (
              <article
                key={p.id}
                className="rounded-lg border border-border bg-surface p-4 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex items-center gap-2">
                      <Radio
                        className={`h-4 w-4 shrink-0 ${
                          p.status === "offline"
                            ? "text-rose-400"
                            : p.status === "syncing"
                            ? "text-cyan-400"
                            : "text-emerald-400"
                        }`}
                        aria-hidden="true"
                      />
                      <h2 className="truncate text-sm font-bold text-zinc-100">
                        {p.name}
                      </h2>
                    </div>
                    <span
                      className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-mono font-semibold uppercase ${
                        p.status === "offline"
                          ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                          : p.status === "syncing" || p.status === "buffering"
                          ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                          : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>

                  <p className="mt-1 truncate text-xs text-zinc-400">
                    {p.location_label || "No location"} {p.isp_asn ? `· ${p.isp_asn}` : ""}
                  </p>

                  <dl className="mt-4 grid grid-cols-2 gap-2 text-xs font-mono tabular-nums border-t border-border pt-3">
                    <div>
                      <dt className="text-zinc-400">BACKLOG</dt>
                      <dd className="text-zinc-200">
                        {p.pending_backlog_count.toLocaleString()} rows
                      </dd>
                    </div>
                    <div>
                      <dt className="text-zinc-400">CLOCK SKEW</dt>
                      <dd className="text-zinc-200">
                        {p.clock_offset_ms.toFixed(1)} ms
                      </dd>
                    </div>
                    <div>
                      <dt className="text-zinc-400">VERSION</dt>
                      <dd className="text-zinc-300">{p.agent_version || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-400">LAST SEEN</dt>
                      <dd className="text-zinc-300">
                        {p.last_seen_at
                          ? formatDateTime24(p.last_seen_at)
                          : "Never"}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <div>
                    {p.is_local && (
                      <span className="rounded border border-zinc-700 bg-elevated px-2 py-0.5 text-[10px] font-mono text-zinc-400">
                        LOCAL
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEditModal(p)}
                      aria-label={`Edit probe ${p.name}`}
                      className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2.5 py-1 text-xs text-zinc-200 hover:border-cyan-500/40 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Edit</span>
                    </button>
                    {!p.is_local && (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleRotate(p.id)}
                          className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2.5 py-1 text-xs text-zinc-300 hover:text-white"
                        >
                          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Rotate Token</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(p.id)}
                          aria-label={`Delete probe ${p.name}`}
                          className="inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/20"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Remove</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {/* Register / Edit Probe Modal */}
        {showModal && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="probe-modal-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          >
            <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <h2 id="probe-modal-title" className="text-base font-bold text-zinc-100">
                  {editingProbe ? "Edit Probe" : "Register Remote Probe"}
                </h2>
                <button
                  type="button"
                  onClick={closeModal}
                  aria-label="Close modal"
                  className="rounded p-1 text-zinc-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleSubmitProbe} className="space-y-4">
                <div>
                  <label htmlFor="probe-name" className="mb-1 block text-xs text-zinc-300">
                    Probe Name *
                  </label>
                  <input
                    id="probe-name"
                    type="text"
                    placeholder="e.g. POP-Jakarta-Core"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="probe-loc" className="mb-1 block text-xs text-zinc-300">
                    Location Label
                  </label>
                  <input
                    id="probe-loc"
                    type="text"
                    placeholder="e.g. Jakarta Cyber1"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="probe-asn" className="mb-1 block text-xs text-zinc-300">
                    ISP / ASN
                  </label>
                  <input
                    id="probe-asn"
                    type="text"
                    placeholder="e.g. AS13335"
                    value={ispAsn}
                    onChange={(e) => setIspAsn(e.target.value)}
                    className="w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                {formErr && (
                  <p role="alert" className="text-xs text-rose-400">
                    {formErr}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="rounded-md border border-border bg-elevated px-3 py-2 text-xs text-zinc-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    aria-busy={saving}
                    className="rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-60"
                  >
                    {saving
                      ? editingProbe
                        ? "Saving..."
                        : "Generating..."
                      : editingProbe
                      ? "Save Changes"
                      : "Generate Token & Snippet"}
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
