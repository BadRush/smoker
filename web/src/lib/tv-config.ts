import type { MatrixCell, Target } from "./api";
import type { CellStatus } from "./smoke-math";

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
  rotateSec: number;
  cardsPerPage: number;
  range: TvRange;
  sound: boolean;
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
}

const VALID_ROTATE = new Set([0, 10, 15, 30, 60]);
export const MANUAL_CARD_OPTIONS = [4, 6, 8, 9, 12, 16] as const;
const VALID_CARDS = new Set([0, ...MANUAL_CARD_OPTIONS]);
const VALID_RANGES = new Set<string>(TV_RANGES);

export const DEFAULT_TV_CONFIG: TvWallConfig = {
  orientation: "landscape",
  groups: [],
  rotateSec: 0,
  cardsPerPage: 0, // 0 = Auto Best Fit
  range: "3h",
  sound: false,
};

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

  return {
    orientation,
    groups,
    rotateSec,
    cardsPerPage,
    range,
    sound,
  };
}

export function serializeTvConfig(cfg: TvWallConfig): string {
  const params = new URLSearchParams();
  params.set("orientation", cfg.orientation);
  if (cfg.groups.length > 0) {
    params.set("groups", cfg.groups.join(","));
  }
  params.set("rotate", String(cfg.rotateSec));
  params.set("cards", cfg.cardsPerPage === 0 ? "auto" : String(cfg.cardsPerPage));
  params.set("range", cfg.range);
  params.set("sound", cfg.sound ? "1" : "0");
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

export function computeBestFitGrid(input: {
  width: number;
  height: number;
  orientation: TvOrientation;
  cardsOverride?: number;
  maxItems?: number;
}): TvGridLayout {
  const safeW = Math.max(320, Math.floor(input.width));
  const safeH = Math.max(300, Math.floor(input.height));
  const isPortrait = input.orientation === "portrait" || safeH > safeW * 1.15;
  const targetMinCardW = 360;
  const idealBalancedCardW = 440;
  const maxColsCap = isPortrait ? 2 : safeW >= 2400 ? 5 : 4;
  const itemLimit =
    input.maxItems && input.maxItems > 0 ? input.maxItems : undefined;

  if (input.cardsOverride && input.cardsOverride > 0) {
    const targetCount = itemLimit
      ? Math.min(input.cardsOverride, itemLimit)
      : input.cardsOverride;
    let chosen: TvGridLayout | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    const maxTryCols = Math.min(
      Math.max(1, targetCount),
      isPortrait ? 2 : 4
    );
    for (let cols = 1; cols <= maxTryCols; cols++) {
      const rows = Math.max(1, Math.ceil(targetCount / cols));
      const rawCardW = (safeW - GRID_GAP_PX * (cols - 1)) / cols;
      const cardWidth =
        cols === 1 ? Math.min(Math.floor(rawCardW), 1120) : Math.floor(rawCardW);
      const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
      const idealPanelH = Math.round(panelWidth / TARGET_GRAPH_RATIO);
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
    const cardWidth =
      cols === 1 ? Math.min(Math.floor(rawCardW), 1120) : Math.floor(rawCardW);
    const panelWidth = Math.max(200, cardWidth - CARD_CHROME_W);
    const idealPanelH = Math.round(panelWidth / TARGET_GRAPH_RATIO);
    const idealCardH = idealPanelH + CARD_CHROME_H;

    let rows = Math.max(
      1,
      Math.floor((safeH + GRID_GAP_PX) / (idealCardH + GRID_GAP_PX))
    );
    let panelHeight = idealPanelH;

    // On ultra-short screens (e.g. 1024x600), gently allow 2 rows of slightly wider strips
    // instead of wasting nearly half the screen on a single row.
    if (rows === 1 && safeH >= 470 && cols >= 2 && (!itemLimit || itemLimit > cols)) {
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
    Math.min(Math.round(panelWidth / TARGET_GRAPH_RATIO), safeH - CARD_CHROME_H)
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
  cfg: Pick<TvWallConfig, "groups" | "cardsPerPage">,
  effectiveCardsPerPage?: number
): {
  pinnedAlerts: TargetHealthSummary[];
  highlightItems: TargetHealthSummary[];
  pages: TargetHealthSummary[][];
  slides: TvPageSlide[];
  highlightSlideIdx: number | null;
  totalFiltered: number;
} {
  const groupSet = new Set(cfg.groups);
  const filtered = targets.filter((t) => {
    if (!t.enabled) return false;
    if (groupSet.size === 0) return true;
    return Boolean(t.group_id && groupSet.has(t.group_id));
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
  for (let i = 0; i < summaries.length; i += pageSize) {
    pages.push(summaries.slice(i, i + pageSize));
  }
  if (pages.length === 0) {
    pages.push([]);
  }

  const slides: TvPageSlide[] = [];
  pages.forEach((p, idx) => {
    slides.push({
      kind: "grid",
      label: `GRID ${idx + 1}/${pages.length}`,
      items: p,
    });
  });

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
    pinnedAlerts,
    highlightItems,
    pages,
    slides,
    highlightSlideIdx,
    totalFiltered: summaries.length,
  };
}
