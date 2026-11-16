import type { MatrixCell, Target } from "./api";
import {
  clampChartHeight,
  clampColumnCount,
  parseWidthSpec,
  resolveEffectivePixelWidth,
  VALID_FLOW_MODES,
  VALID_LAYOUT_PRESETS,
  type FlowMode,
  type LayoutPreset,
} from "./display-layout";
import {
  groupItemsByProtocol,
  isValidProtocolFamily,
  matchesProtocolAndIpFilter,
  type IpFamilyFilter,
  type ProtocolFamily,
} from "./protocol-filters";
import type { CellStatus } from "./smoke-math";

export const UNGROUPED_GROUP_TOKEN = "ungrouped";
export const TV_CONFIG_STORAGE_KEY = "smoker.tv.config.v1";

export type TvOrientation = "landscape" | "portrait";
export type TvRange = "15m" | "1h" | "3h" | "6h" | "12h" | "24h" | "7d";

export const TV_RANGES: readonly TvRange[] = [
  "15m",
  "1h",
  "3h",
  "6h",
  "12h",
  "24h",
  "7d",
] as const;

export interface TvWallConfig {
  orientation: TvOrientation;
  groups: string[];
  protocols: ProtocolFamily[];
  ipVersion: IpFamilyFilter;
  splitByProtocol: boolean;
  rotateSec: number;
  cardsPerPage: number;
  range: TvRange;
  sound: boolean;
  layoutMode: LayoutPreset;
  customCols: number;
  flowMode: FlowMode;
  widthSpec: string;
  rowCardWidth: string;
  chartHeight: number;
}

export interface TargetHealthSummary {
  target: Target;
  worstStatus: CellStatus;
  maxLossPct: number;
  maxP50Ms: number | null;
  maxP95Ms: number | null;
  cells: MatrixCell[];
  impairedProbeIds: string[];
  isPinnedVip: boolean;
  isImpaired: boolean;
}

export interface TvPageSlide {
  kind: "highlight" | "grid";
  label: string;
  items: TargetHealthSummary[];
}

export interface TvGridLayout {
  cols: number;
  rows: number;
  cardsPerPage: number;
  cardWidth: number;
  cardHeight: number;
  panelWidth: number;
  panelHeight: number;
  aspectRatio: number;
  horizontalScroll?: boolean;
}

const VALID_ROTATE = new Set([0, 10, 15, 30, 60]);
export const MANUAL_CARD_OPTIONS = [4, 6, 8, 9, 12, 16] as const;
const VALID_CARDS = new Set([0, ...MANUAL_CARD_OPTIONS]);
const VALID_RANGES = new Set<string>(TV_RANGES);

export const DEFAULT_TV_CONFIG: TvWallConfig = {
  orientation: "landscape",
  groups: [],
  protocols: [],
  ipVersion: "all",
  splitByProtocol: false,
  rotateSec: 0,
  cardsPerPage: 0, // 0 = Auto Best Fit
  range: "3h",
  sound: false,
  layoutMode: "auto",
  customCols: 0,
  flowMode: "auto",
  widthSpec: "full",
  rowCardWidth: "auto",
  chartHeight: 0,
};

function sanitizeTvWidthSpec(raw: string | null | undefined): string {
  const parsed = parseWidthSpec(raw, {
    allowAuto: false,
    allowFull: true,
    minPx: 320,
    maxPx: 2560,
    minPct: 35,
    maxPct: 100,
  });
  return parsed ? parsed.normalized : DEFAULT_TV_CONFIG.widthSpec;
}

function sanitizeTvRowCardWidth(raw: string | null | undefined): string {
  const parsed = parseWidthSpec(raw, {
    allowAuto: true,
    allowFull: false,
    minPx: 280,
    maxPx: 1600,
    minPct: 20,
    maxPct: 100,
  });
  return parsed ? parsed.normalized : DEFAULT_TV_CONFIG.rowCardWidth;
}

export function sanitizeTvConfig(raw: unknown): TvWallConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_TV_CONFIG };
  }
  const obj = raw as Partial<TvWallConfig>;
  const orientation: TvOrientation =
    obj.orientation === "portrait" ? "portrait" : "landscape";
  const groups = Array.isArray(obj.groups)
    ? obj.groups.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const protocols: ProtocolFamily[] = [];
  const seenProto = new Set<ProtocolFamily>();
  if (Array.isArray(obj.protocols)) {
    for (const part of obj.protocols) {
      const clean = String(part).trim().toLowerCase();
      if (isValidProtocolFamily(clean) && !seenProto.has(clean)) {
        seenProto.add(clean);
        protocols.push(clean);
      }
    }
  }
  const ipVersion: IpFamilyFilter =
    obj.ipVersion === "ipv4" || obj.ipVersion === "ipv6" ? obj.ipVersion : "all";
  const splitByProtocol = Boolean(obj.splitByProtocol);
  const rotateSec =
    typeof obj.rotateSec === "number" && VALID_ROTATE.has(obj.rotateSec)
      ? obj.rotateSec
      : DEFAULT_TV_CONFIG.rotateSec;
  const cardsPerPage =
    typeof obj.cardsPerPage === "number" && VALID_CARDS.has(obj.cardsPerPage)
      ? obj.cardsPerPage
      : DEFAULT_TV_CONFIG.cardsPerPage;
  const range: TvRange = VALID_RANGES.has(String(obj.range))
    ? (obj.range as TvRange)
    : DEFAULT_TV_CONFIG.range;
  const sound = Boolean(obj.sound);
  const layoutMode: LayoutPreset = VALID_LAYOUT_PRESETS.has(
    obj.layoutMode as LayoutPreset
  )
    ? (obj.layoutMode as LayoutPreset)
    : DEFAULT_TV_CONFIG.layoutMode;
  const rawCols = typeof obj.customCols === "number" ? obj.customCols : Number(obj.customCols);
  const customCols =
    Number.isFinite(rawCols) && rawCols > 0 ? clampColumnCount(rawCols, 0) : 0;
  const flowMode: FlowMode = VALID_FLOW_MODES.has(obj.flowMode as FlowMode)
    ? (obj.flowMode as FlowMode)
    : DEFAULT_TV_CONFIG.flowMode;
  const widthSpec = sanitizeTvWidthSpec(obj.widthSpec);
  const rowCardWidth = sanitizeTvRowCardWidth(obj.rowCardWidth);
  const chartHeight = clampChartHeight(
    obj.chartHeight,
    DEFAULT_TV_CONFIG.chartHeight
  );

  return {
    orientation,
    groups,
    protocols,
    ipVersion,
    splitByProtocol,
    rotateSec,
    cardsPerPage,
    range,
    sound,
    layoutMode,
    customCols,
    flowMode,
    widthSpec,
    rowCardWidth,
    chartHeight,
  };
}

export function loadTvConfigFromStorage(): TvWallConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TV_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeTvConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveTvConfigToStorage(cfg: TvWallConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      TV_CONFIG_STORAGE_KEY,
      JSON.stringify(sanitizeTvConfig(cfg))
    );
  } catch {
    // ignore storage quota errors
  }
}

export function parseTvConfig(search: string): TvWallConfig {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);

  const oriParam = params.get("orientation");
  const orientation: TvOrientation =
    oriParam === "portrait" ? "portrait" : "landscape";

  const groupsParam = params.get("groups") ?? "";
  const groups = groupsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const protocolsParam = params.get("protocols") ?? "";
  const protocols: ProtocolFamily[] = [];
  const seenProto = new Set<ProtocolFamily>();
  for (const part of protocolsParam.split(",")) {
    const clean = part.trim().toLowerCase();
    if (isValidProtocolFamily(clean) && !seenProto.has(clean)) {
      seenProto.add(clean);
      protocols.push(clean);
    }
  }

  const ipParam = (params.get("ip") ?? "").trim().toLowerCase();
  const ipVersion: IpFamilyFilter =
    ipParam === "ipv4" || ipParam === "ipv6" ? ipParam : "all";

  const splitParam = (params.get("split") ?? "").trim().toLowerCase();
  const splitByProtocol = splitParam === "protocol" || splitParam === "1" || splitParam === "true";

  const rotateNum = Number(params.get("rotate"));
  const rotateSec =
    params.has("rotate") && VALID_ROTATE.has(rotateNum)
      ? rotateNum
      : DEFAULT_TV_CONFIG.rotateSec;

  const cardsRaw = params.get("cards");
  let cardsPerPage = DEFAULT_TV_CONFIG.cardsPerPage;
  if (cardsRaw === "auto" || cardsRaw === "0") {
    cardsPerPage = 0;
  } else if (cardsRaw !== null) {
    const cardsNum = Number(cardsRaw);
    if (Number.isInteger(cardsNum) && VALID_CARDS.has(cardsNum)) {
      cardsPerPage = cardsNum;
    }
  }

  const rangeParam = params.get("range") ?? "";
  const range: TvRange = VALID_RANGES.has(rangeParam)
    ? (rangeParam as TvRange)
    : DEFAULT_TV_CONFIG.range;

  const soundParam = params.get("sound");
  const sound = soundParam === "1" || soundParam === "true";

  const layoutParam = (params.get("layout") ?? "").trim().toLowerCase();
  const layoutMode: LayoutPreset = VALID_LAYOUT_PRESETS.has(
    layoutParam as LayoutPreset
  )
    ? (layoutParam as LayoutPreset)
    : DEFAULT_TV_CONFIG.layoutMode;

  const colsRaw = params.get("cols");
  const colsNum = colsRaw ? Number(colsRaw) : 0;
  const customCols =
    Number.isFinite(colsNum) && colsNum > 0
      ? clampColumnCount(colsNum, 0)
      : DEFAULT_TV_CONFIG.customCols;

  const flowParam = (params.get("flow") ?? "").trim().toLowerCase();
  const flowMode: FlowMode = VALID_FLOW_MODES.has(flowParam as FlowMode)
    ? (flowParam as FlowMode)
    : DEFAULT_TV_CONFIG.flowMode;

  const widthSpec = sanitizeTvWidthSpec(params.get("width"));
  const rowCardWidth = sanitizeTvRowCardWidth(params.get("rowW"));
  const chartHeight = clampChartHeight(
    params.get("chartH"),
    DEFAULT_TV_CONFIG.chartHeight
  );

  return {
    orientation,
    groups,
    protocols,
    ipVersion,
    splitByProtocol,
    rotateSec,
    cardsPerPage,
    range,
    sound,
    layoutMode,
    customCols,
    flowMode,
    widthSpec,
    rowCardWidth,
    chartHeight,
  };
}

export function serializeTvConfig(cfg: TvWallConfig): string {
  const params = new URLSearchParams();
  params.set("orientation", cfg.orientation);
  if (cfg.groups.length > 0) {
    params.set("groups", cfg.groups.join(","));
  }
  if (cfg.protocols.length > 0) {
    params.set("protocols", cfg.protocols.join(","));
  }
  if (cfg.ipVersion !== "all") {
    params.set("ip", cfg.ipVersion);
  }
  if (cfg.splitByProtocol) {
    params.set("split", "protocol");
  }
  params.set("rotate", String(cfg.rotateSec));
  params.set("cards", cfg.cardsPerPage === 0 ? "auto" : String(cfg.cardsPerPage));
  params.set("range", cfg.range);
  params.set("sound", cfg.sound ? "1" : "0");
  if (cfg.layoutMode !== DEFAULT_TV_CONFIG.layoutMode) {
    params.set("layout", cfg.layoutMode);
  }
  if (cfg.customCols > 0) {
    params.set("cols", String(clampColumnCount(cfg.customCols, 1)));
  }
  if (cfg.flowMode !== DEFAULT_TV_CONFIG.flowMode) {
    params.set("flow", cfg.flowMode);
  }
  if (cfg.widthSpec !== DEFAULT_TV_CONFIG.widthSpec) {
    params.set("width", cfg.widthSpec);
  }
  if (cfg.rowCardWidth !== DEFAULT_TV_CONFIG.rowCardWidth) {
    params.set("rowW", cfg.rowCardWidth);
  }
  if (cfg.chartHeight > 0) {
    params.set("chartH", String(clampChartHeight(cfg.chartHeight, 0)));
  }
  return params.toString();
}

function statusSeverity(status: CellStatus | string): number {
  switch (status) {
    case "down":
      return 4;
    case "loss":
      return 3;
    case "degraded":
      return 2;
    case "healthy":
      return 1;
    default:
      return 0;
  }
}

export function summarizeTargetHealth(
  target: Target,
  allCells: MatrixCell[]
): TargetHealthSummary {
  const cells = allCells.filter((c) => c.target_id === target.id);
  let worstStatus: CellStatus = "unknown";
  let worstRank = -1;
  let maxLossPct = 0;
  let maxP50Ms: number | null = null;
  let maxP95Ms: number | null = null;
  const impairedProbeIds: string[] = [];

  for (const c of cells) {
    const rank = statusSeverity(c.status);
    if (rank > worstRank) {
      worstRank = rank;
      worstStatus = (c.status as CellStatus) || "unknown";
    }
    if (c.status === "down" || c.status === "loss" || c.status === "degraded") {
      impairedProbeIds.push(c.probe_id);
    }
    if (c.loss_pct > maxLossPct) {
      maxLossPct = c.loss_pct;
    }
    if (c.p50_ms !== null && (maxP50Ms === null || c.p50_ms > maxP50Ms)) {
      maxP50Ms = c.p50_ms;
    }
    if (c.p95_ms !== null && (maxP95Ms === null || c.p95_ms > maxP95Ms)) {
      maxP95Ms = c.p95_ms;
    }
  }

  const isImpaired =
    worstStatus === "down" ||
    worstStatus === "loss" ||
    worstStatus === "degraded";
  const isPinnedVip = Boolean(target.pinned_on_tv);

  return {
    target,
    worstStatus,
    maxLossPct,
    maxP50Ms,
    maxP95Ms,
    cells,
    impairedProbeIds,
    isPinnedVip,
    isImpaired,
  };
}

const TARGET_GRAPH_RATIO = 7 / 3;
const GRID_GAP_PX = 10;
const CARD_CHROME_W = 18;
const CARD_CHROME_H = 86;
const MIN_PANEL_H = 108;

export function selectFocalProbeCell(
  cells: MatrixCell[],
  preferredProbeId?: string | null
): MatrixCell | null {
  if (cells.length === 0) return null;
  if (preferredProbeId) {
    const manual = cells.find((c) => c.probe_id === preferredProbeId);
    if (manual) return manual;
  }
  let best = cells[0];
  let bestRank = -1;
  let bestLatency = -1;
  for (const c of cells) {
    const rank = statusSeverity(c.status);
    const latency = c.p95_ms ?? c.p50_ms ?? 0;
    if (rank > bestRank || (rank === bestRank && latency > bestLatency)) {
      best = c;
      bestRank = rank;
      bestLatency = latency;
    }
  }
  return best;
}

export function resolveTvFlowMode(
  cfg: Pick<TvWallConfig, "orientation" | "layoutMode" | "flowMode">,
  stageWidth: number,
  stageHeight: number
): "slides" | "scroll" {
  if (cfg.flowMode === "slides" || cfg.flowMode === "scroll") {
    return cfg.flowMode;
  }
  if (cfg.layoutMode === "single-row") {
    return "slides";
  }
  const isPortrait = cfg.orientation === "portrait" || stageHeight > stageWidth * 1.15;
  if (isPortrait || cfg.layoutMode === "single-col") {
    return "scroll";
  }
  return "slides";
}

function resolveScrollPanelHeight(
  panelWidth: number,
  cols: number,
  safeW: number,
  customChartH: number
): number {
  if (customChartH > 0) return customChartH;
  const ratio = cols === 1 && safeW >= 1000 ? 3.5 : 2.35;
  return Math.max(190, Math.min(310, Math.round(panelWidth / ratio)));
}

export function computeBestFitGrid(input: {
  width: number;
  height: number;
  orientation: TvOrientation;
  cardsOverride?: number;
  maxItems?: number;
  layoutMode?: LayoutPreset;
  customCols?: number;
  chartHeight?: number;
  widthSpec?: string;
  rowCardWidth?: string;
  scrollMode?: boolean;
}): TvGridLayout {
  const baseW = Math.max(320, Math.floor(input.width));
  const safeW = input.widthSpec
    ? resolveEffectivePixelWidth(input.widthSpec, baseW)
    : baseW;
  const safeH = Math.max(300, Math.floor(input.height));
  const isPortrait = input.orientation === "portrait" || safeH > safeW * 1.15;
  const layoutMode: LayoutPreset = input.layoutMode ?? "auto";
  const customChartH =
    input.chartHeight && input.chartHeight > 0
      ? clampChartHeight(input.chartHeight, 0)
      : 0;
  const targetMinCardW = 360;
  const idealBalancedCardW = 440;
  const maxColsCap = isPortrait ? (safeW < 900 ? 1 : 2) : safeW >= 2400 ? 5 : 4;
  const itemLimit =
    input.maxItems && input.maxItems > 0 ? input.maxItems : undefined;

  if (layoutMode === "single-col") {
    const cardWidth = safeW;
    const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
    if (input.scrollMode) {
      const panelHeight = resolveScrollPanelHeight(panelWidth, 1, safeW, customChartH);
      const cardHeight = panelHeight + CARD_CHROME_H;
      const rows = Math.max(1, itemLimit ?? 1);
      return {
        cols: 1,
        rows,
        cardsPerPage: rows,
        cardWidth,
        cardHeight,
        panelWidth,
        panelHeight,
        aspectRatio: Number((panelWidth / Math.max(1, panelHeight)).toFixed(2)),
      };
    }
    const idealPanelH =
      customChartH > 0
        ? customChartH
        : Math.max(150, Math.min(280, Math.round(panelWidth / 3.2)));
    const idealCardH = idealPanelH + CARD_CHROME_H;
    const rawRows =
      input.cardsOverride && input.cardsOverride > 0
        ? input.cardsOverride
        : Math.max(1, Math.floor((safeH + GRID_GAP_PX) / (idealCardH + GRID_GAP_PX)));
    const rows = itemLimit ? Math.min(rawRows, itemLimit) : Math.max(1, rawRows);
    const maxFitCardH = Math.floor((safeH - GRID_GAP_PX * (rows - 1)) / rows);
    const panelHeight = Math.max(
      MIN_PANEL_H,
      Math.min(idealPanelH, maxFitCardH - CARD_CHROME_H)
    );
    const cardHeight = panelHeight + CARD_CHROME_H;
    return {
      cols: 1,
      rows,
      cardsPerPage: rows,
      cardWidth,
      cardHeight,
      panelWidth,
      panelHeight,
      aspectRatio: Number((panelWidth / Math.max(1, panelHeight)).toFixed(2)),
    };
  }

  if (layoutMode === "single-row") {
    const parsedRowW =
      input.rowCardWidth && input.rowCardWidth !== "auto"
        ? parseWidthSpec(input.rowCardWidth, {
            allowAuto: false,
            allowFull: false,
            minPx: 280,
            maxPx: 1600,
            minPct: 20,
            maxPct: 100,
          })
        : null;

    let cols: number;
    let cardWidth: number;
    let horizontalScroll = false;

    if (input.customCols && input.customCols > 0) {
      cols = clampColumnCount(input.customCols, 2);
      if (itemLimit) cols = Math.min(cols, itemLimit);
      const naturalW = Math.floor((safeW - GRID_GAP_PX * (cols - 1)) / cols);
      if (parsedRowW) {
        const explicitW =
          parsedRowW.kind === "percent"
            ? Math.floor((safeW * parsedRowW.value) / 100) - GRID_GAP_PX
            : parsedRowW.value;
        if (cols * explicitW + GRID_GAP_PX * (cols - 1) > safeW) {
          cardWidth = Math.max(240, explicitW);
          horizontalScroll = true;
        } else {
          cardWidth = Math.max(240, Math.min(naturalW, explicitW));
        }
      } else {
        cardWidth = naturalW;
      }
    } else if (parsedRowW) {
      if (parsedRowW.kind === "percent") {
        cols = Math.max(1, Math.min(6, Math.round(100 / parsedRowW.value)));
        if (itemLimit) cols = Math.min(cols, itemLimit);
        cardWidth = Math.max(240, Math.floor((safeW * parsedRowW.value) / 100) - GRID_GAP_PX);
        horizontalScroll =
          cols * cardWidth + GRID_GAP_PX * Math.max(0, cols - 1) > safeW;
      } else {
        cardWidth = parsedRowW.value;
        const fitCols = Math.max(
          1,
          Math.floor((safeW + GRID_GAP_PX) / (cardWidth + GRID_GAP_PX))
        );
        const desiredCols = itemLimit ? Math.max(fitCols, itemLimit) : Math.max(fitCols, 1);
        cols = itemLimit ? Math.min(desiredCols, itemLimit) : fitCols;
        horizontalScroll =
          cols * cardWidth + GRID_GAP_PX * Math.max(0, cols - 1) > safeW;
      }
    } else {
      const baseAutoCols = isPortrait
        ? 1
        : safeW >= 1800
        ? 4
        : safeW >= 1150
        ? 3
        : safeW >= 720
        ? 2
        : 1;
      cols = itemLimit ? Math.min(baseAutoCols, itemLimit) : baseAutoCols;
      cardWidth = Math.floor((safeW - GRID_GAP_PX * (cols - 1)) / cols);
    }

    const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
    const maxRowPanelH = Math.max(MIN_PANEL_H, safeH - CARD_CHROME_H);
    const panelHeight =
      customChartH > 0
        ? Math.max(MIN_PANEL_H, Math.min(customChartH, maxRowPanelH))
        : maxRowPanelH;
    const cardHeight = panelHeight + CARD_CHROME_H;
    return {
      cols,
      rows: 1,
      cardsPerPage: horizontalScroll ? Math.max(cols, itemLimit ?? 24) : cols,
      cardWidth,
      cardHeight,
      panelWidth,
      panelHeight,
      aspectRatio: Number((panelWidth / Math.max(1, panelHeight)).toFixed(2)),
      horizontalScroll,
    };
  }

  if (layoutMode === "cols") {
    const cols = clampColumnCount(
      input.customCols,
      isPortrait && safeW < 900 ? 1 : 2
    );
    const cardWidth =
      cols === 1
        ? safeW
        : Math.floor((safeW - GRID_GAP_PX * (cols - 1)) / cols);
    const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
    if (input.scrollMode) {
      const panelHeight = resolveScrollPanelHeight(
        panelWidth,
        cols,
        safeW,
        customChartH
      );
      const cardHeight = panelHeight + CARD_CHROME_H;
      const rows = Math.max(1, Math.ceil((itemLimit ?? cols) / cols));
      return {
        cols,
        rows,
        cardsPerPage: rows * cols,
        cardWidth,
        cardHeight,
        panelWidth,
        panelHeight,
        aspectRatio: Number((panelWidth / Math.max(1, panelHeight)).toFixed(2)),
      };
    }

    const targetCount =
      input.cardsOverride && input.cardsOverride > 0
        ? itemLimit
          ? Math.min(input.cardsOverride, itemLimit)
          : input.cardsOverride
        : 0;
    const idealPanelH =
      customChartH > 0
        ? customChartH
        : Math.round(panelWidth / (cols === 1 ? 3.2 : TARGET_GRAPH_RATIO));
    const idealCardH = idealPanelH + CARD_CHROME_H;
    let rows =
      targetCount > 0
        ? Math.max(1, Math.ceil(targetCount / cols))
        : Math.max(1, Math.floor((safeH + GRID_GAP_PX) / (idealCardH + GRID_GAP_PX)));
    if (itemLimit && targetCount === 0) {
      rows = Math.min(rows, Math.max(1, Math.ceil(itemLimit / cols)));
    }
    const maxFitCardH = Math.floor((safeH - GRID_GAP_PX * (rows - 1)) / rows);
    const panelHeight = Math.max(
      MIN_PANEL_H,
      Math.min(idealPanelH, maxFitCardH - CARD_CHROME_H)
    );
    const cardHeight = panelHeight + CARD_CHROME_H;
    return {
      cols,
      rows,
      cardsPerPage:
        input.cardsOverride && input.cardsOverride > 0
          ? input.cardsOverride
          : cols * rows,
      cardWidth,
      cardHeight,
      panelWidth,
      panelHeight,
      aspectRatio: Number((panelWidth / Math.max(1, panelHeight)).toFixed(2)),
    };
  }

  if (input.scrollMode) {
    const autoCols = isPortrait
      ? safeW < 900
        ? 1
        : 2
      : safeW >= 1400
      ? 3
      : safeW >= 760
      ? 2
      : 1;
    const cols = itemLimit ? Math.min(autoCols, itemLimit) : autoCols;
    const cardWidth =
      cols === 1
        ? safeW
        : Math.floor((safeW - GRID_GAP_PX * (cols - 1)) / cols);
    const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
    const panelHeight = resolveScrollPanelHeight(
      panelWidth,
      cols,
      safeW,
      customChartH
    );
    const cardHeight = panelHeight + CARD_CHROME_H;
    const rows = Math.max(1, Math.ceil((itemLimit ?? cols) / cols));
    return {
      cols,
      rows,
      cardsPerPage: rows * cols,
      cardWidth,
      cardHeight,
      panelWidth,
      panelHeight,
      aspectRatio: Number((panelWidth / Math.max(1, panelHeight)).toFixed(2)),
    };
  }

  if (input.cardsOverride && input.cardsOverride > 0) {
    const targetCount = itemLimit
      ? Math.min(input.cardsOverride, itemLimit)
      : input.cardsOverride;
    let chosen: TvGridLayout | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    const maxTryCols = Math.min(
      Math.max(1, targetCount),
      maxColsCap
    );
    for (let cols = 1; cols <= maxTryCols; cols++) {
      const rows = Math.max(1, Math.ceil(targetCount / cols));
      const rawCardW = (safeW - GRID_GAP_PX * (cols - 1)) / cols;
      const cardWidth = cols === 1 ? safeW : Math.floor(rawCardW);
      const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
      const idealPanelH =
        customChartH > 0
          ? customChartH
          : Math.round(panelWidth / TARGET_GRAPH_RATIO);
      const maxFitCardH = Math.floor(
        (safeH - GRID_GAP_PX * (rows - 1)) / rows
      );
      const maxFitPanelH = Math.max(MIN_PANEL_H, maxFitCardH - CARD_CHROME_H);
      const panelHeight = Math.min(idealPanelH, maxFitPanelH);
      const cardHeight = panelHeight + CARD_CHROME_H;
      const aspectRatio = panelWidth / Math.max(1, panelHeight);

      const overflowPenalty = rows * cardHeight + GRID_GAP_PX * (rows - 1) > safeH ? 50 : 0;
      const narrowPenalty = cardWidth < targetMinCardW && cols > 1 ? 12 : 0;
      const ratioPenalty = Math.abs(aspectRatio - TARGET_GRAPH_RATIO) * 8;
      const emptySlots = cols * rows - targetCount;
      const cost =
        overflowPenalty +
        narrowPenalty +
        ratioPenalty +
        emptySlots * 0.6 +
        Math.abs(cardWidth - idealBalancedCardW) / 450;

      if (cost < bestCost) {
        bestCost = cost;
        chosen = {
          cols,
          rows,
          cardsPerPage: input.cardsOverride,
          cardWidth,
          cardHeight,
          panelWidth,
          panelHeight,
          aspectRatio: Number(aspectRatio.toFixed(2)),
        };
      }
    }
    if (chosen) return chosen;
  }

  // Auto Best-Fit: pick (cols x rows) that keeps ~7:3 graph panels in the balanced width band
  let bestAuto: TvGridLayout | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  const upperCols = itemLimit ? Math.min(maxColsCap, itemLimit) : maxColsCap;
  for (let cols = 1; cols <= upperCols; cols++) {
    const rawCardW = (safeW - GRID_GAP_PX * (cols - 1)) / cols;
    if (cols > 1 && rawCardW < targetMinCardW) {
      continue;
    }
    const cardWidth = cols === 1 ? safeW : Math.floor(rawCardW);
    const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
    const idealPanelH =
      customChartH > 0
        ? customChartH
        : Math.round(panelWidth / TARGET_GRAPH_RATIO);
    const idealCardH = idealPanelH + CARD_CHROME_H;

    let rows = Math.max(
      1,
      Math.floor((safeH + GRID_GAP_PX) / (idealCardH + GRID_GAP_PX))
    );
    let panelHeight = idealPanelH;

    // On ultra-short screens (e.g. 1024x600), gently allow 2 rows of slightly wider strips
    // instead of wasting nearly half the screen on a single row.
    if (
      customChartH === 0 &&
      rows === 1 &&
      safeH >= 470 &&
      cols >= 2 &&
      (!itemLimit || itemLimit > cols)
    ) {
      const twoRowCardH = Math.floor((safeH - GRID_GAP_PX) / 2);
      const twoRowPanelH = twoRowCardH - CARD_CHROME_H;
      if (twoRowPanelH >= 145 && panelWidth / twoRowPanelH <= 3.1) {
        rows = 2;
        panelHeight = twoRowPanelH;
      }
    }

    if (itemLimit) {
      rows = Math.min(rows, Math.max(1, Math.ceil(itemLimit / cols)));
    }

    const maxFitCardH = Math.floor((safeH - GRID_GAP_PX * (rows - 1)) / rows);
    panelHeight = Math.max(MIN_PANEL_H, Math.min(panelHeight, maxFitCardH - CARD_CHROME_H));
    const cardHeight = panelHeight + CARD_CHROME_H;
    const cardsPerPage = cols * rows;
    const aspectRatio = panelWidth / Math.max(1, panelHeight);

    const usedW = cols * cardWidth + GRID_GAP_PX * (cols - 1);
    const usedH = rows * cardHeight + GRID_GAP_PX * (rows - 1);
    const areaFill = (usedW * usedH) / (safeW * safeH);
    const widthSweetSpot =
      cardWidth >= 360 && cardWidth <= 510
        ? 1.5
        : -Math.abs(cardWidth - idealBalancedCardW) / 300;
    const ratioFit = -Math.abs(aspectRatio - TARGET_GRAPH_RATIO) * 2.5;
    const score =
      areaFill * 4 +
      widthSweetSpot +
      ratioFit +
      Math.min(cardsPerPage, 16) * 0.12;

    if (score > bestScore) {
      bestScore = score;
      bestAuto = {
        cols,
        rows,
        cardsPerPage,
        cardWidth,
        cardHeight,
        panelWidth,
        panelHeight,
        aspectRatio: Number(aspectRatio.toFixed(2)),
      };
    }
  }

  if (bestAuto) return bestAuto;

  // Ultra-narrow fallback (< 720px)
  const panelWidth = Math.max(200, safeW - CARD_CHROME_W);
  const panelHeight = Math.max(
    MIN_PANEL_H,
    Math.min(
      customChartH > 0 ? customChartH : Math.round(panelWidth / TARGET_GRAPH_RATIO),
      safeH - CARD_CHROME_H
    )
  );
  return {
    cols: 1,
    rows: 1,
    cardsPerPage: 1,
    cardWidth: safeW,
    cardHeight: panelHeight + CARD_CHROME_H,
    panelWidth,
    panelHeight,
    aspectRatio: Number((panelWidth / Math.max(1, panelHeight)).toFixed(2)),
  };
}

export function partitionTargetsForTv(
  targets: Target[],
  cells: MatrixCell[],
  cfg: Pick<TvWallConfig, "groups" | "cardsPerPage"> &
    Partial<Pick<TvWallConfig, "protocols" | "ipVersion" | "splitByProtocol">>,
  effectiveCardsPerPage?: number
): {
  allSummaries: TargetHealthSummary[];
  pinnedAlerts: TargetHealthSummary[];
  highlightItems: TargetHealthSummary[];
  pages: TargetHealthSummary[][];
  slides: TvPageSlide[];
  highlightSlideIdx: number | null;
  totalFiltered: number;
} {
  const groupSet = new Set(cfg.groups);
  const includeUngrouped = groupSet.has(UNGROUPED_GROUP_TOKEN);
  const protocols = cfg.protocols ?? [];
  const ipVersion = cfg.ipVersion ?? "all";

  const filtered = targets.filter((t) => {
    if (!t.enabled) return false;
    if (groupSet.size > 0) {
      if (!t.group_id) {
        if (!includeUngrouped) return false;
      } else if (!groupSet.has(t.group_id)) {
        return false;
      }
    }
    return matchesProtocolAndIpFilter(t, protocols, ipVersion);
  });

  const summaries = filtered.map((t) => summarizeTargetHealth(t, cells));

  const pinnedAlerts = summaries
    .filter((s) => s.isImpaired)
    .sort((a, b) => {
      const rankDiff = statusSeverity(b.worstStatus) - statusSeverity(a.worstStatus);
      if (rankDiff !== 0) return rankDiff;
      if (b.maxLossPct !== a.maxLossPct) return b.maxLossPct - a.maxLossPct;
      return (b.maxP95Ms ?? 0) - (a.maxP95Ms ?? 0);
    });

  const highlightItems = summaries
    .filter((s) => s.isImpaired || s.isPinnedVip)
    .sort((a, b) => {
      const rankDiff = statusSeverity(b.worstStatus) - statusSeverity(a.worstStatus);
      if (rankDiff !== 0) return rankDiff;
      if (a.isImpaired !== b.isImpaired) return a.isImpaired ? -1 : 1;
      if (b.maxLossPct !== a.maxLossPct) return b.maxLossPct - a.maxLossPct;
      return (b.maxP95Ms ?? 0) - (a.maxP95Ms ?? 0);
    });

  // Regular grid pages follow fixed override or dynamically computed Best Fit size
  const resolvedCount =
    cfg.cardsPerPage > 0 ? cfg.cardsPerPage : effectiveCardsPerPage ?? 12;
  const pageSize = Math.max(1, resolvedCount);
  const pages: TargetHealthSummary[][] = [];
  const slides: TvPageSlide[] = [];

  if (cfg.splitByProtocol && summaries.length > 0) {
    const sections = groupItemsByProtocol(summaries, (s) => s.target);
    for (const sec of sections) {
      const secPages: TargetHealthSummary[][] = [];
      for (let i = 0; i < sec.items.length; i += pageSize) {
        const chunk = sec.items.slice(i, i + pageSize);
        secPages.push(chunk);
        pages.push(chunk);
      }
      secPages.forEach((chunk, idx) => {
        slides.push({
          kind: "grid",
          label: `${sec.family.slideTitle} ${idx + 1}/${secPages.length}`,
          items: chunk,
        });
      });
    }
  } else {
    for (let i = 0; i < summaries.length; i += pageSize) {
      pages.push(summaries.slice(i, i + pageSize));
    }
    if (pages.length === 0) {
      pages.push([]);
    }
    pages.forEach((p, idx) => {
      slides.push({
        kind: "grid",
        label: `GRID ${idx + 1}/${pages.length}`,
        items: p,
      });
    });
  }

  let highlightSlideIdx: number | null = null;
  if (highlightItems.length > 0) {
    highlightSlideIdx = slides.length;
    const spotlightCap = Math.max(4, Math.min(pageSize, 12));
    slides.push({
      kind: "highlight",
      label: `SPOTLIGHT (${highlightItems.length})`,
      items: highlightItems.slice(0, spotlightCap),
    });
  }

  return {
    allSummaries: summaries,
    pinnedAlerts,
    highlightItems,
    pages,
    slides,
    highlightSlideIdx,
    totalFiltered: summaries.length,
  };
}
