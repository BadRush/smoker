import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SmokeChartPanel } from "./SmokeChartPanel";

afterEach(() => {
  cleanup();
});

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const setScaleSpy = vi.fn();
const setDataSpy = vi.fn();
const capturedOpts: Array<{
  cursor?: {
    drag?: { x?: boolean; y?: boolean; dist?: number };
    sync?: {
      key?: string;
      scales?: [string | null, string | null];
      filters?: { pub?: (t: string) => boolean; sub?: (t: string) => boolean };
    };
    bind?: { dblclick?: () => unknown };
  };
  scales?: Record<string, { auto?: boolean; range?: (...args: unknown[]) => [number, number] }>;
  axes?: Array<{
    side?: number;
    scale?: string;
    splits?: () => number[];
    values?: (u: unknown, vals: number[]) => string[];
  }>;
  hooks?: {
    setScale?: Array<(u: unknown, key: string) => void>;
  };
}> = [];
const mockPlotInstances: Array<{
  scales: { x: { min: number; max: number }; y: { min: number; max: number } };
  series: Array<{ idxs?: [number, number] }>;
  data: [number[], Array<number | null>];
  opts: (typeof capturedOpts)[number];
  simulateUserDragZoom: (min: number, max: number) => void;
}> = [];

vi.mock("uplot", () => {
  class FakeUPlot {
    scales = { x: { min: 0, max: 0 }, y: { min: 0, max: 100 } };
    series: Array<{ idxs?: [number, number] }> = [{ idxs: [0, 0] }, {}];
    data: [number[], Array<number | null>] = [[], []];
    opts: (typeof capturedOpts)[number];
    private pendScales: Record<string, { min: number; max: number } | null> = {};
    private queuedCommit = false;
    constructor(
      opts: (typeof capturedOpts)[number],
      initData?: [number[], Array<number | null>]
    ) {
      this.opts = opts;
      if (initData) {
        this.data = initData;
        const n = initData[0]?.length ?? 0;
        if (n > 0) {
          this.series[0].idxs = [0, n - 1];
          // Mirror real uPlot _init() autoScaleX queuing async commit
          this.pendScales.x = { min: initData[0][0], max: initData[0][n - 1] };
          this.scheduleCommit();
        }
      }
      capturedOpts.push(opts);
      mockPlotInstances.push(this);
    }
    private scheduleCommit() {
      if (!this.queuedCommit) {
        this.queuedCommit = true;
        Promise.resolve().then(() => this._commit());
      }
    }
    private _commit() {
      this.queuedCommit = false;
      const px = this.pendScales.x;
      this.pendScales.x = null;
      if (!px) return;

      const rangedX = this.opts.scales?.x?.range?.(this, px.min, px.max) ?? [
        px.min,
        px.max,
      ];
      const ts = this.data[0] ?? [];
      if (ts.length > 0) {
        let i0 = 0;
        let i1 = ts.length - 1;
        for (let i = 0; i < ts.length; i++) {
          if (ts[i] >= rangedX[0]) {
            i0 = i;
            break;
          }
        }
        for (let i = ts.length - 1; i >= 0; i--) {
          if (ts[i] <= rangedX[1]) {
            i1 = i;
            break;
          }
        }
        if (i1 < i0) {
          i0 = 0;
          i1 = ts.length - 1;
        }
        this.series[0].idxs = [i0, i1];
      }

      // Mirror real uPlot: scales.y.range runs BEFORE this.scales.x is overwritten
      const yRange = this.opts.scales?.y?.range?.(this, 0, 100);
      if (yRange) {
        this.scales.y = { min: yRange[0], max: yRange[1] };
      }

      const changedX =
        this.scales.x.min !== rangedX[0] || this.scales.x.max !== rangedX[1];
      this.scales.x = { min: rangedX[0], max: rangedX[1] };
      if (changedX) {
        this.opts.hooks?.setScale?.forEach((fn) => fn(this, "x"));
      }
    }
    batch(fn: (u: FakeUPlot) => void) {
      this.queuedCommit = true;
      fn(this);
      this._commit();
    }
    destroy() {}
    setData(data: [number[], Array<number | null>], resetScales?: boolean) {
      setDataSpy(data, resetScales);
      this.data = data;
      if (resetScales !== false) {
        // Mirror real uPlot: when scales.x.auto === false, setData(..., true) re-queues stale scaleX
        this.setScale("x", { min: this.scales.x.min, max: this.scales.x.max });
      }
    }
    setSize() {}
    setScale(key: string, val: { min: number; max: number }) {
      setScaleSpy(key, val);
      this.pendScales[key] = { ...val };
      this.scheduleCommit();
    }
    redraw(rebuildPaths?: boolean) {
      // Mirror real uPlot line 4924: redraw() with rebuildPaths !== false re-queues stale scaleX!
      if (rebuildPaths !== false) {
        this.setScale("x", { min: this.scales.x.min, max: this.scales.x.max });
      }
    }
    simulateUserDragZoom(min: number, max: number) {
      this.batch(() => {
        this.setScale("x", { min, max });
      });
    }
  }
  (FakeUPlot as unknown as { sync: (k: string) => { key: string } }).sync = (
    key: string
  ) => ({ key });
  return { default: FakeUPlot };
});

const exportMock = vi.fn().mockResolvedValue("copied");
vi.mock("@/lib/export-chart-png", () => ({
  exportSmokeChartPng: (...args: unknown[]) => exportMock(...args),
}));

describe("SmokeChartPanel", () => {
  it("renders friendly latency labels and triggers PNG export", async () => {
    const user = userEvent.setup();
    render(
      <SmokeChartPanel
        syncKey="test-sync"
        targetName="Cloudflare DNS"
        targetHost="1.1.1.1"
        rangeLabel="3h"
        series={{
          probe_id: "p1",
          probe_name: "probe-local",
          location_label: "Jakarta",
          timestamps: [1700000000, 1700000030],
          min_ms: [4.1, 4.2],
          p25_ms: [4.5, 4.6],
          p50_ms: [5.0, 5.2],
          p75_ms: [6.0, 6.2],
          p95_ms: [8.1, 8.9],
          max_ms: [9.0, 10.2],
          jitter_ms: [0.4, 0.5],
          loss_pct: [0, 0],
        }}
      />
    );

    expect(screen.getByText("BEST")).toBeInTheDocument();
    expect(screen.getByText("NORMAL")).toBeInTheDocument();
    expect(screen.getByText("HIGH")).toBeInTheDocument();
    expect(screen.getByText("JITTER")).toBeInTheDocument();
    expect(screen.getByText("LOSS")).toBeInTheDocument();
    expect(screen.queryByText("P95")).not.toBeInTheDocument();

    const copyBtn = screen.getByTestId("copy-chart-png-btn");
    await user.click(copyBtn);

    expect(exportMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/copied png/i)).toBeInTheDocument();
  });

  it("highlights NORMAL readout in amber when latest latency touches warnMs and forwards warnMs to PNG export", async () => {
    exportMock.mockClear();
    const user = userEvent.setup();
    render(
      <SmokeChartPanel
        syncKey="test-warn"
        targetName="Google DNS"
        targetHost="8.8.8.8"
        rangeLabel="1h"
        warnMs={20}
        baselineMs={9}
        series={{
          probe_id: "p1",
          probe_name: "probe-local",
          location_label: "Jakarta",
          timestamps: [1700000000, 1700000030],
          min_ms: [8, 18],
          p25_ms: [9, 20],
          p50_ms: [10, 24],
          p75_ms: [11, 26],
          p95_ms: [12, 30],
          max_ms: [13, 32],
          jitter_ms: [1, 3],
          loss_pct: [0, 0],
        }}
      />
    );

    expect(screen.getByText("WARN")).toBeInTheDocument();
    const normalVal = screen.getByText("24.0 ms");
    expect(normalVal.className).toContain("text-amber-400");

    await user.click(screen.getByTestId("copy-chart-png-btn"));
    expect(exportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        warnMs: 20,
      })
    );
  });

  it("triggers onZoomClick from both header zoom button and empty telemetry placeholder", async () => {
    const user = userEvent.setup();
    const onZoom = vi.fn();

    render(
      <SmokeChartPanel
        compact
        fillHeight
        syncKey="empty-zoom-sync"
        targetName="Custom Target"
        targetHost="192.0.2.10"
        onZoomClick={onZoom}
        series={{
          probe_id: "p1",
          probe_name: "probe-local",
          location_label: "Jakarta",
          timestamps: [],
          min_ms: [],
          p25_ms: [],
          p50_ms: [],
          p75_ms: [],
          p95_ms: [],
          max_ms: [],
          jitter_ms: [],
          loss_pct: [],
        }}
      />
    );

    const headerZoomBtn = screen.getByTestId("zoom-chart-btn");
    const emptyZoomArea = screen.getByTestId("smoke-chart-empty-zoom");
    expect(headerZoomBtn).toBeInTheDocument();
    expect(emptyZoomArea).toBeInTheDocument();

    await user.click(headerZoomBtn);
    await user.click(emptyZoomArea);
    expect(onZoom).toHaveBeenCalledTimes(2);
  });

  it("opens zoom on short click but ignores horizontal drag zoom gestures on chart canvas", () => {
    const onZoom = vi.fn();
    const { container } = render(
      <SmokeChartPanel
        compact
        syncKey="pointer-zoom-sync"
        onZoomClick={onZoom}
        series={{
          probe_id: "p1",
          probe_name: "probe-local",
          location_label: "Jakarta",
          timestamps: [1700000000, 1700000030],
          min_ms: [4, 5],
          p25_ms: [5, 6],
          p50_ms: [6, 7],
          p75_ms: [7, 8],
          p95_ms: [8, 9],
          max_ms: [9, 10],
          jitter_ms: [0.5, 0.5],
          loss_pct: [0, 0],
        }}
      />
    );

    const chartDiv = container.querySelector(".cursor-zoom-in") as HTMLElement;
    expect(chartDiv).toBeTruthy();

    // Short click (< 8px movement) -> opens zoom modal
    fireEvent.mouseDown(chartDiv, { button: 0, clientX: 100, clientY: 50 });
    fireEvent.mouseUp(chartDiv, { button: 0, clientX: 103, clientY: 52 });
    fireEvent.click(chartDiv);
    expect(onZoom).toHaveBeenCalledTimes(1);

    // Wide horizontal drag (>= 8px) -> does not trigger zoom modal (reserved for uPlot time zoom)
    fireEvent.mouseDown(chartDiv, { button: 0, clientX: 100, clientY: 50 });
    fireEvent.mouseUp(chartDiv, { button: 0, clientX: 140, clientY: 50 });
    fireEvent.click(chartDiv);
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  it("commits new X scale immediately across sequential range switches without redraw clobber or false zoom lock", async () => {
    setScaleSpy.mockClear();
    mockPlotInstances.length = 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const props = {
      compact: true,
      syncKey: "range-sync",
      targetName: "IFORTE CYBER-NAKULA",
      series: {
        probe_id: "p1",
        probe_name: "Local Central Probe",
        location_label: "Jakarta",
        timestamps: [nowSec - 240, nowSec - 120, nowSec],
        min_ms: [19, 19, 20],
        p25_ms: [20, 20, 20],
        p50_ms: [20.4, 20.1, 20.4],
        p75_ms: [21, 21, 21],
        p95_ms: [22, 22, 22],
        max_ms: [23, 23, 23],
        jitter_ms: [0.5, 0.5, 0.5],
        loss_pct: [0, 0, 0],
      },
    };

    const { rerender } = render(<SmokeChartPanel {...props} rangeLabel="1h" />);
    await vi.waitFor(() => {
      expect(mockPlotInstances.length).toBeGreaterThanOrEqual(1);
    });
    const inst = mockPlotInstances.at(-1)!;
    // Allow any stray microtasks to flush — committed scale MUST remain 1h
    await Promise.resolve();
    expect(inst.scales.x.max - inst.scales.x.min).toBe(3600);

    // Switch 1h -> 3h -> 30d -> 15m; each switch must commit the new span without getting stuck at 1h
    rerender(<SmokeChartPanel {...props} rangeLabel="3h" />);
    await Promise.resolve();
    expect(inst.scales.x.max - inst.scales.x.min).toBe(10800);
    expect(screen.queryByTestId("reset-zoom-btn")).not.toBeInTheDocument();

    rerender(<SmokeChartPanel {...props} rangeLabel="30d" />);
    await Promise.resolve();
    expect(inst.scales.x.max - inst.scales.x.min).toBe(30 * 86400);
    expect(screen.queryByTestId("reset-zoom-btn")).not.toBeInTheDocument();

    rerender(<SmokeChartPanel {...props} rangeLabel="15m" />);
    await Promise.resolve();
    expect(inst.scales.x.max - inst.scales.x.min).toBe(900);
    expect(screen.queryByTestId("reset-zoom-btn")).not.toBeInTheDocument();
  });

  it("resets drag-zoom on rangeVersion bump (re-clicking active preset) and rescales Y using series[0].idxs on frame 1", async () => {
    mockPlotInstances.length = 0;
    const t0 = 1_794_800_000;
    const spikeSeries = {
      probe_id: "p1",
      probe_name: "probe-local",
      location_label: "Jakarta",
      timestamps: [t0, t0 + 60, t0 + 120, t0 + 180, t0 + 240],
      min_ms: [180, 10, 11, 10, 12],
      p25_ms: [190, 11, 12, 11, 13],
      p50_ms: [200, 12, 13, 12, 14],
      p75_ms: [210, 13, 14, 13, 15],
      p95_ms: [250, 15, 16, 15, 17],
      max_ms: [260, 16, 17, 16, 18],
      jitter_ms: [5, 0.5, 0.5, 0.5, 0.5],
      loss_pct: [0, 0, 0, 0, 0],
    };

    const { rerender } = render(
      <SmokeChartPanel
        syncKey="reclick-reset-sync"
        rangeLabel="3h"
        rangeVersion={0}
        series={spikeSeries}
      />
    );
    await vi.waitFor(() => {
      expect(mockPlotInstances.length).toBeGreaterThanOrEqual(1);
    });
    const inst = mockPlotInstances.at(-1)!;
    // Initial full window includes 250ms spike at index 0
    expect(inst.scales.y.max).toBeGreaterThan(200);

    // User drags horizontally to calm [t0+60, t0+180] slice -> Y rescales down immediately on frame 1!
    inst.simulateUserDragZoom(t0 + 60, t0 + 180);
    expect(inst.scales.x).toEqual({ min: t0 + 60, max: t0 + 180 });
    expect(inst.scales.y.max).toBeLessThan(40);
    expect(await screen.findByTestId("reset-zoom-btn")).toBeInTheDocument();

    // Re-clicking active 3h preset bumps rangeVersion (0 -> 1) -> resets zoom to full 3h & restores Y scale
    rerender(
      <SmokeChartPanel
        syncKey="reclick-reset-sync"
        rangeLabel="3h"
        rangeVersion={1}
        series={spikeSeries}
      />
    );
    await Promise.resolve();
    expect(screen.queryByTestId("reset-zoom-btn")).not.toBeInTheDocument();
    expect(inst.scales.x.max - inst.scales.x.min).toBe(10800);
    expect(inst.scales.y.max).toBeGreaterThan(200);
  });

  it("distinguishes loading, empty custom historical range, and live waiting empty states", () => {
    const emptySeries = {
      probe_id: "p1",
      probe_name: "probe-local",
      location_label: "Jakarta",
      timestamps: [],
      min_ms: [],
      p25_ms: [],
      p50_ms: [],
      p75_ms: [],
      p95_ms: [],
      max_ms: [],
      jitter_ms: [],
      loss_pct: [],
    };

    const { rerender } = render(
      <SmokeChartPanel
        syncKey="empty-states"
        loading
        fixedBounds={[1_794_800_000, 1_794_803_600]}
        series={emptySeries}
      />
    );
    expect(screen.getByTestId("smoke-chart-empty-state")).toHaveTextContent(
      "Loading telemetry for selected time range..."
    );

    rerender(
      <SmokeChartPanel
        syncKey="empty-states"
        loading={false}
        fixedBounds={[1_794_800_000, 1_794_803_600]}
        series={emptySeries}
      />
    );
    expect(screen.getByTestId("smoke-chart-empty-state")).toHaveTextContent(
      "No samples in selected time range."
    );

    rerender(
      <SmokeChartPanel
        syncKey="empty-states"
        loading={false}
        series={emptySeries}
      />
    );
    expect(screen.getByTestId("smoke-chart-empty-state")).toHaveTextContent(
      "Waiting for telemetry samples from this probe..."
    );
  });

  it("configures a right-hand 0%..100% loss Y-axis in both zoomed and compact modes and shows zoom window loss", async () => {
    const user = userEvent.setup();
    capturedOpts.length = 0;
    mockPlotInstances.length = 0;

    const baseSeries = {
      probe_id: "p1",
      probe_name: "probe-local",
      location_label: "Jakarta",
      timestamps: [1700000000, 1700000060, 1700000120, 1700000180],
      min_ms: [4, 5, null, 5],
      p25_ms: [5, 6, null, 6],
      p50_ms: [6, 8, null, 7],
      p75_ms: [7, 10, null, 8],
      p95_ms: [9, 12, null, 9],
      max_ms: [10, 14, null, 10],
      jitter_ms: [0.5, 1.0, null, 0.5],
      loss_pct: [0, 20, 100, 0],
    };

    const { rerender } = render(
      <SmokeChartPanel
        syncKey="loss-axis-full"
        targetName="Cloudflare DNS"
        targetHost="1.1.1.1"
        series={baseSeries}
      />
    );

    await vi.waitFor(() => {
      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
    });

    const fullOpts = capturedOpts.at(-1)!;
    expect(fullOpts.scales?.loss?.auto).toBe(false);
    expect(fullOpts.scales?.loss?.range?.()).toEqual([0, 100]);
    const fullLossAxis = fullOpts.axes?.[2];
    expect(fullLossAxis?.side).toBe(1);
    expect(fullLossAxis?.scale).toBe("loss");
    const fullSplits = fullLossAxis?.splits?.() ?? [];
    expect(fullSplits).toEqual([0, 25, 50, 75, 100]);
    expect(fullLossAxis?.values?.(null, fullSplits)).toEqual([
      "0%",
      "25%",
      "50%",
      "75%",
      "100%",
    ]);

    // Simulate horizontal drag-zoom across [1700000060, 1700000120] -> avg 60.0%, peak 100.0%
    const inst = mockPlotInstances.at(-1)!;
    inst.scales.x = { min: 1700000060, max: 1700000120 };
    inst.opts.hooks?.setScale?.[0]?.(inst, "x");

    const zoomLossBadge = await screen.findByTestId("zoom-window-loss");
    expect(zoomLossBadge).toHaveTextContent("Zoom Loss:");
    expect(zoomLossBadge).toHaveTextContent("avg 60.0%");
    expect(zoomLossBadge).toHaveTextContent("peak 100.0%");

    await user.click(screen.getByTestId("reset-zoom-btn"));
    expect(screen.queryByTestId("zoom-window-loss")).not.toBeInTheDocument();

    // Compact mode uses concise [0, 50, 100] splits on right axis
    capturedOpts.length = 0;
    rerender(
      <SmokeChartPanel
        compact
        syncKey="loss-axis-compact"
        targetName="Cloudflare DNS"
        targetHost="1.1.1.1"
        series={baseSeries}
      />
    );

    await vi.waitFor(() => {
      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
    });
    const compactLossAxis = capturedOpts.at(-1)!.axes?.[2];
    expect(compactLossAxis?.side).toBe(1);
    expect(compactLossAxis?.scale).toBe("loss");
    expect(compactLossAxis?.splits?.()).toEqual([0, 50, 100]);
  });

  it("honors horizontal drag-to-zoom X range, rescales Y to visible slice, preserves zoom across live ticks, and respects fixedBounds", async () => {
    const user = userEvent.setup();
    capturedOpts.length = 0;
    mockPlotInstances.length = 0;
    setScaleSpy.mockClear();
    setDataSpy.mockClear();

    const t0 = 1_794_800_000;
    const baseSeries = {
      probe_id: "p1",
      probe_name: "probe-local",
      location_label: "Jakarta",
      timestamps: [t0, t0 + 60, t0 + 120, t0 + 180, t0 + 240],
      min_ms: [180, 10, 11, 10, 12],
      p25_ms: [190, 11, 12, 11, 13],
      p50_ms: [200, 12, 13, 12, 14],
      p75_ms: [210, 13, 14, 13, 15],
      p95_ms: [250, 15, 16, 15, 17],
      max_ms: [260, 16, 17, 16, 18],
      jitter_ms: [5, 0.5, 0.5, 0.5, 0.5],
      loss_pct: [0, 0, 20, 0, 0],
    };

    const { rerender } = render(
      <SmokeChartPanel
        syncKey="drag-zoom-regression"
        targetName="Core Router"
        targetHost="10.0.0.1"
        rangeLabel="3h"
        series={baseSeries}
      />
    );

    await vi.waitFor(() => {
      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
    });

    const opts = capturedOpts.at(-1)!;
    const inst = mockPlotInstances.at(-1)!;

    // cursor.drag has dist=6 and non-compact syncs X scale across probes
    expect(opts.cursor?.drag).toEqual({ x: true, y: false, dist: 6 });
    expect(opts.cursor?.sync?.scales).toEqual(["x", null]);

    // Primary bug fix: scales.x.range MUST honor dragged [min, max] instead of overwriting with full 3h bounds
    const dragMin = t0 + 60;
    const dragMax = t0 + 180;
    expect(opts.scales?.x?.auto).toBe(false);
    expect(opts.scales?.x?.range?.(inst, dragMin, dragMax)).toEqual([dragMin, dragMax]);

    // When zoomed to [t0+60, t0+180] (calm ~16ms slice), Y-axis rescales down ignoring the 250ms spike at t0
    inst.simulateUserDragZoom(dragMin, dragMax);
    expect(inst.scales.y.max).toBeLessThan(40);
    expect(await screen.findByTestId("reset-zoom-btn")).toBeInTheDocument();

    // Live tick update while zoomed MUST preserve [dragMin, dragMax] and pass resetScales=false
    setScaleSpy.mockClear();
    setDataSpy.mockClear();
    rerender(
      <SmokeChartPanel
        syncKey="drag-zoom-regression"
        targetName="Core Router"
        targetHost="10.0.0.1"
        rangeLabel="3h"
        series={{
          ...baseSeries,
          timestamps: [...baseSeries.timestamps, t0 + 300],
          min_ms: [...baseSeries.min_ms, 11],
          p25_ms: [...baseSeries.p25_ms, 12],
          p50_ms: [...baseSeries.p50_ms, 13],
          p75_ms: [...baseSeries.p75_ms, 14],
          p95_ms: [...baseSeries.p95_ms, 16],
          max_ms: [...baseSeries.max_ms, 17],
          jitter_ms: [...baseSeries.jitter_ms, 0.5],
          loss_pct: [...baseSeries.loss_pct, 0],
        }}
      />
    );
    expect(setDataSpy).toHaveBeenCalledWith(expect.any(Array), false);
    expect(setScaleSpy).toHaveBeenCalledWith("x", { min: dragMin, max: dragMax });

    // Switching to fixedBounds (custom historical range) resets zoom and locks X bounds to [from, to]
    setScaleSpy.mockClear();
    const customFrom = t0 - 3600;
    const customTo = t0 + 3600;
    rerender(
      <SmokeChartPanel
        syncKey="drag-zoom-regression"
        targetName="Core Router"
        targetHost="10.0.0.1"
        rangeLabel="CUSTOM"
        fixedBounds={[customFrom, customTo]}
        series={baseSeries}
      />
    );
    expect(screen.queryByTestId("reset-zoom-btn")).not.toBeInTheDocument();
    expect(setScaleSpy).toHaveBeenCalledWith("x", { min: customFrom, max: customTo });

    // Zoom inside fixedBounds then click Reset Zoom -> restores exact fixedBounds
    inst.scales.x = { min: t0, max: t0 + 180 };
    inst.opts.hooks?.setScale?.[0]?.(inst, "x");
    const resetBtn = await screen.findByTestId("reset-zoom-btn");
    setScaleSpy.mockClear();
    await user.click(resetBtn);
    expect(setScaleSpy).toHaveBeenCalledWith("x", { min: customFrom, max: customTo });
  });
});
