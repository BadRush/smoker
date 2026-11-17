import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AlertsPage from "./page";
import type {
  AlertChannel,
  AlertRule,
  Incident,
  Probe,
  Target,
  TargetGroup,
} from "@/lib/api";

const mockRouter = { replace: vi.fn(), push: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/alerts",
}));

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

const GROUPS: TargetGroup[] = [
  {
    id: "g-core",
    name: "Core Links",
    parent_id: null,
    description: "",
    sort_order: 1,
    created_at: "",
  },
];

const TARGETS: Target[] = [
  {
    id: "t-single",
    group_id: "g-core",
    name: "Single-Probe Target",
    host: "10.10.10.1",
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
    assign_all_probes: false,
    probe_ids: ["p-sgp"],
    created_at: "",
    updated_at: "",
  },
];

const RULES: AlertRule[] = [
  {
    id: "r-1",
    name: "Unreachable Quorum Rule",
    target_id: "t-single",
    group_id: null,
    metric: "loss_pct",
    threshold_value: 20,
    duration_sec: 30,
    quorum_min_probes: 2,
    cooldown_sec: 0,
    channel_ids: [],
    enabled: true,
    created_at: "",
  },
];

const CHANNELS: AlertChannel[] = [
  {
    id: "ch-existing",
    type: "telegram",
    name: "NOC Forum",
    config_hint: "chat:-100123 · thread:456",
    enabled: true,
    created_at: "2026-11-16T00:00:00Z",
  },
];

describe("AlertsPage quorum, routing, and Telegram channel controls", () => {
  let requests: Array<{ method: string; url: string; body: unknown }> = [];

  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST" || method === "PUT") {
          requests.push({
            method,
            url,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          if (url === "/api/alerts/channels") {
            return new Response(JSON.stringify(CHANNELS[0]), { status: 201 });
          }
          if (url.startsWith("/api/alerts/channels/")) {
            return new Response(JSON.stringify(CHANNELS[0]), { status: 200 });
          }
          if (url.startsWith("/api/alerts/rules")) {
            return new Response(JSON.stringify(RULES[0]), {
              status: method === "POST" ? 201 : 200,
            });
          }
        }
        if (url === "/api/alerts/incidents") {
          return new Response(JSON.stringify([] as Incident[]), { status: 200 });
        }
        if (url === "/api/alerts/rules") {
          return new Response(JSON.stringify(RULES), { status: 200 });
        }
        if (url === "/api/alerts/channels") {
          return new Response(JSON.stringify(CHANNELS), { status: 200 });
        }
        if (url === "/api/targets") {
          return new Response(JSON.stringify(TARGETS), { status: 200 });
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

  it("auto-adjusts quorum to 1 for single-probe target and warns if user raises quorum above assigned probes", async () => {
    const user = userEvent.setup();
    render(<AlertsPage />);

    await waitFor(() => {
      expect(screen.getByText("Unreachable Quorum Rule")).toBeInTheDocument();
    });

    // Existing rule with quorum 2 on 1-probe target displays warning badge
    expect(screen.getByText("Quorum 2 > 1 probe(s)")).toBeInTheDocument();

    // Selecting the 1-probe target auto-adjusts default quorum from 2 to 1
    const quorumInput = screen.getByLabelText("Quorum min probes") as HTMLInputElement;
    expect(quorumInput.value).toBe("2");

    await user.selectOptions(screen.getByLabelText("Target"), "t-single");
    expect(quorumInput.value).toBe("1");
    expect(screen.queryByTestId("alert-quorum-warning")).not.toBeInTheDocument();

    // Raising quorum to 2 displays non-blocking warning
    await user.clear(quorumInput);
    await user.type(quorumInput, "2");
    expect(screen.getByTestId("alert-quorum-warning")).toHaveTextContent(
      /Single-Probe Target.*is only assigned to 1 probe\(s\); quorum 2 will never trigger\./
    );
  });

  it("validates and submits optional Telegram thread_id and supports editing & toggling channels", async () => {
    const user = userEvent.setup();
    render(<AlertsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Telegram thread ID")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Channel name"), "NOC Forum");
    await user.type(screen.getByLabelText("Telegram bot token"), "123:ABC");
    await user.type(screen.getByLabelText("Telegram chat ID"), "-100123");
    await user.type(screen.getByLabelText("Telegram thread ID"), "abc");
    await user.click(screen.getByRole("button", { name: "Save Channel" }));
    expect(screen.getByText("Telegram Thread ID must be a positive integer.")).toBeInTheDocument();
    expect(requests).toHaveLength(0);

    await user.clear(screen.getByLabelText("Telegram thread ID"));
    await user.type(screen.getByLabelText("Telegram thread ID"), "456");
    await user.click(screen.getByRole("button", { name: "Save Channel" }));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toEqual({
      method: "POST",
      url: "/api/alerts/channels",
      body: {
        type: "telegram",
        name: "NOC Forum",
        bot_token: "123:ABC",
        chat_id: "-100123",
        thread_id: 456,
        webhook_url: "",
        enabled: true,
      },
    });

    // Toggle channel enabled -> PUT /api/alerts/channels/ch-existing
    await user.click(screen.getByRole("button", { name: "Disable channel NOC Forum" }));
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1]).toEqual({
      method: "PUT",
      url: "/api/alerts/channels/ch-existing",
      body: { enabled: false },
    });

    // Edit channel -> pre-fills Chat ID & Thread ID from config_hint without requiring re-typing Bot Token
    await user.click(screen.getByRole("button", { name: "Edit channel NOC Forum" }));
    expect((screen.getByLabelText("Telegram chat ID") as HTMLInputElement).value).toBe("-100123");
    expect((screen.getByLabelText("Telegram thread ID") as HTMLInputElement).value).toBe("456");
    await user.clear(screen.getByLabelText("Telegram thread ID"));
    await user.click(screen.getByRole("button", { name: "Update Channel" }));
    await waitFor(() => {
      expect(requests).toHaveLength(3);
    });
    expect(requests[2]).toEqual({
      method: "PUT",
      url: "/api/alerts/channels/ch-existing",
      body: {
        name: "NOC Forum",
        chat_id: "-100123",
        thread_id: null,
        enabled: true,
      },
    });
  });

  it("creates Global and Group rules with state-change cooldown (0) default and channel routing", async () => {
    const user = userEvent.setup();
    render(<AlertsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Rule scope")).toBeInTheDocument();
    });

    expect((screen.getByLabelText("Repeat reminder") as HTMLSelectElement).value).toBe("0");

    await user.type(screen.getByLabelText("Rule name"), "Global Down Alert");
    await user.selectOptions(screen.getByLabelText("Rule scope"), "global");
    await user.click(screen.getByLabelText("Route to channel NOC Forum"));
    await user.click(screen.getByRole("button", { name: "Add Rule" }));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]).toEqual({
      method: "POST",
      url: "/api/alerts/rules",
      body: {
        name: "Global Down Alert",
        target_id: null,
        group_id: null,
        metric: "loss_pct",
        threshold_value: 20,
        duration_sec: 30,
        quorum_min_probes: 2,
        cooldown_sec: 0,
        channel_ids: ["ch-existing"],
        enabled: true,
      },
    });
  });
});
