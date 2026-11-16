"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bell,
  Crosshair,
  Grid3X3,
  LogOut,
  Menu,
  Radio,
  Settings,
  Tv,
  X,
} from "lucide-react";
import { apiRequest } from "@/lib/api";
import type { WsState } from "@/lib/useLiveSocket";

interface NocShellProps {
  children: React.ReactNode;
  wsState?: WsState;
  activeIncidents?: number;
  mainMaxWidth?: string | null;
}

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: Grid3X3 },
  { href: "/probes", label: "Probes", icon: Radio },
  { href: "/targets", label: "Targets", icon: Crosshair },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/tv", label: "TV Display", icon: Tv },
];

export function NocShell({
  children,
  wsState = "connected",
  activeIncidents = 0,
  mainMaxWidth,
}: NocShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleLogout() {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Link
              href="/"
              className="flex items-center gap-2.5 font-semibold tracking-tight text-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 rounded-md px-1"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-400">
                <Activity className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="text-sm font-bold tracking-wider uppercase">
                Smoker
              </span>
              <span className="hidden sm:inline-block rounded border border-border bg-elevated px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                NOC
              </span>
            </Link>

            <nav aria-label="Main navigation" className="hidden md:flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                      active
                        ? "bg-elevated text-zinc-50 border border-border"
                        : "text-zinc-400 hover:text-zinc-100 hover:bg-elevated/60"
                    }`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.href === "/alerts" && activeIncidents > 0 && (
                      <span className="ml-0.5 rounded-full bg-rose-500/20 border border-rose-500/40 px-1.5 py-0.2 text-[11px] font-mono font-semibold text-rose-400 tabular-nums">
                        {activeIncidents}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-mono ${
                wsState === "connected"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400"
              }`}
              role="status"
              aria-live="polite"
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  wsState === "connected"
                    ? "bg-emerald-400"
                    : "bg-amber-400 animate-pulse"
                }`}
              />
              <span>
                {wsState === "connected"
                  ? "STREAM LIVE"
                  : wsState === "connecting"
                  ? "CONNECTING"
                  : "RECONNECTING"}
              </span>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white hover:border-zinc-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              aria-label="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Logout</span>
            </button>

            <button
              type="button"
              onClick={() => setMobileOpen((prev) => !prev)}
              className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-elevated text-zinc-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="md:hidden border-t border-border bg-surface px-4 py-3 space-y-1">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium ${
                    active
                      ? "bg-elevated text-zinc-50 border border-border"
                      : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {item.label}
                  </span>
                  {item.href === "/alerts" && activeIncidents > 0 && (
                    <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-xs font-mono text-rose-400">
                      {activeIncidents}
                    </span>
                  )}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-rose-400 hover:bg-elevated"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>Logout</span>
            </button>
          </div>
        )}
      </header>

      <main
        style={mainMaxWidth ? { maxWidth: mainMaxWidth } : undefined}
        className={`mx-auto w-full flex-1 px-4 py-6 sm:px-6 ${
          mainMaxWidth ? "" : "max-w-[1600px]"
        }`}
      >
        {children}
      </main>
    </div>
  );
}
