import { beforeEach, describe, expect, it } from "vitest";
import {
  clampChartHeight,
  clampColumnCount,
  DASHBOARD_LAYOUT_STORAGE_KEY,
  DEFAULT_DASHBOARD_LAYOUT,
  loadDashboardLayout,
  parseWidthSpec,
  resolveDashboardGrid,
  resolveEffectivePixelWidth,
  sanitizeDashboardLayoutConfig,
  saveDashboardLayout,
} from "./display-layout";

describe("display-layout helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("parses and clamps percentage, pixel, auto, and full width specs cleanly", () => {
    expect(parseWidthSpec("auto")).toEqual({
      kind: "auto",
      value: 0,
      normalized: "auto",
      cssValue: "1600px",
    });
    expect(parseWidthSpec("full")).toEqual({
      kind: "full",
      value: 100,
      normalized: "full",
      cssValue: "100%",
    });
    expect(parseWidthSpec("100%")).toEqual({
      kind: "full",
      value: 100,
      normalized: "full",
      cssValue: "100%",
    });
    expect(parseWidthSpec("80%")).toEqual({
      kind: "percent",
      value: 80,
      normalized: "80%",
      cssValue: "80%",
    });
    expect(parseWidthSpec("10%")).toEqual({
      kind: "percent",
      value: 25,
      normalized: "25%",
      cssValue: "25%",
    });
    expect(parseWidthSpec("960")).toEqual({
      kind: "px",
      value: 960,
      normalized: "960px",
      cssValue: "960px",
    });
    expect(parseWidthSpec("200px")).toEqual({
      kind: "px",
      value: 300,
      normalized: "300px",
      cssValue: "300px",
    });
    expect(parseWidthSpec("abc")).toBeNull();
    expect(parseWidthSpec("", { allowAuto: false })).toBeNull();
  });

  it("resolves effective container pixels from width spec and clamps heights/columns", () => {
    expect(resolveEffectivePixelWidth("full", 1366)).toBe(1366);
    expect(resolveEffectivePixelWidth("80%", 1000)).toBe(800);
    expect(resolveEffectivePixelWidth("960px", 1920)).toBe(960);
    expect(resolveEffectivePixelWidth("1400px", 1024)).toBe(1024);

    expect(clampChartHeight(0)).toBe(0);
    expect(clampChartHeight(80)).toBe(120);
    expect(clampChartHeight(280)).toBe(280);
    expect(clampChartHeight(999)).toBe(520);

    expect(clampColumnCount(0, 2)).toBe(2);
    expect(clampColumnCount(9, 2)).toBe(6);
    expect(clampColumnCount(3, 2)).toBe(3);
  });

  it("persists and sanitizes dashboard layout configs via localStorage", () => {
    expect(loadDashboardLayout()).toEqual(DEFAULT_DASHBOARD_LAYOUT);

    saveDashboardLayout({
      preset: "single-row",
      customCols: 3,
      widthSpec: "full",
      rowCardWidth: "560px",
      chartHeight: 260,
      probeLayout: "single",
    });

    expect(loadDashboardLayout()).toEqual({
      preset: "single-row",
      customCols: 3,
      widthSpec: "full",
      rowCardWidth: "560px",
      chartHeight: 260,
      probeLayout: "single",
    });

    window.localStorage.setItem(DASHBOARD_LAYOUT_STORAGE_KEY, "{broken");
    expect(loadDashboardLayout()).toEqual(DEFAULT_DASHBOARD_LAYOUT);

    expect(
      sanitizeDashboardLayoutConfig({
        preset: "invalid",
        customCols: 99,
        widthSpec: "bogus",
        rowCardWidth: "50%",
        chartHeight: 50,
        probeLayout: "single",
      })
    ).toEqual({
      preset: "auto",
      customCols: 6,
      widthSpec: "auto",
      rowCardWidth: "50%",
      chartHeight: 120,
      probeLayout: "single",
    });
  });

  it("resolves responsive dashboard grid classes and styles for all layout modes", () => {
    const autoNarrow = resolveDashboardGrid({
      ...DEFAULT_DASHBOARD_LAYOUT,
      widthSpec: "720px",
    });
    expect(autoNarrow.containerMaxWidth).toBe("720px");
    expect(autoNarrow.gridClassName).toBe("grid grid-cols-1 gap-4");

    const singleColFull = resolveDashboardGrid({
      ...DEFAULT_DASHBOARD_LAYOUT,
      preset: "single-col",
      widthSpec: "full",
      probeLayout: "single",
    });
    expect(singleColFull.containerMaxWidth).toBe("100%");
    expect(singleColFull.gridClassName).toBe("grid grid-cols-1 gap-4");
    expect(singleColFull.probeGridClassName).toBe("grid grid-cols-1 gap-2.5");

    const singleRow = resolveDashboardGrid({
      ...DEFAULT_DASHBOARD_LAYOUT,
      preset: "single-row",
      rowCardWidth: "600px",
    });
    expect(singleRow.isRowStrip).toBe(true);
    expect(singleRow.rowCardStyle?.width).toBe("600px");

    const customCols = resolveDashboardGrid({
      ...DEFAULT_DASHBOARD_LAYOUT,
      preset: "cols",
      customCols: 3,
    });
    expect(customCols.gridStyle?.gridTemplateColumns).toBe(
      "repeat(3, minmax(0, 1fr))"
    );
  });
});
