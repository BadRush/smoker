import type { CSSProperties } from "react";

export type LayoutPreset = "auto" | "single-col" | "single-row" | "cols";
export type FlowMode = "auto" | "slides" | "scroll";
export type ProbeLayoutMode = "auto" | "single";

export interface ParsedWidthSpec {
  kind: "auto" | "full" | "percent" | "px";
  value: number;
  normalized: string;
  cssValue: string;
}

export interface WidthParseOptions {
  allowAuto?: boolean;
  allowFull?: boolean;
  minPx?: number;
  maxPx?: number;
  minPct?: number;
  maxPct?: number;
}

export interface DashboardLayoutConfig {
  preset: LayoutPreset;
  customCols: number;
  widthSpec: string;
  rowCardWidth: string;
  chartHeight: number;
  probeLayout: ProbeLayoutMode;
}

export const DASHBOARD_LAYOUT_STORAGE_KEY = "smoker.dashboard.layout.v1";

export const VALID_LAYOUT_PRESETS = new Set<LayoutPreset>([
  "auto",
  "single-col",
  "single-row",
  "cols",
]);

export const VALID_FLOW_MODES = new Set<FlowMode>(["auto", "slides", "scroll"]);

export const CONTAINER_WIDTH_PRESETS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "full", label: "Full 100%" },
  { value: "90%", label: "90%" },
  { value: "75%", label: "75%" },
  { value: "1280px", label: "1280px" },
  { value: "960px", label: "960px" },
  { value: "720px", label: "720px" },
];

export const ROW_CARD_WIDTH_PRESETS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "auto", label: "Auto Fit" },
  { value: "380px", label: "380px" },
  { value: "480px", label: "480px" },
  { value: "640px", label: "640px" },
  { value: "50%", label: "50%" },
  { value: "100%", label: "100%" },
];

export const CHART_HEIGHT_PRESETS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 0, label: "Auto" },
  { value: 150, label: "Compact (150px)" },
  { value: 210, label: "Normal (210px)" },
  { value: 280, label: "Tall (280px)" },
  { value: 360, label: "XL (360px)" },
];

export const MIN_CUSTOM_CHART_HEIGHT = 120;
export const MAX_CUSTOM_CHART_HEIGHT = 520;

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutConfig = {
  preset: "auto",
  customCols: 2,
  widthSpec: "auto",
  rowCardWidth: "480px",
  chartHeight: 0,
  probeLayout: "auto",
};

export function clampColumnCount(raw: unknown, fallback = 2): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(6, Math.round(n)));
}

export function clampChartHeight(raw: unknown, fallback = 0): number {
  if (raw === "" || raw === null || raw === undefined) return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.max(
    MIN_CUSTOM_CHART_HEIGHT,
    Math.min(MAX_CUSTOM_CHART_HEIGHT, Math.round(n))
  );
}

export function parseWidthSpec(
  raw: string | null | undefined,
  options: WidthParseOptions = {}
): ParsedWidthSpec | null {
  if (!raw) return null;
  const {
    allowAuto = true,
    allowFull = true,
    minPx = 300,
    maxPx = 2560,
    minPct = 25,
    maxPct = 100,
  } = options;

  const clean = raw.trim().toLowerCase();
  if (!clean) return null;

  if (clean === "auto") {
    if (!allowAuto) return null;
    return {
      kind: "auto",
      value: 0,
      normalized: "auto",
      cssValue: "1600px",
    };
  }

  if (clean === "full" || clean === "100%") {
    if (!allowFull) {
      return {
        kind: "percent",
        value: maxPct,
        normalized: `${maxPct}%`,
        cssValue: `${maxPct}%`,
      };
    }
    return {
      kind: "full",
      value: 100,
      normalized: "full",
      cssValue: "100%",
    };
  }

  const pctMatch = /^(\d{1,3}(?:\.\d+)?)\s*%$/.exec(clean);
  if (pctMatch) {
    const num = Number(pctMatch[1]);
    if (!Number.isFinite(num)) return null;
    const clamped = Math.max(minPct, Math.min(maxPct, Math.round(num)));
    if (allowFull && clamped === 100) {
      return {
        kind: "full",
        value: 100,
        normalized: "full",
        cssValue: "100%",
      };
    }
    return {
      kind: "percent",
      value: clamped,
      normalized: `${clamped}%`,
      cssValue: `${clamped}%`,
    };
  }

  const pxMatch = /^(\d{2,4})(?:\s*px)?$/.exec(clean);
  if (pxMatch) {
    const num = Number(pxMatch[1]);
    if (!Number.isFinite(num)) return null;
    const clamped = Math.max(minPx, Math.min(maxPx, Math.round(num)));
    return {
      kind: "px",
      value: clamped,
      normalized: `${clamped}px`,
      cssValue: `${clamped}px`,
    };
  }

  return null;
}

export function resolveEffectivePixelWidth(
  spec: string,
  viewportPx: number,
  defaultPx = viewportPx
): number {
  const safeViewport = Math.max(320, Math.floor(viewportPx));
  const parsed = parseWidthSpec(spec);
  if (!parsed || parsed.kind === "auto") {
    return Math.min(safeViewport, Math.max(320, Math.floor(defaultPx)));
  }
  if (parsed.kind === "full") {
    return safeViewport;
  }
  if (parsed.kind === "percent") {
    return Math.max(320, Math.floor((safeViewport * parsed.value) / 100));
  }
  return Math.max(320, Math.min(safeViewport, parsed.value));
}

export function sanitizeDashboardLayoutConfig(
  raw: unknown
): DashboardLayoutConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_DASHBOARD_LAYOUT };
  }
  const obj = raw as Partial<DashboardLayoutConfig>;
  const preset: LayoutPreset = VALID_LAYOUT_PRESETS.has(
    obj.preset as LayoutPreset
  )
    ? (obj.preset as LayoutPreset)
    : DEFAULT_DASHBOARD_LAYOUT.preset;

  const customCols = clampColumnCount(
    obj.customCols,
    DEFAULT_DASHBOARD_LAYOUT.customCols
  );

  const parsedWidth = parseWidthSpec(obj.widthSpec);
  const widthSpec = parsedWidth
    ? parsedWidth.normalized
    : DEFAULT_DASHBOARD_LAYOUT.widthSpec;

  const parsedRowW = parseWidthSpec(obj.rowCardWidth, {
    allowAuto: true,
    allowFull: false,
    minPx: 280,
    maxPx: 1600,
    minPct: 20,
    maxPct: 100,
  });
  const rowCardWidth = parsedRowW
    ? parsedRowW.normalized
    : DEFAULT_DASHBOARD_LAYOUT.rowCardWidth;

  const chartHeight = clampChartHeight(
    obj.chartHeight,
    DEFAULT_DASHBOARD_LAYOUT.chartHeight
  );

  const probeLayout: ProbeLayoutMode =
    obj.probeLayout === "single" ? "single" : "auto";

  return {
    preset,
    customCols,
    widthSpec,
    rowCardWidth,
    chartHeight,
    probeLayout,
  };
}

export function isDefaultDashboardLayout(cfg: DashboardLayoutConfig): boolean {
  return (
    cfg.preset === DEFAULT_DASHBOARD_LAYOUT.preset &&
    cfg.customCols === DEFAULT_DASHBOARD_LAYOUT.customCols &&
    cfg.widthSpec === DEFAULT_DASHBOARD_LAYOUT.widthSpec &&
    cfg.rowCardWidth === DEFAULT_DASHBOARD_LAYOUT.rowCardWidth &&
    cfg.chartHeight === DEFAULT_DASHBOARD_LAYOUT.chartHeight &&
    cfg.probeLayout === DEFAULT_DASHBOARD_LAYOUT.probeLayout
  );
}

export function loadDashboardLayout(): DashboardLayoutConfig {
  if (typeof window === "undefined") {
    return { ...DEFAULT_DASHBOARD_LAYOUT };
  }
  try {
    const raw = window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DASHBOARD_LAYOUT };
    return sanitizeDashboardLayoutConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DASHBOARD_LAYOUT };
  }
}

export function saveDashboardLayout(cfg: DashboardLayoutConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      DASHBOARD_LAYOUT_STORAGE_KEY,
      JSON.stringify(sanitizeDashboardLayoutConfig(cfg))
    );
  } catch {
    // ignore storage quota errors
  }
}

export interface ResolvedDashboardGrid {
  containerMaxWidth: string | null;
  isRowStrip: boolean;
  gridClassName: string;
  gridStyle?: CSSProperties;
  rowCardStyle?: CSSProperties;
  probeGridClassName: string;
  activeSummary: string;
}

export function resolveDashboardGrid(
  cfg: DashboardLayoutConfig,
  assignedProbeCount = 2
): ResolvedDashboardGrid {
  const parsedWidth = parseWidthSpec(cfg.widthSpec);
  const containerMaxWidth =
    !parsedWidth || parsedWidth.kind === "auto" ? null : parsedWidth.cssValue;
  const isNarrowContainer =
    parsedWidth?.kind === "px" && parsedWidth.value < 960;

  const probeGridClassName =
    cfg.probeLayout === "single" || assignedProbeCount <= 1
      ? "grid grid-cols-1 gap-2.5"
      : "grid grid-cols-1 gap-2.5 sm:grid-cols-2";

  if (cfg.preset === "single-col") {
    return {
      containerMaxWidth,
      isRowStrip: false,
      gridClassName: "grid grid-cols-1 gap-4",
      probeGridClassName,
      activeSummary: "1 Col Full",
    };
  }

  if (cfg.preset === "single-row") {
    const rowW = parseWidthSpec(cfg.rowCardWidth, {
      allowAuto: true,
      allowFull: false,
      minPx: 280,
      maxPx: 1600,
      minPct: 20,
      maxPct: 100,
    });
    const cardWidth =
      !rowW || rowW.kind === "auto" ? "480px" : rowW.cssValue;
    return {
      containerMaxWidth,
      isRowStrip: true,
      gridClassName: "flex flex-nowrap items-stretch gap-4 overflow-x-auto pb-2",
      rowCardStyle: {
        width: cardWidth,
        minWidth: cardWidth,
        flexShrink: 0,
      },
      probeGridClassName,
      activeSummary: `1 Row (${rowW?.kind === "auto" ? "480px" : rowW?.normalized ?? "480px"})`,
    };
  }

  if (cfg.preset === "cols") {
    const cols = clampColumnCount(cfg.customCols, 2);
    return {
      containerMaxWidth,
      isRowStrip: false,
      gridClassName: "grid gap-4",
      gridStyle: {
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      },
      probeGridClassName,
      activeSummary: `${cols} Col${cols === 1 ? "" : "s"}`,
    };
  }

  // Adaptive Auto: 1 col when viewport < xl OR container manually narrowed < 960px, else 2 cols
  return {
    containerMaxWidth,
    isRowStrip: false,
    gridClassName: isNarrowContainer
      ? "grid grid-cols-1 gap-4"
      : "grid grid-cols-1 gap-4 xl:grid-cols-2",
    probeGridClassName,
    activeSummary: "Auto",
  };
}
