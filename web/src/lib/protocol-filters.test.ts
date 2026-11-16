import { describe, expect, it } from "vitest";
import type { Target, TargetGroup } from "./api";
import {
  formatCleanTargetTitle,
  getProtocolFamily,
  groupItemsByProtocol,
  groupItemsByTargetGroup,
  isIpv6Target,
  matchesProtocolAndIpFilter,
} from "./protocol-filters";

function makeTarget(
  id: string,
  probeType: Target["probe_type"],
  host: string,
  groupId: string | null = null
): Target {
  return {
    id,
    group_id: groupId,
    name: `Target ${id}`,
    host,
    probe_type: probeType,
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
    created_at: "2026-11-16T00:00:00Z",
    updated_at: "2026-11-16T00:00:00Z",
  };
}

describe("protocol-filters helpers", () => {
  it("classifies IPv4 and IPv6 probe_types into functional protocol families", () => {
    expect(getProtocolFamily("icmp")).toBe("icmp");
    expect(getProtocolFamily("icmp6")).toBe("icmp");
    expect(getProtocolFamily("dns")).toBe("dns");
    expect(getProtocolFamily("dns6")).toBe("dns");
    expect(getProtocolFamily("http")).toBe("http");
    expect(getProtocolFamily("http6")).toBe("http");
    expect(getProtocolFamily("tcp")).toBe("tcp");
    expect(getProtocolFamily("tcp6")).toBe("tcp");
  });

  it("accurately detects IPv6 vs IPv4 targets across probe_type and hosts", () => {
    expect(isIpv6Target({ probe_type: "icmp6", host: "dns.google" })).toBe(true);
    expect(
      isIpv6Target({
        probe_type: "http",
        host: "https://[2606:4700:4700::1111]/cdn-cgi/trace",
      })
    ).toBe(true);
    expect(
      isIpv6Target({ probe_type: "icmp", host: "2001:4860:4860::8888" })
    ).toBe(true);

    expect(isIpv6Target({ probe_type: "icmp", host: "1.1.1.1" })).toBe(false);
    expect(
      isIpv6Target({ probe_type: "http", host: "https://1.1.1.1:8443/health" })
    ).toBe(false);
    expect(isIpv6Target({ probe_type: "tcp", host: "github.com" })).toBe(false);
  });

  it("filters by combined functional protocols and IP version", () => {
    const tIcmp4 = makeTarget("1", "icmp", "8.8.8.8");
    const tIcmp6 = makeTarget("2", "icmp6", "2001:4860:4860::8888");
    const tDns4 = makeTarget("3", "dns", "1.1.1.1");
    const tDns6 = makeTarget("4", "dns6", "2606:4700:4700::1111");
    const all = [tIcmp4, tIcmp6, tDns4, tDns6];

    expect(
      all
        .filter((t) => matchesProtocolAndIpFilter(t, ["dns"], "all"))
        .map((t) => t.id)
    ).toEqual(["3", "4"]);

    expect(
      all
        .filter((t) => matchesProtocolAndIpFilter(t, ["icmp", "dns"], "ipv6"))
        .map((t) => t.id)
    ).toEqual(["2", "4"]);

    expect(
      all
        .filter((t) => matchesProtocolAndIpFilter(t, [], "ipv4"))
        .map((t) => t.id)
    ).toEqual(["1", "3"]);
  });

  it("groups items cleanly by protocol family and by target group with Ungrouped last", () => {
    const targets = [
      makeTarget("http1", "http", "https://example.com", "g-apps"),
      makeTarget("dns1", "dns", "1.1.1.1", "g-dns"),
      makeTarget("icmp6", "icmp6", "2001:4860:4860::8888", null),
      makeTarget("tcp1", "tcp", "github.com", "g-apps"),
      makeTarget("icmp1", "icmp", "8.8.8.8", "g-dns"),
    ];

    const protoSections = groupItemsByProtocol(targets, (t) => t);
    expect(protoSections.map((s) => s.family.id)).toEqual([
      "icmp",
      "dns",
      "http",
      "tcp",
    ]);
    expect(protoSections[0].items.map((t) => t.id)).toEqual(["icmp6", "icmp1"]);

    const groups: TargetGroup[] = [
      { id: "g-dns", name: "Public DNS", description: "", sort_order: 1, created_at: "" },
      { id: "g-apps", name: "Public Apps", description: "", sort_order: 2, created_at: "" },
    ];
    const grpSections = groupItemsByTargetGroup(targets, (t) => t, groups);
    expect(grpSections.map((s) => s.id)).toEqual([
      "g-dns",
      "g-apps",
      "ungrouped",
    ]);
    expect(grpSections[2].items.map((t) => t.id)).toEqual(["icmp6"]);
  });

  it("strips redundant trailing protocol labels while keeping custom suffixes", () => {
    expect(formatCleanTargetTitle("Cloudflare DNSv6 (ICMP6)", "icmp6")).toBe(
      "Cloudflare DNSv6"
    );
    expect(formatCleanTargetTitle("Google DNS (Query)", "dns")).toBe(
      "Google DNS"
    );
    expect(formatCleanTargetTitle("GitHub (TLS 443)", "tcp")).toBe(
      "GitHub (TLS 443)"
    );
    expect(formatCleanTargetTitle("dns cloudflare", "icmp")).toBe(
      "dns cloudflare"
    );
  });
});
