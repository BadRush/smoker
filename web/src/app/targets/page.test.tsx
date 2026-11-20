import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TargetsPage from "./page";
import type { Probe, Target, TargetGroup } from "@/lib/api";

const mockRouter = { replace: vi.fn(), push: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/targets",
}));

function makeTargets(): Target[] {
  const list: Target[] = [];
  for (let i = 1; i <= 25; i++) {
    const pad = String(i).padStart(2, "0");
    list.push({
      id: `t-${pad}`,
      group_id: i <= 15 ? "g-dns" : i <= 22 ? "g-core" : null,
      name: i === 23 ? "Paused Edge Node" : `Monitor Node ${pad}`,
      host: i <= 10 ? `10.0.0.${i}` : `2001:4860::${i}`,
      probe_type: i <= 12 ? "icmp" : i <= 20 ? "dns" : "http6",
      port_or_path: i > 12 && i <= 20 ? `service${i}.example.com|A` : "",
      interval_sec: i === 2 ? 5 : 1,
      timeout_ms: 1000,
      enabled: i !== 23,
      auto_mtr_on_loss: i !== 23,
      mtr_loss_threshold: 3,
      pinned_on_tv: i === 5,
      latency_warn_ms: 0,
      probe_latency_overrides: {},
      assign_all_probes: i !== 24,
      probe_ids: i === 24 ? ["p-sgp"] : [],
      created_at: `2026-11-16T00:${pad}:00Z`,
      updated_at: `2026-11-16T00:${pad}:00Z`,
    });
  }
  return list;
}

const GROUPS: TargetGroup[] = [
  { id: "g-dns", name: "Public DNS", description: "", sort_order: 1, created_at: "" },
  { id: "g-core", name: "Core Backbone", description: "", sort_order: 2, created_at: "" },
];

const PROBES: Probe[] = [
  {
    id: "p-local",
    name: "Local Central",
    location_label: "Jakarta",
    isp_asn: "LOCAL",
    is_local: true,
    status: "online",
    pending_backlog_count: 0,
    clock_offset_ms: 0,
    last_seen_at: "2026-11-16T00:00:00Z",
    agent_version: "1.0.0",
    created_at: "",
  },
  {
    id: "p-sgp",
    name: "Remote-SGP",
    location_label: "Singapore",
    isp_asn: "AS13335",
    is_local: false,
    status: "online",
    pending_backlog_count: 0,
    clock_offset_ms: 0,
    last_seen_at: "2026-11-16T00:00:00Z",
    agent_version: "1.0.0",
    created_at: "",
  },
];

describe("TargetsPage search, filters, and pagination", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/targets");
    const mockTargets = makeTargets();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/targets") {
          return new Response(JSON.stringify(mockTargets), { status: 200 });
        }
        if (url === "/api/groups") {
          return new Response(JSON.stringify(GROUPS), { status: 200 });
        }
        if (url === "/api/probes") {
          return new Response(JSON.stringify(PROBES), { status: 200 });
        }
        return new Response(JSON.stringify({ username: "admin" }), { status: 200 });
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("paginates 25 targets cleanly at 20/page, supports page size change, and filters by category, group, status, probe, and search", async () => {
    const user = userEvent.setup();
    render(<TargetsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("target-row")).toHaveLength(20);
    });
    expect(screen.getByTestId("targets-pagination-summary")).toHaveTextContent(
      "Showing 1–20 of 25 targets"
    );

    // Go to Page 2 -> remaining 5 rows shown
    await user.click(screen.getByTestId("targets-page-2"));
    expect(screen.getAllByTestId("target-row")).toHaveLength(5);
    expect(screen.getByTestId("targets-pagination-summary")).toHaveTextContent(
      "Showing 21–25 of 25 targets"
    );

    // Change page size to 10/page -> resets to Page 1 with 10 rows & 3 total pages
    await user.selectOptions(screen.getByTestId("targets-page-size"), "10");
    expect(screen.getAllByTestId("target-row")).toHaveLength(10);
    expect(screen.getByTestId("targets-page-3")).toBeInTheDocument();

    // Filter by category: DNS Query (8 items: t-13..t-20)
    await user.click(screen.getByTestId("targets-proto-dns"));
    expect(screen.getAllByTestId("target-row")).toHaveLength(8);
    expect(screen.getByTestId("targets-pagination-summary")).toHaveTextContent(
      "Showing 1–8 of 8 targets (filtered from 25)"
    );

    // Search inside DNS by port_or_path domain
    await user.type(screen.getByTestId("targets-search-input"), "service15.example.com");
    expect(screen.getAllByTestId("target-row")).toHaveLength(1);
    expect(screen.getByText("Monitor Node 15")).toBeInTheDocument();

    // Reset all filters
    await user.click(screen.getByTestId("targets-reset-filters-btn"));
    expect(screen.getAllByTestId("target-row")).toHaveLength(10);

    // Filter by Status = Paused Only -> Paused Edge Node
    await user.selectOptions(screen.getByTestId("targets-status-filter"), "paused");
    expect(screen.getAllByTestId("target-row")).toHaveLength(1);
    expect(screen.getByText("Paused Edge Node")).toBeInTheDocument();

    // Reset & click Ungrouped pill -> t-23, t-24, t-25 (3 items)
    await user.click(screen.getByTestId("targets-reset-filters-btn"));
    await user.click(screen.getByTestId("targets-group-pill-ungrouped"));
    expect(screen.getAllByTestId("target-row")).toHaveLength(3);

    // Further filter by Probe = Custom Assigned Only -> t-24 (1 item) & displays probe name
    await user.selectOptions(screen.getByTestId("targets-probe-filter"), "custom");
    expect(screen.getAllByTestId("target-row")).toHaveLength(1);
    expect(screen.getByText("Monitor Node 24")).toBeInTheDocument();
    expect(screen.getByText("Remote-SGP")).toBeInTheDocument();
  });

  it("validates non-empty probe selection, filters per-probe overrides, and supports Select All / Clear in target modal", async () => {
    const user = userEvent.setup();
    render(<TargetsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("target-row")).toHaveLength(20);
    });

    await user.click(screen.getByRole("button", { name: "Add Target" }));
    await user.type(screen.getByLabelText("Target Name *"), "Branch Probe Target");
    await user.type(screen.getByLabelText("Host / IP / URL *"), "10.99.0.1");

    // Uncheck Assign to all active & future probes -> 0 selected
    await user.click(screen.getByLabelText("Assign to all active & future probes"));
    expect(screen.getByText("Select Probes (0 selected):")).toBeInTheDocument();
    // Per-Probe High-Latency Override should be hidden when 0 probes selected
    expect(screen.queryByRole("spinbutton", { name: "Local Central" })).not.toBeInTheDocument();

    // Submit without selecting any probe -> shows validation error
    await user.click(screen.getByRole("button", { name: "Save & Sync to Probes" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Select at least one probe when 'Assign to all active & future probes' is unchecked."
    );

    // Select All -> both probes checked & overrides appear
    await user.click(screen.getByRole("button", { name: "Select All" }));
    expect(screen.getByText("Select Probes (2 selected):")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Local Central" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Remote-SGP" })).toBeInTheDocument();

    // Clear -> back to 0 selected, then pick only Remote-SGP
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Select Probes (0 selected):")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Remote-SGP" }));
    expect(screen.getByText("Select Probes (1 selected):")).toBeInTheDocument();
    expect(screen.getByText(/Only 1 probe assigned/)).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Local Central" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Remote-SGP" })).toBeInTheDocument();
  });

  it("supports quick 1h maintenance mute and unmute actions on target rows", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const mockTargets = makeTargets();
    mockTargets[0].muted_until = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST") {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ method, url, body });
          if (url === "/api/targets/t-01/mute") {
            mockTargets[0] = {
              ...mockTargets[0],
              muted_until:
                body?.duration === "off" ? null : "2099-01-01T00:00:00Z",
            };
            return new Response(JSON.stringify(mockTargets[0]), { status: 200 });
          }
        }
        if (url === "/api/targets") {
          return new Response(JSON.stringify(mockTargets), { status: 200 });
        }
        if (url === "/api/groups") {
          return new Response(JSON.stringify(GROUPS), { status: 200 });
        }
        if (url === "/api/probes") {
          return new Response(JSON.stringify(PROBES), { status: 200 });
        }
        return new Response(JSON.stringify({ username: "admin" }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<TargetsPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Mute target Monitor Node 01" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Mute target Monitor Node 01" }));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toEqual({
      method: "POST",
      url: "/api/targets/t-01/mute",
      body: { duration: "1h" },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Unmute target Monitor Node 01" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Unmute target Monitor Node 01" }));
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1]).toEqual({
      method: "POST",
      url: "/api/targets/t-01/mute",
      body: { duration: "off" },
    });
  });

  it("defaults new target interval to 5s, displays Best-Path telemetry, and syncs Telegram RTT rule on save", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const mockTargets = makeTargets().slice(0, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST" || method === "PUT") {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ method, url, body });
          if (url === "/api/targets/t-01") {
            return new Response(JSON.stringify({ ...mockTargets[0], ...body }), {
              status: 200,
            });
          }
          if (url === "/api/alerts/rules") {
            return new Response(JSON.stringify({ id: "r-new", ...body }), {
              status: 201,
            });
          }
        }
        if (url === "/api/targets") {
          return new Response(JSON.stringify(mockTargets), { status: 200 });
        }
        if (url === "/api/groups") {
          return new Response(JSON.stringify(GROUPS), { status: 200 });
        }
        if (url === "/api/probes") {
          return new Response(JSON.stringify([PROBES[0]]), { status: 200 });
        }
        if (url === "/api/alerts/rules") {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url === "/api/matrix") {
          return new Response(
            JSON.stringify({
              generated_at: "",
              active_incidents: 0,
              probes: [PROBES[0]],
              groups: GROUPS,
              targets: mockTargets,
              cells: [
                {
                  target_id: "t-01",
                  probe_id: "p-local",
                  p50_ms: 7.0,
                  p95_ms: 14.0,
                  baseline_ms: 6.5,
                  warn_ms: 21.5,
                  jitter_ms: 0.5,
                  loss_pct: 0,
                  sample_count: 30,
                  status: "healthy",
                  sparkline: [],
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ username: "admin" }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<TargetsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("target-row")).toHaveLength(2);
    });

    // 1. Add Target defaults Interval (seconds) to 5
    await user.click(screen.getByRole("button", { name: "Add Target" }));
    const intervalInput = screen.getByLabelText("Interval (seconds)") as HTMLInputElement;
    expect(intervalInput.value).toBe("5");
    await user.click(screen.getByRole("button", { name: "Close modal" }));

    // 2. Edit Target shows live Best-Path & Fill button, and syncs Telegram High-Latency rule on Save
    await user.click(screen.getByRole("button", { name: "Edit target Monitor Node 01" }));
    expect(screen.getByTestId("target-bestpath-callout")).toHaveTextContent(
      /Live Best-Path P25: 6\.5 ms → Auto Warn: ~22 ms/
    );

    await user.click(screen.getByRole("button", { name: "Fill ~22 ms" }));
    expect((screen.getByLabelText("Warn RTT (0 = Auto)") as HTMLInputElement).value).toBe(
      "22"
    );

    await user.click(screen.getByLabelText("Sync Telegram RTT alert rule"));
    await user.click(screen.getByRole("button", { name: "Update & Sync to Probes" }));

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].url).toBe("/api/targets/t-01");
    expect(requests[1]).toEqual({
      method: "POST",
      url: "/api/alerts/rules",
      body: expect.objectContaining({
        target_id: "t-01",
        metric: "latency_p95",
        threshold_value: 22,
      }),
    });
  });

  it("supports Include in Alerting vs Monitoring Only checklist and quick Packet Loss rule creation", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const mockTargets = makeTargets().slice(0, 2);
    mockTargets[1].alerts_enabled = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST" || method === "PUT") {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ method, url, body });
          if (url === "/api/targets") {
            return new Response(
              JSON.stringify({
                ...mockTargets[0],
                id: "t-created",
                ...body,
              }),
              { status: 201 }
            );
          }
          if (url === "/api/alerts/rules") {
            return new Response(JSON.stringify({ id: "r-loss-new", ...body }), {
              status: 201,
            });
          }
        }
        if (url === "/api/targets") {
          return new Response(JSON.stringify(mockTargets), { status: 200 });
        }
        if (url === "/api/groups") {
          return new Response(JSON.stringify(GROUPS), { status: 200 });
        }
        if (url === "/api/probes") {
          return new Response(JSON.stringify([PROBES[0]]), { status: 200 });
        }
        if (url === "/api/alerts/rules") {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ username: "admin" }), { status: 200 });
      })
    );

    const user = userEvent.setup();
    render(<TargetsPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId("target-row")).toHaveLength(2);
    });
    // Row with alerts_enabled=false displays Monitor Only badge
    expect(screen.getByTestId("target-monitor-only-badge")).toHaveTextContent(
      "Monitor Only"
    );

    // 1. Add Target unchecked -> Monitoring Only (alerts_enabled: false)
    await user.click(screen.getByRole("button", { name: "Add Target" }));
    const alertCheck = screen.getByLabelText("Include target in alerting") as HTMLInputElement;
    expect(alertCheck.checked).toBe(true);

    await user.type(screen.getByLabelText("Target Name *"), "Passive Lab Switch");
    await user.type(screen.getByLabelText("Host / IP / URL *"), "10.10.0.50");
    await user.click(alertCheck);
    expect(screen.getByTestId("target-monitor-only-info")).toBeInTheDocument();
    expect(screen.queryByLabelText("Sync Telegram Loss alert rule")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save & Sync to Probes" }));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toEqual({
      method: "POST",
      url: "/api/targets",
      body: expect.objectContaining({
        name: "Passive Lab Switch",
        alerts_enabled: false,
      }),
    });

    // 2. Add Target checked + Sync Telegram Loss alert rule -> creates target (alerts_enabled: true) & loss_pct rule
    await user.click(screen.getByRole("button", { name: "Add Target" }));
    await user.type(screen.getByLabelText("Target Name *"), "Critical Core Link");
    await user.type(screen.getByLabelText("Host / IP / URL *"), "10.10.0.1");
    await user.click(screen.getByLabelText("Sync Telegram Loss alert rule"));
    await user.click(screen.getByRole("button", { name: "Save & Sync to Probes" }));

    await waitFor(() => {
      expect(requests).toHaveLength(3);
    });
    expect(requests[1]).toEqual({
      method: "POST",
      url: "/api/targets",
      body: expect.objectContaining({
        name: "Critical Core Link",
        alerts_enabled: true,
      }),
    });
    expect(requests[2]).toEqual({
      method: "POST",
      url: "/api/alerts/rules",
      body: expect.objectContaining({
        target_id: "t-created",
        metric: "loss_pct",
        threshold_value: 20,
      }),
    });
  });

  it("supports Ctrl+F / '/' search focus, Smart 2-step Esc, 'n' Add Target modal, and '?' shortcuts cheatsheet", async () => {
    const user = userEvent.setup();
    render(<TargetsPage />);

    const searchInput = await screen.findByTestId("targets-search-input");
    expect(searchInput).not.toHaveFocus();

    // Ctrl+F focuses targets search input
    await user.keyboard("{Control>}f{/Control}");
    expect(searchInput).toHaveFocus();

    // Type query -> 1st Esc clears query (keeps focus), 2nd Esc blurs
    await user.type(searchInput, "Cloudflare");
    expect(searchInput).toHaveValue("Cloudflare");
    await user.keyboard("{Escape}");
    expect(searchInput).toHaveValue("");
    expect(searchInput).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(searchInput).not.toHaveFocus();

    // 'n' opens Add Target modal; Ctrl+F yields while modal is open; Esc closes modal
    await user.keyboard("n");
    const nameInput = await screen.findByLabelText("Target Name *");
    expect(nameInput).toBeInTheDocument();

    await user.keyboard("{Control>}f{/Control}");
    expect(searchInput).not.toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Target Name *")).not.toBeInTheDocument();

    // '?' opens Keyboard Shortcuts cheatsheet and Esc closes it
    await user.keyboard("?");
    expect(
      await screen.findByTestId("keyboard-shortcuts-modal")
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByTestId("keyboard-shortcuts-modal")
    ).not.toBeInTheDocument();
  });
});
