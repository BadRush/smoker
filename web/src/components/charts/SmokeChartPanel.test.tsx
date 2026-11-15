import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

vi.mock("uplot", () => {
  class FakeUPlot {
    destroy() {}
    setData() {}
    setSize() {}
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
});
