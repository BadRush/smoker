"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Save, Shield } from "lucide-react";
import { NocShell } from "@/components/layout/NocShell";
import { ApiError, apiRequest, type SystemSettings } from "@/lib/api";
import {
  DEFAULT_EVIDENCE_BRAND_NAME,
  getEvidenceBrandName,
  saveEvidenceBrandName,
} from "@/lib/export-chart-png";

export default function SettingsPage() {
  const router = useRouter();
  const [rawDays, setRawDays] = useState(14);
  const [aggDays, setAggDays] = useState(730);
  const [defaultQuorum, setDefaultQuorum] = useState(2);
  const [brandName, setBrandName] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const s = await apiRequest<SystemSettings>("/api/settings");
      setRawDays(s.raw_retention_days);
      setAggDays(s.agg_retention_days);
      setDefaultQuorum(s.default_quorum_min);
      const serverBrand = (s.brand_name ?? "").trim();
      setBrandName(serverBrand);
      saveEvidenceBrandName(serverBrand);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
      }
    }
  }, [router]);

  useEffect(() => {
    const cached = getEvidenceBrandName();
    if (cached && cached !== DEFAULT_EVIDENCE_BRAND_NAME) {
      setBrandName(cached);
    }
    void loadSettings();
  }, [loadSettings]);

  async function handleSaveRetention(e: React.FormEvent) {
    e.preventDefault();
    setStatusMsg(null);
    setErrMsg(null);
    try {
      const cleanBrand = brandName.trim();
      await apiRequest("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          raw_retention_days: Number(rawDays),
          agg_retention_days: Number(aggDays),
          default_quorum_min: Number(defaultQuorum),
          brand_name: cleanBrand,
        }),
      });
      setBrandName(cleanBrand);
      saveEvidenceBrandName(cleanBrand);
      setStatusMsg("System settings & screenshot watermark saved.");
    } catch (err) {
      setErrMsg(err instanceof ApiError ? err.detail : "Failed to save settings");
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setStatusMsg(null);
    setErrMsg(null);
    try {
      await apiRequest("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setStatusMsg("Administrator password updated.");
    } catch (err) {
      setErrMsg(err instanceof ApiError ? err.detail : "Password update failed");
    }
  }

  return (
    <NocShell>
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-50">
            System Settings &amp; Retention
          </h1>
          <p className="text-xs text-zinc-400">
            Tune TimescaleDB hypertable drop policies and manage NOC admin credentials.
          </p>
        </div>

        {statusMsg && (
          <div role="status" className="rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300">
            {statusMsg}
          </div>
        )}
        {errMsg && (
          <div role="alert" className="rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
            {errMsg}
          </div>
        )}

        <form
          onSubmit={handleSaveRetention}
          className="rounded-lg border border-border bg-surface p-5 space-y-4"
        >
          <h2 className="text-sm font-semibold text-zinc-100">
            TimescaleDB Retention &amp; Screenshot Branding
          </h2>
          <div>
            <label htmlFor="brand-name" className="mb-1 block text-xs text-zinc-300">
              Screenshot Watermark / Organization Name (Bottom-Left PNG)
            </label>
            <input
              id="brand-name"
              type="text"
              maxLength={80}
              placeholder={DEFAULT_EVIDENCE_BRAND_NAME}
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              className="w-full rounded border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <div
              data-testid="watermark-live-preview"
              className="mt-2 flex items-center justify-between gap-2 rounded border border-border/70 bg-canvas/80 px-3 py-1.5 text-[11px]"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-zinc-500 uppercase tracking-wider text-[10px]">
                  PNG Preview
                </span>
                <span
                  data-testid="watermark-live-preview-text"
                  className="truncate font-mono font-semibold text-zinc-200"
                >
                  {brandName.trim() || DEFAULT_EVIDENCE_BRAND_NAME}
                </span>
              </div>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                  brandName.trim()
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-border bg-elevated text-zinc-400"
                }`}
              >
                {brandName.trim() ? "Custom" : "Default"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">
              Leave blank to automatically fallback to{" "}
              <span className="font-mono text-zinc-200">{DEFAULT_EVIDENCE_BRAND_NAME}</span>.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="raw-days" className="mb-1 block text-xs text-zinc-300">
                Raw 1s Samples (Days)
              </label>
              <input
                id="raw-days"
                type="number"
                min={1}
                max={90}
                value={rawDays}
                onChange={(e) => setRawDays(Number(e.target.value))}
                className="w-full rounded border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
              />
            </div>
            <div>
              <label htmlFor="agg-days" className="mb-1 block text-xs text-zinc-300">
                Aggregates 1m/5m/1h (Days)
              </label>
              <input
                id="agg-days"
                type="number"
                min={30}
                max={3650}
                value={aggDays}
                onChange={(e) => setAggDays(Number(e.target.value))}
                className="w-full rounded border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
              />
            </div>
            <div>
              <label htmlFor="def-quorum" className="mb-1 block text-xs text-zinc-300">
                Default Alert Quorum
              </label>
              <input
                id="def-quorum"
                type="number"
                min={1}
                value={defaultQuorum}
                onChange={(e) => setDefaultQuorum(Number(e.target.value))}
                className="w-full rounded border border-border bg-canvas px-3 py-2 text-sm font-mono text-zinc-100"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
            >
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Save Settings</span>
            </button>
          </div>
        </form>

        <form
          onSubmit={handlePasswordChange}
          className="rounded-lg border border-border bg-surface p-5 space-y-4"
        >
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-cyan-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-zinc-100">
              Update Admin Password
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cur-pw" className="mb-1 block text-xs text-zinc-300">
                Current Password
              </label>
              <input
                id="cur-pw"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
              />
            </div>
            <div>
              <label htmlFor="new-pw" className="mb-1 block text-xs text-zinc-300">
                New Password (min 8 chars)
              </label>
              <input
                id="new-pw"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded border border-border bg-canvas px-3 py-2 text-sm text-zinc-100"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-md border border-border bg-elevated px-4 py-2 text-xs font-semibold text-zinc-100 hover:border-zinc-500"
            >
              Update Password
            </button>
          </div>
        </form>
      </div>
    </NocShell>
  );
}
