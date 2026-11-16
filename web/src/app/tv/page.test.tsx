import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NocTvWallboardPage from "./page";
import type { MatrixSnapshot } from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/tv",
}));

vi.mock("@/lib/useLiveSocket", () => ({
  useLiveSocket: () => "connected",
}));

vi.mock("@/lib/export-chart-png", () => ({
  exportSmokeChartPng: vi.fn().mockResolvedValue("copied"),
}));

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

const TV_SNAPSHOT: MatrixSnapshot = {
  generated_at: "2026-11-16T03:00:00Z",
  active_incidents: 0,
  probes: [
    {
      id: "p1",
      name: "Local Central",
      location_label: "Jakarta",
      isp_asn: "LOCAL",
      is_local: true,
      status: "online",
      pending_backlog_count: 0,
      clock_offset_ms: 0,
      last_seen_at: "2026-11-16T03:00:00Z",
      agent_version: "1.0.0",
      created_at: "2026-11-15T00:00:00Z",
    },
  ],
  groups: [],
  targets: [1, 2, 3, 4].map((i) => ({
    id: `t-${i}`,
    group_id: null,
    name: `Host ${i}`,
    host: `10.0.0.${i}`,
    probe_type: "icmp",
    port_or_path: "",
    interval_sec: 1,
    timeout_ms: 1000,
    enabled: true,
    auto_mtr_on_loss: true,
    mtr_loss_threshold: 3,
    pinned_on_tv: false,
    latency_warn_ms: 0,
    probe_latency_overrides: {},
    assign_all_probes: true,
    probe_ids: [],
    created_at: "2026-11-15T00:00:00Z",
    updated_at: "2026-11-15T00:00:00Z",
  })),
  cells: [1, 2, 3, 4].map((i) => ({
    target_id: `t-${i}`,
    probe_id: "p1",
    p50_ms: 10 + i,
    p95_ms: 18 + i,
    jitter_ms: 1.5,
    loss_pct: 0,
    sample_count: 10,
    status: "healthy",
    sparkline: [{ ts: 1700000000, min: 8, p50: 10 + i, p95: 18 + i, loss: 0 }],
  })),
};

describe("NocTvWallboardPage layout controls", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/tv");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(JSON.stringify(TV_SNAPSHOT), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "3h", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("supports 1-Col Full, 1-Row horizontal, Portrait orientation, Scroll/Slides flow, and custom width/height", async () => {
    const user = userEvent.setup();
    render(<NocTvWallboardPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("tv-target-card").length).toBeGreaterThan(0);
    });

    // Open quick Layout bar
    await user.click(screen.getByTestId("tv-layout-toggle-btn"));
    expect(await screen.findByTestId("tv-layout-bar")).toBeInTheDocument();

    // Switch to 1 Col Full -> 1 column & vertical scroll with all 4 targets
    await user.click(screen.getByTestId("tv-layout-preset-single-col"));
    const grid = screen.getByTestId("tv-cards-grid");
    expect(grid).toHaveAttribute("data-cols", "1");
    expect(grid).toHaveAttribute("data-flow", "scroll");
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(4);

    // Custom width 960px + chart height 280px
    await user.click(screen.getByTestId("tv-layout-width-960px"));
    await user.click(screen.getByTestId("tv-layout-height-280"));
    expect(window.location.search).toContain("layout=single-col");
    expect(window.location.search).toContain("width=960px");
    expect(window.location.search).toContain("chartH=280");
    expect(window.localStorage.getItem("smoker.tv.config.v1")).toContain('"chartHeight":280');

    // Switch to 1 Row horizontal -> rows=1 & slides flow
    await user.click(screen.getByTestId("tv-layout-preset-single-row"));
    expect(screen.getByTestId("tv-cards-grid")).toHaveAttribute("data-rows", "1");
    expect(screen.getByTestId("tv-cards-grid")).toHaveAttribute("data-flow", "slides");

    // Set 1-Row Card Width 640px -> triggers horizontal card sizing
    await user.click(screen.getByTestId("tv-layout-rowwidth-640px"));
    expect(screen.getAllByTestId("tv-target-card")[0]).toHaveStyle({ width: "640px" });

    // Switch to Portrait + Auto preset -> updates orientation and flow cleanly
    await user.click(screen.getByTestId("tv-layout-preset-auto"));
    await user.click(screen.getByTestId("tv-layout-ori-portrait"));
    expect(screen.getByTestId("noc-tv-root")).toHaveAttribute("data-orientation", "portrait");
    expect(screen.getByTestId("noc-tv-root")).toHaveAttribute("data-flow", "scroll");

    // Explicit Slides toggle overrides portrait auto-scroll
    await user.click(screen.getByTestId("tv-layout-flow-slides"));
    expect(screen.getByTestId("noc-tv-root")).toHaveAttribute("data-flow", "slides");

    // Reset layout returns to auto/full/0
    await user.click(screen.getByTestId("tv-layout-reset-btn"));
    expect(window.location.search).not.toContain("chartH=");
    expect(window.location.search).not.toContain("width=");
  });
});
