import { describe, expect, it } from "vitest";
import type { Target, TargetGroup } from "./api";
import {
  computeVisiblePageNumbers,
  DEFAULT_TARGET_FILTERS,
  filterAndSortTargets,
  orderTargetsForSections,
  paginateItems,
  parseTargetTableFilters,
  serializeTargetTableFilters,
} from "./target-table";

function makeTarget(
  id: string,
  name: string,
  overrides: Partial<Target> = {}
): Target {
  return {
    id,
    group_id: null,
    name,
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
    ...overrides,
  };
}

describe("target-table helpers", () => {
  const groups: TargetGroup[] = [
    { id: "g-dns", name: "Public DNS", description: "", sort_order: 1, created_at: "" },
    { id: "g-core", name: "Core Backbone", description: "", sort_order: 2, created_at: "" },
  ];
  const groupMap = new Map(groups.map((g) => [g.id, g.name]));

  const sampleTargets: Target[] = [
    makeTarget("1", "Alpha Ping", { group_id: "g-core", probe_type: "icmp", host: "10.0.0.1", interval_sec: 1, created_at: "2026-11-15T01:00:00Z" }),
    makeTarget("2", "Cloudflare Query", { group_id: "g-dns", probe_type: "dns", host: "1.1.1.1", port_or_path: "cloudflare.com|A", interval_sec: 2, pinned_on_tv: true, created_at: "2026-11-15T03:00:00Z" }),
    makeTarget("3", "Paused Edge", { group_id: "g-core", probe_type: "http", host: "https://edge.local", enabled: false, auto_mtr_on_loss: false, assign_all_probes: false, probe_ids: ["p-sgp"], interval_sec: 5, created_at: "2026-11-15T02:00:00Z" }),
    makeTarget("4", "IPv6 Core", { group_id: null, probe_type: "icmp6", host: "2001:4860:4860::8888", assign_all_probes: false, probe_ids: ["p-jkt"], interval_sec: 1, created_at: "2026-11-15T04:00:00Z" }),
  ];

  it("parses and serializes URL filters while preserving ?edit param", () => {
    const parsed = parseTargetTableFilters(
      "?edit=t-1&q=cloudflare&group=ungrouped&proto=icmp,dns&ip=ipv6&status=vip&probe=p-jkt&groupBy=group&sort=newest&page=3&limit=50"
    );
    expect(parsed).toEqual({
      q: "cloudflare",
      group: "ungrouped",
      protocols: ["icmp", "dns"],
      ipVersion: "ipv6",
      status: "vip",
      probeId: "p-jkt",
      groupBy: "group",
      sortBy: "newest",
      page: 3,
      pageSize: 50,
    });

    const qs = serializeTargetTableFilters(parsed, "?edit=t-1&q=old");
    expect(qs).toContain("edit=t-1");
    expect(qs).toContain("q=cloudflare");
    expect(qs).toContain("group=ungrouped");
    expect(qs).toContain("proto=icmp%2Cdns");
    expect(qs).toContain("limit=50");
    expect(qs).toContain("page=3");
  });

  it("filters across search text (name, port_or_path, groupName), status, probe, and sorts cleanly", () => {
    // Search by port_or_path DNS record
    const byQueryDomain = filterAndSortTargets(sampleTargets, groupMap, {
      ...DEFAULT_TARGET_FILTERS,
      q: "cloudflare.com",
    });
    expect(byQueryDomain.map((t) => t.id)).toEqual(["2"]);

    // Search by group name
    const byGroupName = filterAndSortTargets(sampleTargets, groupMap, {
      ...DEFAULT_TARGET_FILTERS,
      q: "Core Backbone",
    });
    expect(byGroupName.map((t) => t.id)).toEqual(["1", "3"]);

    // Status filter: paused only
    const pausedOnly = filterAndSortTargets(sampleTargets, groupMap, {
      ...DEFAULT_TARGET_FILTERS,
      status: "paused",
    });
    expect(pausedOnly.map((t) => t.id)).toEqual(["3"]);

    // Status filter: VIP TV
    const vipOnly = filterAndSortTargets(sampleTargets, groupMap, {
      ...DEFAULT_TARGET_FILTERS,
      status: "vip",
    });
    expect(vipOnly.map((t) => t.id)).toEqual(["2"]);

    // Probe filter: custom assigned only
    const customProbeOnly = filterAndSortTargets(sampleTargets, groupMap, {
      ...DEFAULT_TARGET_FILTERS,
      probeId: "custom",
    });
    expect(customProbeOnly.map((t) => t.id)).toEqual(["4", "3"]);

    // Probe filter: specific probe includes assign_all + explicit
    const sgpTargets = filterAndSortTargets(sampleTargets, groupMap, {
      ...DEFAULT_TARGET_FILTERS,
      probeId: "p-sgp",
      sortBy: "newest",
    });
    expect(sgpTargets.map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  it("orders contiguously for section grouping, paginates accurately, and formats page numbers", () => {
    const orderedByProto = orderTargetsForSections(
      sampleTargets,
      groups,
      "protocol"
    );
    expect(orderedByProto.map((t) => t.id)).toEqual(["1", "4", "2", "3"]);

    const page1 = paginateItems(orderedByProto, 1, 2 as never);
    const tenPerPage = paginateItems(
      Array.from({ length: 25 }, (_, i) => i),
      2,
      10
    );
    expect(tenPerPage.pageItems).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(tenPerPage.startIdx).toBe(11);
    expect(tenPerPage.endIdx).toBe(20);
    expect(tenPerPage.totalPages).toBe(3);

    // Clamps out-of-range page safely & supports All (0)
    const clamped = paginateItems(orderedByProto, 99, 10);
    expect(clamped.safePage).toBe(1);
    expect(page1.totalItems).toBe(4);
    expect(paginateItems(orderedByProto, 1, 0).pageItems.length).toBe(4);

    expect(computeVisiblePageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(computeVisiblePageNumbers(5, 10)).toEqual([
      1,
      "ellipsis",
      4,
      5,
      6,
      "ellipsis",
      10,
    ]);
  });
});
