"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronDown, Loader2, Radio } from "lucide-react";
import {
  formatCustomWindowShort,
  MAX_CUSTOM_WINDOW_SPAN_SEC,
  MIN_CUSTOM_WINDOW_SPAN_SEC,
  TV_RANGES,
  type CustomTimeWindow,
} from "@/lib/tv-config";

export const DEFAULT_QUICK_PRESETS = ["15m", "1h", "3h", "24h", "7d"] as const;

const PRESET_SUBLABELS: Record<string, string> = {
  "5m": "Live",
  "3d": "3 days",
  "7d": "7 days",
  "30d": "1 Month",
  "1y": "1 Year",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Converts Unix seconds to a local `YYYY-MM-DDTHH:mm` string for datetime-local inputs. */
export function unixSecToLocalInput(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

/** Parses a local `YYYY-MM-DDTHH:mm` value into Unix seconds, or null if invalid. */
export function localInputToUnixSec(value: string): number | null {
  if (!value || !value.trim()) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export interface TimeRangePickerProps {
  value: string;
  customWindow?: CustomTimeWindow | null;
  onSelectPreset: (range: string) => void;
  onApplyCustom: (window: CustomTimeWindow) => void;
  quickPresets?: readonly string[];
  allPresets?: readonly string[];
  compact?: boolean;
  loading?: boolean;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

export function TimeRangePicker({
  value,
  customWindow = null,
  onSelectPreset,
  onApplyCustom,
  quickPresets = DEFAULT_QUICK_PRESETS,
  allPresets = TV_RANGES,
  compact = false,
  loading = false,
  ariaLabel = "Time range selector",
  testId = "time-range-picker",
  className = "",
}: TimeRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: 56,
    left: 16,
    zIndex: 70,
  });

  const groupRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const isCustomActive = Boolean(customWindow);
  const isSecondaryPresetActive =
    !isCustomActive && !quickPresets.includes(value);

  const seedDraftInputs = useCallback(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (customWindow) {
      setFromInput(unixSecToLocalInput(customWindow.fromSec));
      setToInput(unixSecToLocalInput(customWindow.toSec));
    } else {
      setFromInput(unixSecToLocalInput(nowSec - 24 * 3600));
      setToInput(unixSecToLocalInput(nowSec));
    }
    setValidationError(null);
  }, [customWindow]);

  const updatePopoverPosition = useCallback(() => {
    if (typeof window === "undefined" || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popWidth = Math.min(488, window.innerWidth - 16);
    const popHeight = popoverRef.current?.offsetHeight || 292;
    let left = rect.right - popWidth;
    if (left < 8) left = 8;
    if (left + popWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - popWidth - 8);
    }
    let top = rect.bottom + 8;
    if (top + popHeight > window.innerHeight - 8 && rect.top - popHeight - 8 > 8) {
      top = rect.top - popHeight - 8;
    }
    setPopoverStyle({
      position: "fixed",
      top: Math.round(top),
      left: Math.round(left),
      width: Math.round(popWidth),
      zIndex: 70,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopoverPosition();
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        (groupRef.current && target && groupRef.current.contains(target)) ||
        (popoverRef.current && target && popoverRef.current.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const handleReposition = () => updatePopoverPosition();

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [open, updatePopoverPosition]);

  function handleToggleOpen() {
    if (!open) {
      seedDraftInputs();
      setOpen(true);
    } else {
      setOpen(false);
    }
  }

  function handleChoosePreset(preset: string) {
    setValidationError(null);
    setOpen(false);
    onSelectPreset(preset);
  }

  function handleQuickToday() {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0
    );
    const nowSec = Math.floor(now.getTime() / 1000);
    let fromSec = Math.floor(startOfToday.getTime() / 1000);
    if (nowSec - fromSec < MIN_CUSTOM_WINDOW_SPAN_SEC) {
      fromSec = nowSec - 15 * 60;
    }
    setValidationError(null);
    setOpen(false);
    onApplyCustom({ fromSec, toSec: nowSec });
  }

  function handleQuickYesterday() {
    const now = new Date();
    const startOfYesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      0,
      0,
      0
    );
    const endOfYesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      23,
      59,
      59
    );
    setValidationError(null);
    setOpen(false);
    onApplyCustom({
      fromSec: Math.floor(startOfYesterday.getTime() / 1000),
      toSec: Math.floor(endOfYesterday.getTime() / 1000),
    });
  }

  function handleApplyCustomSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fromSec = localInputToUnixSec(fromInput);
    const toSec = localInputToUnixSec(toInput);
    if (fromSec === null || toSec === null) {
      setValidationError("Select both From and To dates.");
      return;
    }
    if (fromSec >= toSec) {
      setValidationError("'From' must be earlier than 'To'.");
      return;
    }
    const span = toSec - fromSec;
    if (span < MIN_CUSTOM_WINDOW_SPAN_SEC) {
      setValidationError("Range must be at least 1 minute.");
      return;
    }
    if (span > MAX_CUSTOM_WINDOW_SPAN_SEC) {
      setValidationError("Range cannot exceed 730 days.");
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (fromSec > nowSec + 60) {
      setValidationError("'From' cannot be in the future.");
      return;
    }
    const clampedTo = toSec > nowSec + 60 ? nowSec : toSec;
    if (clampedTo - fromSec < MIN_CUSTOM_WINDOW_SPAN_SEC) {
      setValidationError("Range must be at least 1 minute.");
      return;
    }
    setValidationError(null);
    setOpen(false);
    onApplyCustom({ fromSec, toSec: clampedTo });
  }

  const pillSizeClass = compact
    ? "px-1.5 xl:px-2 py-0.5 text-[10px] xl:text-[11px]"
    : "px-2 py-1 text-xs";

  const moreButtonLabel = isCustomActive && customWindow
    ? formatCustomWindowShort(customWindow.fromSec, customWindow.toSec)
    : isSecondaryPresetActive
    ? value
    : "More";

  const popoverNode =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Time range options and custom date range"
            data-testid={`${testId}-popover`}
            style={popoverStyle}
            onClick={(e) => e.stopPropagation()}
            className="rounded-xl border border-border bg-surface shadow-2xl overflow-hidden text-zinc-100"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border">
              {/* Left Column: Clean Presets + Quick Date */}
              <div className="p-3.5 space-y-3">
                <div>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Presets
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {allPresets.map((preset) => {
                      const active = !isCustomActive && value === preset;
                      const sub = PRESET_SUBLABELS[preset];
                      return (
                        <button
                          key={preset}
                          type="button"
                          data-testid={`${testId}-preset-${preset}`}
                          aria-pressed={active}
                          onClick={() => handleChoosePreset(preset)}
                          className={`flex flex-col items-center justify-center rounded-md border px-2 py-1.5 font-mono transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                            active
                              ? "border-emerald-500 bg-emerald-500/20 text-emerald-300 font-semibold"
                              : "border-border bg-canvas/70 text-zinc-200 hover:border-zinc-500 hover:text-white"
                          }`}
                        >
                          <span className="text-xs leading-tight">{preset}</span>
                          {sub && (
                            <span
                              className={`mt-0.5 text-[9px] leading-none ${
                                active ? "text-emerald-200/90" : "text-zinc-400"
                              }`}
                            >
                              {sub}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border/70 pt-2.5">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Quick Date
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      data-testid={`${testId}-quick-today`}
                      onClick={handleQuickToday}
                      className="rounded-md border border-border bg-canvas/70 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                    >
                      Today
                    </button>
                    <button
                      type="button"
                      data-testid={`${testId}-quick-yesterday`}
                      onClick={handleQuickYesterday}
                      className="rounded-md border border-border bg-canvas/70 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                    >
                      Yesterday
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Column: Custom Range (24h) */}
              <form
                onSubmit={handleApplyCustomSubmit}
                className="flex flex-col justify-between gap-3 p-3.5"
              >
                <div className="space-y-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Custom Range (24h)
                  </p>

                  <label className="block space-y-1">
                    <span className="block text-[11px] font-medium text-zinc-300">
                      From
                    </span>
                    <input
                      type="datetime-local"
                      aria-label="From date and time"
                      data-testid={`${testId}-from-input`}
                      value={fromInput}
                      onChange={(e) => {
                        setFromInput(e.target.value);
                        setValidationError(null);
                      }}
                      className="w-full rounded-md border border-border bg-canvas px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="block text-[11px] font-medium text-zinc-300">
                      To
                    </span>
                    <input
                      type="datetime-local"
                      aria-label="To date and time"
                      data-testid={`${testId}-to-input`}
                      value={toInput}
                      onChange={(e) => {
                        setToInput(e.target.value);
                        setValidationError(null);
                      }}
                      className="w-full rounded-md border border-border bg-canvas px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
                    />
                  </label>

                  {validationError && (
                    <p
                      role="alert"
                      data-testid={`${testId}-error`}
                      className="text-[11px] text-rose-400"
                    >
                      {validationError}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2.5">
                  <button
                    type="button"
                    data-testid={`${testId}-return-live`}
                    onClick={() => handleChoosePreset(value || "3h")}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
                  >
                    <Radio className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                    <span>Return to Live</span>
                  </button>

                  <button
                    type="submit"
                    data-testid={`${testId}-apply-btn`}
                    className="rounded-md bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                  >
                    Apply
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={ariaLabel}
      aria-busy={loading}
      data-testid={testId}
      className={`inline-flex items-center rounded-md border border-border bg-canvas/80 p-0.5 shrink-0 ${className}`}
    >
      {quickPresets.map((preset) => {
        const active = !isCustomActive && value === preset;
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={active}
            onClick={() => handleChoosePreset(preset)}
            className={`rounded font-mono font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${pillSizeClass} ${
              active
                ? "bg-emerald-500 text-zinc-950 font-semibold"
                : "text-zinc-400 hover:text-zinc-100"
            }`}
          >
            {preset}
          </button>
        );
      })}

      <span className="mx-0.5 h-3.5 w-px bg-border/80 shrink-0" aria-hidden="true" />

      <button
        ref={triggerRef}
        type="button"
        data-testid={`${testId}-more-btn`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          isCustomActive
            ? `Custom range: ${moreButtonLabel}`
            : isSecondaryPresetActive
            ? `Time range: ${value}, open more ranges`
            : "More time ranges and custom date picker"
        }
        onClick={handleToggleOpen}
        className={`inline-flex items-center gap-1 rounded font-mono font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${pillSizeClass} ${
          isCustomActive
            ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-inset ring-cyan-500/50 font-semibold"
            : isSecondaryPresetActive
            ? "bg-emerald-500 text-zinc-950 font-semibold"
            : open
            ? "bg-elevated text-zinc-100"
            : "text-zinc-300 hover:bg-elevated/70 hover:text-zinc-100"
        }`}
      >
        {isCustomActive && (
          <Calendar className="h-3 w-3 shrink-0 text-cyan-300" aria-hidden="true" />
        )}
        <span className="max-w-[170px] truncate">{moreButtonLabel}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {loading && (
        <span
          data-testid={`${testId}-loading`}
          title="Updating time range..."
          aria-label="Loading time range"
          className="inline-flex items-center justify-center px-1 text-emerald-400 shrink-0"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        </span>
      )}

      {popoverNode}
    </div>
  );
}
