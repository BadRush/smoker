"use client";

import React, { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  CHART_HEIGHT_PRESETS,
  clampChartHeight,
  CONTAINER_WIDTH_PRESETS,
  MAX_CUSTOM_CHART_HEIGHT,
  MIN_CUSTOM_CHART_HEIGHT,
  parseWidthSpec,
  ROW_CARD_WIDTH_PRESETS,
  type LayoutPreset,
} from "@/lib/display-layout";

interface LayoutPresetPillsProps {
  testIdPrefix: string;
  preset: LayoutPreset;
  customCols: number;
  onSelectPreset: (preset: LayoutPreset, customCols?: number) => void;
}

export function LayoutPresetPills({
  testIdPrefix,
  preset,
  customCols,
  onSelectPreset,
}: LayoutPresetPillsProps) {
  const buttons: Array<{
    key: string;
    label: string;
    active: boolean;
    onClick: () => void;
  }> = [
    {
      key: "auto",
      label: "Auto",
      active: preset === "auto",
      onClick: () => onSelectPreset("auto", 0),
    },
    {
      key: "single-col",
      label: "1 Col Full",
      active: preset === "single-col",
      onClick: () => onSelectPreset("single-col", 1),
    },
    {
      key: "single-row",
      label: "1 Row",
      active: preset === "single-row",
      onClick: () => onSelectPreset("single-row", preset === "single-row" ? customCols : 0),
    },
    {
      key: "cols-2",
      label: "2 Cols",
      active: preset === "cols" && customCols === 2,
      onClick: () => onSelectPreset("cols", 2),
    },
    {
      key: "cols-3",
      label: "3 Cols",
      active: preset === "cols" && customCols === 3,
      onClick: () => onSelectPreset("cols", 3),
    },
    {
      key: "cols-4",
      label: "4 Cols",
      active: preset === "cols" && customCols === 4,
      onClick: () => onSelectPreset("cols", 4),
    },
  ];

  return (
    <div
      role="group"
      aria-label="Layout columns preset"
      className="inline-flex flex-wrap items-center gap-1"
    >
      {buttons.map((btn) => (
        <button
          key={btn.key}
          type="button"
          aria-pressed={btn.active}
          data-testid={`${testIdPrefix}-preset-${btn.key}`}
          onClick={btn.onClick}
          className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
            btn.active
              ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
              : "border-border bg-elevated text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          }`}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}

interface DisplaySizeControlsProps {
  testIdPrefix: string;
  widthSpec: string;
  onChangeWidthSpec: (next: string) => void;
  allowAutoWidth?: boolean;
  showRowCardWidth?: boolean;
  rowCardWidth: string;
  onChangeRowCardWidth: (next: string) => void;
  chartHeight: number;
  onChangeChartHeight: (next: number) => void;
  compact?: boolean;
  onReset?: () => void;
}

export function DisplaySizeControls({
  testIdPrefix,
  widthSpec,
  onChangeWidthSpec,
  allowAutoWidth = true,
  showRowCardWidth = false,
  rowCardWidth,
  onChangeRowCardWidth,
  chartHeight,
  onChangeChartHeight,
  compact = false,
  onReset,
}: DisplaySizeControlsProps) {
  const [widthDraft, setWidthDraft] = useState(widthSpec);
  const [rowWidthDraft, setRowWidthDraft] = useState(rowCardWidth);

  useEffect(() => {
    setWidthDraft(widthSpec);
  }, [widthSpec]);

  useEffect(() => {
    setRowWidthDraft(rowCardWidth);
  }, [rowCardWidth]);

  const widthPresets = useMemo(
    () =>
      allowAutoWidth
        ? CONTAINER_WIDTH_PRESETS
        : CONTAINER_WIDTH_PRESETS.filter((p) => p.value !== "auto"),
    [allowAutoWidth]
  );

  const parsedWidth = useMemo(
    () =>
      parseWidthSpec(widthSpec, {
        allowAuto: allowAutoWidth,
        allowFull: true,
        minPx: 320,
        maxPx: 2560,
        minPct: 35,
        maxPct: 100,
      }),
    [widthSpec, allowAutoWidth]
  );

  const isPxWidth = parsedWidth?.kind === "px";
  const sliderMin = isPxWidth ? 360 : 40;
  const sliderMax = isPxWidth ? 1920 : 100;
  const sliderStep = isPxWidth ? 20 : 5;
  const sliderValue = isPxWidth
    ? Math.min(1920, Math.max(360, parsedWidth.value))
    : parsedWidth?.kind === "percent"
    ? parsedWidth.value
    : 100;

  function commitCustomWidth() {
    const parsed = parseWidthSpec(widthDraft, {
      allowAuto: allowAutoWidth,
      allowFull: true,
      minPx: 320,
      maxPx: 2560,
      minPct: 35,
      maxPct: 100,
    });
    if (parsed) {
      onChangeWidthSpec(parsed.normalized);
      setWidthDraft(parsed.normalized);
    } else {
      setWidthDraft(widthSpec);
    }
  }

  function commitCustomRowWidth() {
    const parsed = parseWidthSpec(rowWidthDraft, {
      allowAuto: true,
      allowFull: false,
      minPx: 280,
      maxPx: 1600,
      minPct: 20,
      maxPct: 100,
    });
    if (parsed) {
      onChangeRowCardWidth(parsed.normalized);
      setRowWidthDraft(parsed.normalized);
    } else {
      setRowWidthDraft(rowCardWidth);
    }
  }

  return (
    <div
      data-testid={`${testIdPrefix}-size-controls`}
      className={compact ? "space-y-2.5 text-xs" : "space-y-3 text-xs"}
    >
      {/* Container / Display Width */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            Display Width ({widthSpec === "full" ? "100% Full" : widthSpec})
          </span>
          {onReset && (
            <button
              type="button"
              data-testid={`${testIdPrefix}-reset-btn`}
              onClick={onReset}
              className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-0.5 text-[11px] font-mono text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span>Reset Layout</span>
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {widthPresets.map((preset) => {
            const active = widthSpec === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                aria-pressed={active}
                data-testid={`${testIdPrefix}-width-${preset.value.replace("%", "pct")}`}
                onClick={() => onChangeWidthSpec(preset.value)}
                className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                  active
                    ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                    : "border-border bg-elevated text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                }`}
              >
                {preset.label}
              </button>
            );
          })}

          <div className="inline-flex items-center gap-1">
            <input
              type="text"
              aria-label="Custom display width (% or px)"
              data-testid={`${testIdPrefix}-width-input`}
              value={widthDraft}
              onChange={(e) => setWidthDraft(e.target.value)}
              onBlur={commitCustomWidth}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitCustomWidth();
                }
              }}
              placeholder="e.g. 85% or 960px"
              className="w-28 rounded border border-border bg-canvas px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="button"
              data-testid={`${testIdPrefix}-width-apply-btn`}
              onClick={commitCustomWidth}
              className="rounded border border-border bg-elevated px-2 py-1 font-mono text-[11px] text-zinc-200 hover:border-emerald-500/50"
            >
              Apply
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 font-mono text-[10px] text-zinc-400">
            {isPxWidth ? "Width px" : "Width %"}
          </span>
          <input
            type="range"
            aria-label="Display width slider"
            data-testid={`${testIdPrefix}-width-slider`}
            min={sliderMin}
            max={sliderMax}
            step={sliderStep}
            value={sliderValue}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (isPxWidth) {
                onChangeWidthSpec(`${val}px`);
              } else {
                onChangeWidthSpec(val >= 100 ? "full" : `${val}%`);
              }
            }}
            className="h-1.5 flex-1 cursor-pointer accent-emerald-500"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-300">
            {isPxWidth ? `${sliderValue}px` : `${sliderValue}%`}
          </span>
        </div>
      </div>

      {/* 1-Row Horizontal Card Width */}
      {showRowCardWidth && (
        <div className="space-y-1.5 border-t border-border/60 pt-2">
          <span className="block font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            1-Row Card Width ({rowCardWidth})
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {ROW_CARD_WIDTH_PRESETS.map((preset) => {
              const active = rowCardWidth === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  aria-pressed={active}
                  data-testid={`${testIdPrefix}-rowwidth-${preset.value.replace("%", "pct")}`}
                  onClick={() => onChangeRowCardWidth(preset.value)}
                  className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                    active
                      ? "border-cyan-500 bg-cyan-500 font-semibold text-zinc-950"
                      : "border-border bg-elevated text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}

            <div className="inline-flex items-center gap-1">
              <input
                type="text"
                aria-label="Custom 1-row card width"
                data-testid={`${testIdPrefix}-rowwidth-input`}
                value={rowWidthDraft}
                onChange={(e) => setRowWidthDraft(e.target.value)}
                onBlur={commitCustomRowWidth}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitCustomRowWidth();
                  }
                }}
                placeholder="480px or 50%"
                className="w-28 rounded border border-border bg-canvas px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:border-cyan-500 focus:outline-none"
              />
              <button
                type="button"
                data-testid={`${testIdPrefix}-rowwidth-apply-btn`}
                onClick={commitCustomRowWidth}
                className="rounded border border-border bg-elevated px-2 py-1 font-mono text-[11px] text-zinc-200 hover:border-cyan-500/50"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Chart Height */}
      <div className="space-y-1.5 border-t border-border/60 pt-2">
        <span className="block font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
          Chart Height ({chartHeight > 0 ? `${chartHeight}px` : "Auto"})
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {CHART_HEIGHT_PRESETS.map((preset) => {
            const active = chartHeight === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                aria-pressed={active}
                data-testid={`${testIdPrefix}-height-${preset.value}`}
                onClick={() => onChangeChartHeight(preset.value)}
                className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                  active
                    ? "border-emerald-500 bg-emerald-500 font-semibold text-zinc-950"
                    : "border-border bg-elevated text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 font-mono text-[10px] text-zinc-400">
            Height px
          </span>
          <input
            type="range"
            aria-label="Chart height slider"
            data-testid={`${testIdPrefix}-height-slider`}
            min={MIN_CUSTOM_CHART_HEIGHT}
            max={MAX_CUSTOM_CHART_HEIGHT}
            step={10}
            value={chartHeight > 0 ? chartHeight : 200}
            onChange={(e) =>
              onChangeChartHeight(clampChartHeight(Number(e.target.value), 200))
            }
            className="h-1.5 flex-1 cursor-pointer accent-emerald-500"
          />
          <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-300">
            {chartHeight > 0 ? `${chartHeight}px` : "Auto"}
          </span>
        </div>
      </div>
    </div>
  );
}
