import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    // Open Configure TV drawer (Option A: layout controls live inside drawer)
    expect(screen.queryByTestId("tv-layout-toggle-btn")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configure TV Display" }));

    // Switch to 1 Col Full -> 1 column & vertical scroll with all 4 targets
    await user.click(screen.getByTestId("tv-drawer-layout-preset-single-col"));
    const grid = screen.getByTestId("tv-cards-grid");
    expect(grid).toHaveAttribute("data-cols", "1");
    expect(grid).toHaveAttribute("data-flow", "scroll");
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(4);

    // Custom width 960px + chart height 280px
    await user.click(screen.getByTestId("tv-drawer-layout-width-960px"));
    await user.click(screen.getByTestId("tv-drawer-layout-height-280"));
    expect(window.location.search).toContain("layout=single-col");
    expect(window.location.search).toContain("width=960px");
    expect(window.location.search).toContain("chartH=280");
    expect(window.localStorage.getItem("smoker.tv.config.v1")).toContain('"chartHeight":280');

    // Switch to 1 Row horizontal -> rows=1 & slides flow
    await user.click(screen.getByTestId("tv-drawer-layout-preset-single-row"));
    expect(screen.getByTestId("tv-cards-grid")).toHaveAttribute("data-rows", "1");
    expect(screen.getByTestId("tv-cards-grid")).toHaveAttribute("data-flow", "slides");

    // Set 1-Row Card Width 640px -> triggers horizontal card sizing
    await user.click(screen.getByTestId("tv-drawer-layout-rowwidth-640px"));
    expect(screen.getAllByTestId("tv-target-card")[0]).toHaveStyle({ width: "640px" });

    // Switch to Portrait + Auto preset -> updates orientation and flow cleanly
    await user.click(screen.getByTestId("tv-drawer-layout-preset-auto"));
    await user.click(screen.getByTestId("tv-drawer-layout-ori-portrait"));
    expect(screen.getByTestId("noc-tv-root")).toHaveAttribute("data-orientation", "portrait");
    expect(screen.getByTestId("noc-tv-root")).toHaveAttribute("data-flow", "scroll");

    // Explicit Slides toggle overrides portrait auto-scroll
    await user.click(screen.getByTestId("tv-drawer-layout-flow-slides"));
    expect(screen.getByTestId("noc-tv-root")).toHaveAttribute("data-flow", "slides");

    // Reset layout returns to auto/full/0
    await user.click(screen.getByTestId("tv-drawer-layout-reset-btn"));
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

    // Probe name is not duplicated inside the card (appears once in bottom-left footer)
    expect(screen.getAllByText("Local Central")).toHaveLength(1);
    expect(screen.getAllByText("Remote-SGP")).toHaveLength(1);

    // Peak is removed and NORMAL / HIGH / LOSS appear in the footer
    expect(screen.queryByText(/Peak/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("NORMAL").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("HIGH").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("LOSS").length).toBeGreaterThanOrEqual(2);

    // Status badge (OK) has no dot circle element inside it
    const statusBadges = screen.getAllByTestId("tv-card-status-badge");
    expect(statusBadges[0]).toHaveTextContent("OK");
    expect(statusBadges[0].querySelector(".rounded-full")).toBeNull();

    // Top-right Screenshot button copies PNG
    const copyBtns = screen.getAllByTestId("copy-chart-png-btn");
    await user.click(copyBtns[0]);
    expect(await screen.findByText("Copied")).toBeInTheDocument();

    // Ctrl+F opens the TV search filter bar
    await user.keyboard("{Control>}f{/Control}");
    expect(await screen.findByPlaceholderText(/search target name/i)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Clicking Zoom on TV card opens Zoom Modal with top Run MTR button and bottom Run MTR Now button
    const zoomBtns = screen.getAllByTestId("zoom-chart-btn");
    await user.click(zoomBtns[0]);
    const zoomModal = await screen.findByTestId("tv-zoom-modal");
    expect(zoomModal).toBeInTheDocument();
    const runMtrBtn = screen.getByTestId("tv-zoom-run-mtr-btn");
    expect(runMtrBtn).toBeInTheDocument();
    await user.click(runMtrBtn);
    await user.click(screen.getByTestId("tv-zoom-close-btn"));

    // Toggle to Per-Target compact mode via Configure TV drawer -> collapses to 1 focal card with probe switcher chips
    expect(screen.queryByTestId("tv-probe-mode-btn")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configure TV Display" }));
    await user.click(screen.getByTestId("tv-drawer-probemode-per-target"));
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(1);
    expect(screen.getAllByTestId("tv-probe-chip")).toHaveLength(2);
    expect(window.location.search).toContain("probeMode=per-target");

    // Toggle back to Per-Probe -> 2 cards again
    await user.click(screen.getByTestId("tv-drawer-probemode-per-probe"));
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

    // Default Spotlight=off: no tv-spotlight-btn, shows Variant A1 quiet inline "3 ALERT" (down + loss + degraded)
    await waitFor(() => {
      expect(screen.getByTestId("tv-anomalies-btn")).toHaveTextContent(
        /3\s+ALERT/
      );
    });
    expect(screen.getByTestId("tv-anomalies-btn")).toHaveAttribute("data-severity", "alert");
    expect(screen.getByTestId("tv-anomalies-btn").className).toContain("bg-transparent");
    expect(screen.queryByTestId("tv-spotlight-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tv-highlight-page")).not.toBeInTheDocument();

    // Clicking quiet alert counter filters the grid and marks it active ("Filtered")
    await user.click(screen.getByTestId("tv-anomalies-btn"));
    expect(screen.getByTestId("tv-anomalies-btn")).toHaveTextContent(/Filtered/);
    expect(screen.getAllByTestId("tv-target-card")).toHaveLength(3);
    await user.click(screen.getByTestId("tv-anomalies-btn"));
    expect(screen.getByTestId("tv-anomalies-btn")).not.toHaveTextContent(/Filtered/);
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

  it("auto-opens TargetZoomModal when visited via /tv?zoom=<target_id> deep link", async () => {
    window.history.replaceState(null, "", "/tv?zoom=t-1");
    const user = userEvent.setup();
    render(<NocTvWallboardPage />);

    const zoomModal = await screen.findByTestId("tv-zoom-modal");
    expect(zoomModal).toBeInTheDocument();
    expect(zoomModal).toHaveTextContent("Host 1");

    await user.click(screen.getByTestId("tv-zoom-close-btn"));
    expect(screen.queryByTestId("tv-zoom-modal")).not.toBeInTheDocument();
    expect(window.location.search).not.toContain("zoom=");
  });

  it("auto-loads server Default Preset on fresh reboot, supports 1-click switching, and gates Admin Preset CRUD & Simulate by is_admin", async () => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/tv");
    const savedPresets = [
      {
        id: "pre-1",
        slug: "noc-main",
        name: "NOC Main Wall",
        config: { range: "6h", layoutMode: "single-col", orientation: "landscape" },
        is_default: true,
        created_at: "2026-11-19T00:00:00Z",
        updated_at: "2026-11-19T00:00:00Z",
      },
      {
        id: "pre-2",
        slug: "portrait-ops",
        name: "Portrait Ops",
        config: { range: "1h", layoutMode: "auto", orientation: "portrait" },
        is_default: false,
        created_at: "2026-11-19T00:00:00Z",
        updated_at: "2026-11-19T00:00:00Z",
      },
    ];
    let isAdmin = false;
    const reqLog: Array<{ method: string; url: string; body: unknown }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          reqLog.push({ method, url, body });
          if (method === "POST" && url === "/api/tv/presets") {
            return new Response(
              JSON.stringify({
                id: "pre-new",
                slug: "core-focus",
                name: body.name,
                config: body.config,
                is_default: Boolean(body.is_default),
                created_at: "2026-11-19T00:00:00Z",
                updated_at: "2026-11-19T00:00:00Z",
              }),
              { status: 201 }
            );
          }
        }
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(
            JSON.stringify({ ...TV_SNAPSHOT, is_admin: isAdmin }),
            { status: 200 }
          );
        }
        if (url.startsWith("/api/tv/presets")) {
          return new Response(JSON.stringify(savedPresets), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "6h", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const user = userEvent.setup();
    const { unmount } = render(<NocTvWallboardPage />);

    // 1. Non-admin reboot (empty localStorage): auto-loads Default preset ("noc-main": range 6h, single-col)
    await waitFor(() => {
      expect(screen.getByTestId("tv-header-preset-select")).toHaveValue("noc-main");
    });
    expect(screen.getByTestId("tv-range-selector")).toBeInTheDocument();

    // Open Config Drawer -> 1-click presets visible, Admin Save form & Simulate hidden
    await user.click(screen.getByRole("button", { name: "Configure TV Display" }));
    expect(screen.getByTestId("tv-preset-btn-noc-main")).toBeInTheDocument();
    expect(screen.queryByTestId("tv-preset-admin-form")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tv-simulate-panel")).not.toBeInTheDocument();

    // 1-click switch to "Portrait Ops" updates URL to short ?preset=portrait-ops
    await user.click(screen.getByTestId("tv-preset-btn-portrait-ops"));
    expect(window.location.search).toBe("?preset=portrait-ops");
    unmount();

    // 2. Admin session (is_admin: true): shows Save Preset form & Simulate panel
    isAdmin = true;
    render(<NocTvWallboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId("tv-header-preset-select")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Configure TV Display" }));
    expect(screen.getByTestId("tv-preset-admin-form")).toBeInTheDocument();
    expect(screen.getByTestId("tv-simulate-panel")).toBeInTheDocument();

    await user.type(screen.getByLabelText("New preset name"), "Core Focus");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(reqLog).toContainEqual({
        method: "POST",
        url: "/api/tv/presets",
        body: expect.objectContaining({
          name: "Core Focus",
          is_default: true,
        }),
      });
    });
  });

  it("renders a clean SMOKER 3-zone topbar (Option A + Variant A1) without clutter, wrapping clock, or duplicate slide labels", async () => {
    const eightTargetSnapshot: MatrixSnapshot = {
      ...TV_SNAPSHOT,
      targets: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        ...TV_SNAPSHOT.targets[0],
        id: `t-${i}`,
        name: `Host ${i}`,
        host: `10.0.0.${i}`,
      })),
      cells: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        ...TV_SNAPSHOT.cells[0],
        target_id: `t-${i}`,
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(JSON.stringify(eightTargetSnapshot), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "3h", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
    window.history.replaceState(null, "", "/tv?cards=4");
    const { unmount } = render(<NocTvWallboardPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("tv-target-card")).toHaveLength(4);
    });

    // Clean brand title "SMOKER" (not "SMOKER TV DISPLAY")
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("SMOKER");
    expect(heading.textContent?.trim()).toBe("SMOKER");

    // Option A: removed noisy elements including Quick Layout icon, Per-Probe, Chime, Landscape badge
    expect(screen.queryByText(/Landscape 16:9/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("tv-layout-toggle-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tv-probe-mode-btn")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /alert chime/i })
    ).not.toBeInTheDocument();

    // Only 2 core KPIs in header (PROBES & OK, no INCIDENTS)
    const kpiBar = screen.getByTestId("tv-header-kpis");
    expect(kpiBar).toHaveTextContent("PROBES");
    expect(kpiBar).toHaveTextContent("OK");
    expect(kpiBar).not.toHaveTextContent(/INCIDENTS/i);

    // Alert badge hidden when all targets are healthy
    expect(screen.queryByTestId("tv-anomalies-btn")).not.toBeInTheDocument();

    // Unified slide control shows clean "1/2" without duplicate "GRID 1/2 · 1/2"
    const slideControl = screen.getByTestId("tv-slide-control");
    expect(slideControl).toHaveTextContent("1/2");
    expect(slideControl).not.toHaveTextContent(/GRID\s+1\/2\s*·\s*1\/2/i);

    // Single-line nowrap clock without 4-digit year
    const clock = screen.getByTestId("tv-header-clock");
    expect(clock.className).toContain("whitespace-nowrap");
    expect(clock.textContent).toMatch(/^\d{2}\s+[A-Z][a-z]{2}\s+·\s+\d{2}:\d{2}:\d{2}$/);
    unmount();

    // Variant A1: degraded-only target renders quiet amber "1 WARN" (no red alert box)
    const warnOnlySnap: MatrixSnapshot = {
      ...TV_SNAPSHOT,
      cells: TV_SNAPSHOT.cells.map((c, idx) =>
        idx === 0 ? { ...c, status: "degraded", p50_ms: 190, p95_ms: 240 } : c
      ),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(JSON.stringify(warnOnlySnap), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "3h", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
    window.history.replaceState(null, "", "/tv");
    render(<NocTvWallboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId("tv-anomalies-btn")).toHaveTextContent(/1\s+WARN/);
    });
    const warnBtn = screen.getByTestId("tv-anomalies-btn");
    expect(warnBtn).toHaveAttribute("data-severity", "warn");
    expect(warnBtn.className).toContain("bg-transparent");
    expect(warnBtn.className).toContain("text-amber-400");
  });

  it("supports /tv NOC keyboard shortcuts (arrows, Space pause, 1-7 range, 'a' impaired filter, Smart 2-step Esc, and '?' modal)", async () => {
    const eightSnapWithWarn: MatrixSnapshot = {
      ...TV_SNAPSHOT,
      targets: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        ...TV_SNAPSHOT.targets[0],
        id: `t-${i}`,
        name: `Host ${i}`,
        host: `10.0.0.${i}`,
      })),
      cells: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        ...TV_SNAPSHOT.cells[0],
        target_id: `t-${i}`,
        status: i === 1 ? "degraded" : "healthy",
        p50_ms: i === 1 ? 180 : 12,
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(JSON.stringify(eightSnapWithWarn), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "3h", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    window.history.replaceState(null, "", "/tv?cards=4&rotate=15");
    const user = userEvent.setup();
    render(<NocTvWallboardPage />);

    await waitFor(() => {
      expect(screen.getByTestId("tv-slide-control")).toHaveTextContent("1/2");
    });

    // ArrowRight / ArrowLeft switch slides
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("tv-slide-control")).toHaveTextContent("2/2");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("tv-slide-control")).toHaveTextContent("1/2");

    // Space toggles rotation pause/resume in slides mode
    expect(
      screen.getByRole("button", { name: "Pause rotation" })
    ).toBeInTheDocument();
    await user.keyboard(" ");
    expect(
      screen.getByRole("button", { name: "Resume rotation" })
    ).toBeInTheDocument();

    // 1-7 switches time range (1 -> 15m, 6 -> 24h)
    await user.keyboard("1");
    expect(screen.getByRole("button", { name: "15m" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await user.keyboard("6");
    expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // 'a' toggles impaired filter
    await user.keyboard("a");
    expect(screen.getByTestId("tv-anomalies-btn")).toHaveTextContent(/Filtered/);
    await user.keyboard("a");
    expect(screen.getByTestId("tv-anomalies-btn")).not.toHaveTextContent(/Filtered/);

    // Smart 2-step Esc in TV search bar: 1st Esc clears text, 2nd Esc closes bar
    await user.keyboard("/");
    const tvSearch = await screen.findByTestId("tv-search-input");
    tvSearch.focus();
    await user.type(tvSearch, "Host 1");
    expect(tvSearch).toHaveValue("Host 1");
    await user.keyboard("{Escape}");
    expect(tvSearch).toHaveValue("");
    expect(screen.getByTestId("tv-search-bar")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("tv-search-bar")).not.toBeInTheDocument();

    // '?' opens shortcuts cheatsheet on /tv without adding a topbar button
    expect(screen.queryByTestId("noc-shortcuts-btn")).not.toBeInTheDocument();
    await user.keyboard("?");
    expect(
      await screen.findByTestId("keyboard-shortcuts-modal")
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByTestId("keyboard-shortcuts-modal")
    ).not.toBeInTheDocument();
  });

  it("supports 3d, 30d, and Custom Date Range via clean TimeRangePicker without persisting custom dates to localStorage", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.startsWith("/api/tv/matrix")) {
          return new Response(JSON.stringify(TV_SNAPSHOT), { status: 200 });
        }
        if (url.startsWith("/api/tv/series")) {
          return new Response(JSON.stringify({ range: "custom", targets: {} }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<NocTvWallboardPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("tv-target-card").length).toBeGreaterThan(0);
    });

    // Open More popover on /tv -> choose 3d (3 days)
    await user.click(screen.getByTestId("tv-range-selector-more-btn"));
    expect(screen.getByTestId("tv-range-selector-popover").textContent).not.toMatch(
      /Auto resolution|agg_5m/i
    );
    await user.click(screen.getByTestId("tv-range-selector-preset-3d"));
    expect(screen.getByTestId("tv-range-selector-more-btn")).toHaveTextContent("3d");
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes("/api/tv/series?range=3d"))).toBe(true);
    });

    // Keyboard shortcut '9' switches directly to 30d (1 Month)
    await user.keyboard("9");
    expect(screen.getByTestId("tv-range-selector-more-btn")).toHaveTextContent("30d");
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes("/api/tv/series?range=30d"))).toBe(true);
    });

    // Apply Custom Date Range -> switches badge to HISTORICAL, syncs URL, and does NOT store custom dates in localStorage
    await user.click(screen.getByTestId("tv-range-selector-more-btn"));
    fireEvent.change(screen.getByTestId("tv-range-selector-from-input"), {
      target: { value: "2026-11-18T08:00" },
    });
    fireEvent.change(screen.getByTestId("tv-range-selector-to-input"), {
      target: { value: "2026-11-19T14:00" },
    });
    await user.click(screen.getByTestId("tv-range-selector-apply-btn"));

    const histBadge = await screen.findByTestId("tv-historical-badge");
    expect(histBadge).toHaveTextContent("HISTORICAL");
    expect(window.location.search).toMatch(/from=\d+&to=\d+/);
    const storedObj = JSON.parse(
      window.localStorage.getItem("smoker.tv.config.v1") ?? "{}"
    );
    expect(storedObj.range).toBe("30d");
    expect(storedObj.fromSec).toBeUndefined();
    expect(storedObj.toSec).toBeUndefined();
    expect(storedObj.customWindow).toBeUndefined();
    await waitFor(() => {
      expect(
        requestedUrls.some((u) => u.includes("/api/tv/series?from=") && u.includes("&to="))
      ).toBe(true);
    });

    // Clicking HISTORICAL badge returns cleanly to Live rolling mode
    await user.click(histBadge);
    expect(screen.queryByTestId("tv-historical-badge")).not.toBeInTheDocument();
    expect(window.location.search).not.toContain("from=");

    // Re-clicking the currently active preset triggers a fresh /api/tv/series fetch
    await user.click(screen.getByRole("button", { name: "3h" }));
    await waitFor(() => {
      expect(
        requestedUrls.filter((u) => u.includes("/api/tv/series?range=3h")).length
      ).toBeGreaterThanOrEqual(1);
    });
    const countBeforeReclick = requestedUrls.filter((u) =>
      u.includes("/api/tv/series?range=3h")
    ).length;
    await user.click(screen.getByRole("button", { name: "3h" }));
    await waitFor(() => {
      expect(
        requestedUrls.filter((u) => u.includes("/api/tv/series?range=3h")).length
      ).toBeGreaterThan(countBeforeReclick);
    });
  });
});
