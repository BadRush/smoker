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
});
