"use client";

import React from "react";
import {
  PROTOCOL_FAMILIES,
  type IpFamilyFilter,
  type ProtocolFamily,
} from "@/lib/protocol-filters";

interface ProtocolFilterChipsProps {
  selectedProtocols: ProtocolFamily[];
  onToggleProtocol: (proto: ProtocolFamily) => void;
  onClearProtocols: () => void;
  ipVersion: IpFamilyFilter;
  onChangeIpVersion: (ip: IpFamilyFilter) => void;
  protocolCounts?: Partial<Record<ProtocolFamily, number>>;
  compact?: boolean;
  testIdPrefix?: string;
}

const IP_OPTIONS: ReadonlyArray<{ id: IpFamilyFilter; label: string }> = [
  { id: "all", label: "All IP" },
  { id: "ipv4", label: "IPv4" },
  { id: "ipv6", label: "IPv6" },
];

/**
 * Shared protocol family & IP version filter chip strip used across /tv, /, and /targets.
 */
export function ProtocolFilterChips({
  selectedProtocols,
  onToggleProtocol,
  onClearProtocols,
  ipVersion,
  onChangeIpVersion,
  protocolCounts,
  compact = false,
  testIdPrefix = "proto-filter",
}: ProtocolFilterChipsProps) {
  const padCls = compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div
        role="group"
        aria-label="Filter by protocol"
        className="inline-flex flex-wrap items-center gap-1"
      >
        <button
          type="button"
          data-testid={`${testIdPrefix}-all`}
          aria-pressed={selectedProtocols.length === 0}
          onClick={onClearProtocols}
          className={`rounded border font-mono transition-colors ${padCls} ${
            selectedProtocols.length === 0
              ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
              : "border-border bg-elevated text-zinc-300 hover:text-zinc-100"
          }`}
        >
          All Protocols
        </button>

        {PROTOCOL_FAMILIES.map((meta) => {
          const active = selectedProtocols.includes(meta.id);
          const count = protocolCounts?.[meta.id];
          return (
            <button
              key={meta.id}
              type="button"
              data-testid={`${testIdPrefix}-${meta.id}`}
              aria-pressed={active}
              title={meta.description}
              onClick={() => onToggleProtocol(meta.id)}
              className={`inline-flex items-center gap-1 rounded border font-mono transition-colors ${padCls} ${
                active
                  ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                  : "border-border bg-elevated text-zinc-300 hover:text-zinc-100"
              }`}
            >
              <span>{meta.shortLabel}</span>
              {count !== undefined && (
                <span
                  className={
                    active ? "text-zinc-900/80" : "text-zinc-400"
                  }
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <span className="h-4 w-px bg-border/80 hidden sm:inline-block" aria-hidden="true" />

      <div
        role="group"
        aria-label="Filter by IP version"
        className="inline-flex items-center rounded border border-border bg-canvas/80 p-0.5"
      >
        {IP_OPTIONS.map((opt) => {
          const active = ipVersion === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              data-testid={`${testIdPrefix}-ip-${opt.id}`}
              aria-pressed={active}
              onClick={() => onChangeIpVersion(opt.id)}
              className={`rounded font-mono transition-colors ${
                compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]"
              } ${
                active
                  ? "bg-cyan-500 font-semibold text-zinc-950"
                  : "text-zinc-300 hover:text-zinc-100"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
