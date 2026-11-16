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

vi.mock("uplot", () => {
  class FakeUPlot {
    scales = { x: { min: 0, max: 0 }, y: { min: 0, max: 100 } };
    destroy() {}
    setData(...args: unknown[]) {
      setDataSpy(...args);
    }
    setSize() {}
    setScale(key: string, val: { min: number; max: number }) {
      setScaleSpy(key, val);
    }
    redraw() {}
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

  it("updates uPlot X scale bounds immediately when rangeLabel changes", async () => {
    setScaleSpy.mockClear();
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

    const { rerender } = render(<SmokeChartPanel {...props} rangeLabel="3h" />);
    await vi.waitFor(() => {
      expect(setScaleSpy).toHaveBeenCalled();
    });
    const last3h = setScaleSpy.mock.calls.at(-1)?.[1] as { min: number; max: number };
    expect(last3h.max - last3h.min).toBe(10800);

    setScaleSpy.mockClear();
    rerender(<SmokeChartPanel {...props} rangeLabel="15m" />);
    await vi.waitFor(() => {
      expect(setScaleSpy).toHaveBeenCalled();
    });
    const last15m = setScaleSpy.mock.calls.at(-1)?.[1] as { min: number; max: number };
    expect(last15m.max - last15m.min).toBe(900);
  });
});
