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

  it("renders separate Per-Probe cards side-by-side by default for multi-probe targets like e1-vhp.com and supports Per-Target & Group by Probe toggles", async () => {
    const multiProbeSnapshot: MatrixSnapshot = {
      generated_at: "2026-11-16T03:00:00Z",
      active_incidents: 0,
      probes: [
        ...TV_SNAPSHOT.probes,
        {
          id: "p2",
          name: "Remote-SGP",
          location_label: "Singapore",
          isp_asn: "AS13335",
          is_local: false,
          status: "online",
          pending_backlog_count: 0,
          clock_offset_ms: 0,
          last_seen_at: "2026-11-16T03:00:00Z",
          agent_version: "1.0.0",
          created_at: "2026-11-15T00:00:00Z",
        },
      ],
      groups: [],
      targets: [
        {
          ...TV_SNAPSHOT.targets[0],
          id: "t-e1",
          name: "e1-vhp.com",
          host: "https://e1-vhp.com",
          probe_type: "http",
        },
      ],
      cells: [
        {
          target_id: "t-e1",
          probe_id: "p1",
          p50_ms: 14,
          p95_ms: 22,
          jitter_ms: 1.2,
          loss_pct: 0,
          sample_count: 10,
          status: "healthy",
          sparkline: [{ ts: 1700000000, min: 10, p50: 14, p95: 22, loss: 0 }],
        },
        {
          target_id: "t-e1",
          probe_id: "p2",
          p50_ms: 35,
          p95_ms: 48,
          jitter_ms: 2.4,
          loss_pct: 0,
          sample_count: 10,
          status: "healthy",
          sparkline: [{ ts: 1700000000, min: 30, p50: 35, p95: 48, loss: 0 }],
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(JSON.stringify(multiProbeSnapshot), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "3h", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<NocTvWallboardPage />);

    // Default Per-Probe mode generates 2 cards for e1-vhp.com (Local Central & Remote-SGP)
    await waitFor(() => {
      expect(screen.getAllByTestId("tv-target-card")).toHaveLength(2);
    });
    const badges = screen.getAllByTestId("tv-card-probe-badge");
    expect(badges.map((b) => b.textContent)).toEqual(["Local Central", "Remote-SGP"]);

    // Toggle to Per-Target compact mode -> collapses to 1 focal card with probe switcher chips
    await user.click(screen.getByTestId("tv-probe-mode-btn"));
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(1);
    expect(screen.getAllByTestId("tv-probe-chip")).toHaveLength(2);
    expect(window.location.search).toContain("probeMode=per-target");

    // Toggle back to Per-Probe -> 2 cards again
    await user.click(screen.getByTestId("tv-probe-mode-btn"));
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(2);
  });

  it("keeps Auto Spotlight off by default with manual Anomalies badge, and only spotlights loss/down targets (ignoring yellow degraded)", async () => {
    const snapWithLoss: MatrixSnapshot = {
      ...TV_SNAPSHOT,
      targets: [
        { ...TV_SNAPSHOT.targets[0], pinned_on_tv: true },
        TV_SNAPSHOT.targets[1],
        { ...TV_SNAPSHOT.targets[2], pinned_on_tv: true },
      ],
      cells: [
        {
          ...TV_SNAPSHOT.cells[0],
          status: "loss",
          loss_pct: 20,
          p50_ms: 25,
          p95_ms: 40,
        },
        {
          ...TV_SNAPSHOT.cells[1],
          status: "down",
          loss_pct: 100,
          p50_ms: null,
          p95_ms: null,
        },
        {
          ...TV_SNAPSHOT.cells[2],
          status: "degraded",
          loss_pct: 0,
          p50_ms: 180,
          p95_ms: 220,
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(JSON.stringify(snapWithLoss), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "3h", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<NocTvWallboardPage />);

    // Default Spotlight=off: no tv-spotlight-btn, shows Alert / Warn (3) button (down + loss + degraded)
    await waitFor(() => {
      expect(screen.getByTestId("tv-anomalies-btn")).toHaveTextContent(
        /Alert \/ Warn\s*\(3\)/
      );
    });
    expect(screen.queryByTestId("tv-spotlight-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tv-highlight-page")).not.toBeInTheDocument();

    // Clicking Anomalies (3) filters the grid to all 3 impaired targets (including degraded yellow)
    await user.click(screen.getByTestId("tv-anomalies-btn"));
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(3);
    await user.click(screen.getByTestId("tv-anomalies-btn"));
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(3);

    // Open TV Config Drawer -> enable VIP Only spotlight & Auto-Switch
    await user.click(screen.getByRole("button", { name: "Configure TV Display" }));
    expect(screen.getByTestId("tv-drawer-auto-switch")).toBeDisabled();
    await user.click(screen.getByTestId("tv-drawer-spotlight-vip"));
    expect(screen.getByTestId("tv-drawer-auto-switch")).toBeEnabled();
    await user.click(screen.getByTestId("tv-drawer-auto-switch"));
    expect(window.location.search).toContain("spotlight=vip");
    expect(window.location.search).toContain("autoSwitch=1");

    // Spotlight button shows (1): only VIP target[0] (loss), ignoring non-VIP target[1] (down) and VIP target[2] (degraded yellow)
    expect(screen.getByTestId("tv-spotlight-btn")).toHaveTextContent("(1)");

    // Switching to All Anomalies includes both loss/down targets (2), still ignoring degraded yellow target[2]
    await user.click(screen.getByTestId("tv-drawer-spotlight-all"));
    expect(screen.getByTestId("tv-spotlight-btn")).toHaveTextContent("(2)");
  });
});
