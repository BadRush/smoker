import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MatrixWallPage from "./page";
import type { MatrixSnapshot } from "@/lib/api";

const mockRouter = { replace: vi.fn(), push: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/",
}));

vi.mock("@/lib/useLiveSocket", () => ({
  useLiveSocket: () => "connected",
}));

vi.mock("@/lib/export-chart-png", () => ({
  exportSmokeChartPng: vi.fn().mockResolvedValue("copied"),
  saveEvidenceBrandName: vi.fn(),
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

const SNAPSHOT: MatrixSnapshot = {
  generated_at: "2026-11-16T03:00:00Z",
  active_incidents: 0,
  probes: [
    {
      id: "p1",
      name: "Local Central Probe",
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
  groups: [
    {
      id: "g-custom",
      name: "Custom Core",
      description: "Custom targets",
      sort_order: 1,
      created_at: "2026-11-15T00:00:00Z",
    },
  ],
  targets: [
    {
      id: "t-icmp",
      group_id: "g-custom",
      name: "Custom Ping Host",
      host: "1.1.1.1",
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
    },
    {
      id: "t-dns",
      group_id: null,
      name: "dns cloudflare",
      host: "1.1.1.1",
      probe_type: "dns",
      port_or_path: "cloudflare.com|A",
      interval_sec: 2,
      timeout_ms: 1500,
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
    },
  ],
  cells: [
    {
      target_id: "t-icmp",
      probe_id: "p1",
      p50_ms: 6.2,
      p95_ms: 11.4,
      jitter_ms: 1.1,
      loss_pct: 0,
      sample_count: 10,
      status: "healthy",
      sparkline: [{ ts: 1700000000, min: 5, p50: 6.2, p95: 11.4, loss: 0 }],
    },
    {
      target_id: "t-dns",
      probe_id: "p1",
      p50_ms: 12.4,
      p95_ms: 21.0,
      jitter_ms: 2.0,
      loss_pct: 0,
      sample_count: 10,
      status: "healthy",
      sparkline: [{ ts: 1700000000, min: 10, p50: 12.4, p95: 21.0, loss: 0 }],
    },
  ],
};

describe("MatrixWallPage (Dashboard)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/matrix")) {
          return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
        }
        if (url.includes("/series")) {
          return new Response(
            JSON.stringify({
              target: SNAPSHOT.targets[1],
              range: "3h",
              series: [],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/mtr")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ username: "admin" }), { status: 200 });
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("groups targets separately by protocol, filters protocol chips, and opens Zoom Modal from Charts Grid on custom/ungrouped targets", async () => {
    const user = userEvent.setup();
    render(<MatrixWallPage />);

    await waitFor(() => {
      expect(screen.getByText("Custom Ping Host")).toBeInTheDocument();
      expect(screen.getByText("dns cloudflare")).toBeInTheDocument();
    });

    // Separate protocol headers are displayed by default
    expect(screen.getByText("ICMP (Ping)")).toBeInTheDocument();
    expect(screen.getByText("DNS Query")).toBeInTheDocument();

    // Ctrl+F focuses the search input on Dashboard
    await user.keyboard("{Control>}f{/Control}");
    expect(screen.getByLabelText("Search targets")).toHaveFocus();

    // Filter to DNS Query only
    await user.click(screen.getByTestId("dash-proto-dns"));
    expect(screen.queryByText("Custom Ping Host")).not.toBeInTheDocument();
    expect(screen.getByText("dns cloudflare")).toBeInTheDocument();

    // Switch to Charts Grid and click Zoom on custom/ungrouped chart
    await user.click(screen.getByRole("button", { name: /charts grid/i }));
    const zoomButtons = await screen.findAllByTestId("zoom-chart-btn");
    await user.click(zoomButtons[0]);

    const modal = await screen.findByTestId("tv-zoom-modal");
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveTextContent("dns cloudflare");
  });

  it("switches Charts Grid between 1-Col Full, 1-Row horizontal, custom width/height, 1 Probe/Row, and persists to localStorage", async () => {
    const user = userEvent.setup();
    render(<MatrixWallPage />);

    await waitFor(() => {
      expect(screen.getByText("Custom Ping Host")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /charts grid/i }));
    expect(await screen.findByTestId("dash-layout-bar")).toBeInTheDocument();

    // Switch to 1 Col Full
    await user.click(screen.getByTestId("dash-layout-preset-single-col"));
    const grids = screen.getAllByTestId("dash-section-grid");
    expect(grids[0]).toHaveAttribute("data-layout-preset", "single-col");
    expect(grids[0].className).toContain("grid-cols-1");

    // Toggle 1 Probe / Row
    const probeBtn = screen.getByTestId("dash-probe-layout-btn");
    await user.click(probeBtn);
    expect(probeBtn).toHaveAttribute("aria-pressed", "true");

    // Open Width & Height customizer
    await user.click(screen.getByTestId("dash-layout-customize-btn"));
    expect(await screen.findByTestId("dash-layout-size-controls")).toBeInTheDocument();

    // Set Full 100% display width and verify <main> removes 1600px cap
    await user.click(screen.getByTestId("dash-layout-width-full"));
    const mainEl = screen.getByRole("main");
    expect(mainEl).toHaveStyle({ maxWidth: "100%" });

    // Apply custom px width via input
    const widthInput = screen.getByTestId("dash-layout-width-input");
    await user.clear(widthInput);
    await user.type(widthInput, "960");
    await user.click(screen.getByTestId("dash-layout-width-apply-btn"));
    expect(mainEl).toHaveStyle({ maxWidth: "960px" });

    // Select 280px chart height
    await user.click(screen.getByTestId("dash-layout-height-280"));
    const panels = screen.getAllByTestId("smoke-chart-panel");
    expect(panels[0]).toHaveStyle({ height: "280px" });

    // Switch to 1 Row horizontal strip with 640px card width
    await user.click(screen.getByTestId("dash-layout-preset-single-row"));
    expect(screen.getAllByTestId("dash-section-grid")[0]).toHaveAttribute(
      "data-layout-preset",
      "single-row"
    );
    await user.click(screen.getByTestId("dash-layout-rowwidth-640px"));
    const cards = screen.getAllByTestId("grid-target-card");
    expect(cards[0]).toHaveStyle({ width: "640px" });

    // Persisted in localStorage
    const saved = window.localStorage.getItem("smoker.dashboard.layout.v1");
    expect(saved).toContain('"preset":"single-row"');
    expect(saved).toContain('"widthSpec":"960px"');
    expect(saved).toContain('"rowCardWidth":"640px"');
    expect(saved).toContain('"chartHeight":280');
    expect(saved).toContain('"probeLayout":"single"');

    // Reset restores defaults
    await user.click(screen.getByTestId("dash-layout-reset-btn"));
    expect(screen.getAllByTestId("dash-section-grid")[0]).toHaveAttribute(
      "data-layout-preset",
      "auto"
    );
  });

  it("supports grouping Charts Grid By Probe and filtering by specific probe", async () => {
    const multiProbeSnap: MatrixSnapshot = {
      ...SNAPSHOT,
      probes: [
        SNAPSHOT.probes[0],
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
      targets: [
        {
          ...SNAPSHOT.targets[0],
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
          p50_ms: 11,
          p95_ms: 18,
          jitter_ms: 1.0,
          loss_pct: 0,
          sample_count: 10,
          status: "healthy",
          sparkline: [{ ts: 1700000000, min: 9, p50: 11, p95: 18, loss: 0 }],
        },
        {
          target_id: "t-e1",
          probe_id: "p2",
          p50_ms: 32,
          p95_ms: 45,
          jitter_ms: 2.1,
          loss_pct: 0,
          sample_count: 10,
          status: "healthy",
          sparkline: [{ ts: 1700000000, min: 28, p50: 32, p95: 45, loss: 0 }],
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/matrix")) {
          return new Response(JSON.stringify(multiProbeSnap), { status: 200 });
        }
        return new Response(JSON.stringify({ username: "admin" }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<MatrixWallPage />);

    await waitFor(() => {
      expect(screen.getByText("e1-vhp.com")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /charts grid/i }));
    // Switch grouping to By Probe -> creates 2 probe sections (Local Central Probe & Remote-SGP), each with 1 chart panel
    await user.click(screen.getByTestId("dash-groupby-probe"));
    expect(screen.getAllByTestId("dash-section-grid")).toHaveLength(2);
    expect(screen.getAllByTestId("grid-target-card")).toHaveLength(2);
    expect(screen.getAllByTestId("smoke-chart-panel")).toHaveLength(2);

    // Filter to Remote-SGP only -> 1 section & 1 card
    await user.selectOptions(screen.getByTestId("dash-probe-filter"), "p2");
    expect(screen.getAllByTestId("dash-section-grid")).toHaveLength(1);
    expect(screen.getAllByTestId("grid-target-card")).toHaveLength(1);
  });

  it("auto-opens TargetZoomModal when visited via /?zoom=<target_id> deep link and cleans query on close", async () => {
    window.history.replaceState(null, "", "/?zoom=t-icmp");
    const user = userEvent.setup();
    render(<MatrixWallPage />);

    const zoomModal = await screen.findByTestId("tv-zoom-modal");
    expect(zoomModal).toBeInTheDocument();
    expect(zoomModal).toHaveTextContent("Custom Ping Host");

    await user.click(screen.getByTestId("tv-zoom-close-btn"));
    expect(screen.queryByTestId("tv-zoom-modal")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
