import { describe, expect, it } from "vitest";
import {
  computeBestFitGrid,
  parseTvConfig,
  partitionTargetsForTv,
  selectFocalProbeCell,
  serializeTvConfig,
  UNGROUPED_GROUP_TOKEN,
} from "./tv-config";
import type { MatrixCell, Target } from "./api";

function makeTarget(
  id: string,
  name: string,
  groupId: string | null = null,
  pinnedOnTv = false,
  probeType: Target["probe_type"] = "icmp",
  host = "1.1.1.1"
): Target {
  return {
    id,
    group_id: groupId,
    name,
    host,
    probe_type: probeType,
    port_or_path: "",
    interval_sec: 1,
    timeout_ms: 1000,
    enabled: true,
    auto_mtr_on_loss: true,
    mtr_loss_threshold: 3,
    pinned_on_tv: pinnedOnTv,
    latency_warn_ms: 0,
    probe_latency_overrides: {},
    assign_all_probes: true,
    probe_ids: [],
    created_at: "2026-11-15T00:00:00Z",
    updated_at: "2026-11-15T00:00:00Z",
  };
}

function makeCell(
  targetId: string,
  status: MatrixCell["status"],
  lossPct = 0,
  p50: number | null = 10
): MatrixCell {
  return {
    target_id: targetId,
    probe_id: "p1",
    p50_ms: p50,
    p95_ms: p50 !== null ? p50 + 5 : null,
    jitter_ms: 1,
    loss_pct: lossPct,
    sample_count: 10,
    status,
    sparkline: [],
  };
}

describe("tv-config helpers", () => {
  it("parses and serializes URL query parameters cleanly", () => {
    const cfg = parseTvConfig(
      "?orientation=portrait&groups=g1,g2&rotate=30&cards=8&range=6h&sound=1"
    );
    expect(cfg).toEqual({
      orientation: "portrait",
      groups: ["g1", "g2"],
      protocols: [],
      ipVersion: "all",
      splitByProtocol: false,
      rotateSec: 30,
      cardsPerPage: 8,
      range: "6h",
      sound: true,
    });

    const qs = serializeTvConfig(cfg);
    expect(qs).toBe(
      "orientation=portrait&groups=g1%2Cg2&rotate=30&cards=8&range=6h&sound=1"
    );

    const protoCfg = parseTvConfig(
      "?groups=ungrouped,g-custom&protocols=icmp,dns&ip=ipv6&split=protocol"
    );
    expect(protoCfg.groups).toEqual(["ungrouped", "g-custom"]);
    expect(protoCfg.protocols).toEqual(["icmp", "dns"]);
    expect(protoCfg.ipVersion).toBe("ipv6");
    expect(protoCfg.splitByProtocol).toBe(true);
    expect(serializeTvConfig(protoCfg)).toContain("protocols=icmp%2Cdns");
    expect(serializeTvConfig(protoCfg)).toContain("ip=ipv6");
    expect(serializeTvConfig(protoCfg)).toContain("split=protocol");
  });

  it("falls back to safe defaults on invalid query values and keeps rotation static by default", () => {
    const fresh = parseTvConfig("");
    expect(fresh.rotateSec).toBe(0);

    const cfg = parseTvConfig("?orientation=weird&rotate=999&cards=3&range=99y");
    expect(cfg.orientation).toBe("landscape");
    expect(cfg.rotateSec).toBe(0);
    expect(cfg.cardsPerPage).toBe(0);
    expect(cfg.range).toBe("3h");
    expect(cfg.sound).toBe(false);
    expect(serializeTvConfig(cfg)).toContain("cards=auto");
    expect(serializeTvConfig(cfg)).toContain("rotate=0");

    const autoParsed = parseTvConfig("?cards=auto");
    expect(autoParsed.cardsPerPage).toBe(0);
  });

  it("computes balanced ~7:3 best-fit grids across 1024x768, 1024x600, 1920x1080, and portrait", () => {
    const xga = computeBestFitGrid({
      width: 1004,
      height: 676,
      orientation: "landscape",
    });
    expect(xga.cols).toBe(2);
    expect(xga.rows).toBe(2);
    expect(xga.cardsPerPage).toBe(4);
    expect(xga.aspectRatio).toBeGreaterThanOrEqual(2.0);
    expect(xga.aspectRatio).toBeLessThanOrEqual(2.7);
    expect(xga.rows * xga.cardHeight + 10 * (xga.rows - 1)).toBeLessThanOrEqual(676);

    const netbook1024 = computeBestFitGrid({
      width: 1004,
      height: 508,
      orientation: "landscape",
    });
    expect(netbook1024.cols).toBe(2);
    expect(netbook1024.rows).toBe(2);
    expect(netbook1024.cardsPerPage).toBe(4);
    expect(netbook1024.rows * netbook1024.cardHeight + 10).toBeLessThanOrEqual(508);

    const fhd = computeBestFitGrid({
      width: 1900,
      height: 988,
      orientation: "landscape",
    });
    expect(fhd.cols).toBe(4);
    expect(fhd.rows).toBe(3);
    expect(fhd.cardsPerPage).toBe(12);
    expect(fhd.aspectRatio).toBeGreaterThanOrEqual(2.1);
    expect(fhd.aspectRatio).toBeLessThanOrEqual(2.6);
    expect(fhd.rows * fhd.cardHeight + 10 * (fhd.rows - 1)).toBeLessThanOrEqual(988);

    const portrait = computeBestFitGrid({
      width: 1060,
      height: 1828,
      orientation: "portrait",
    });
    expect(portrait.cols).toBe(2);
    expect(portrait.rows).toBeGreaterThanOrEqual(5);
    expect(portrait.aspectRatio).toBeGreaterThanOrEqual(2.0);
    expect(portrait.aspectRatio).toBeLessThanOrEqual(2.6);

    const manualSix = computeBestFitGrid({
      width: 1900,
      height: 988,
      orientation: "landscape",
      cardsOverride: 6,
    });
    expect(manualSix.cols).toBe(3);
    expect(manualSix.rows).toBe(2);
    expect(manualSix.cardsPerPage).toBe(6);
    expect(manualSix.aspectRatio).toBeGreaterThanOrEqual(2.1);
    expect(manualSix.aspectRatio).toBeLessThanOrEqual(2.6);
  });

  it("selects worst impaired probe or preferred probe cleanly", () => {
    const c1 = makeCell("t1", "healthy", 0, 12);
    c1.probe_id = "p-jkt";
    const c2 = makeCell("t1", "degraded", 0, 120);
    c2.probe_id = "p-sg";
    const c3 = makeCell("t1", "loss", 20, 45);
    c3.probe_id = "p-tyo";

    expect(selectFocalProbeCell([c1, c2, c3])?.probe_id).toBe("p-tyo");
    expect(selectFocalProbeCell([c1, c2, c3], "p-jkt")?.probe_id).toBe("p-jkt");
  });

  it("pins down/loss/degraded targets in severity order and paginates cards", () => {
    const targets = [
      makeTarget("t1", "Healthy DNS", "g1"),
      makeTarget("t2", "Degraded Edge", "g1"),
      makeTarget("t3", "Down Core", "g1"),
      makeTarget("t4", "Lossy Link", "g2"),
    ];
    const cells = [
      makeCell("t1", "healthy", 0, 8),
      makeCell("t2", "degraded", 0, 180),
      makeCell("t3", "down", 100, null),
      makeCell("t4", "loss", 25, 40),
    ];

    const res = partitionTargetsForTv(targets, cells, {
      groups: [],
      cardsPerPage: 2,
    });

    expect(res.pinnedAlerts.map((a) => a.target.id)).toEqual(["t3", "t4", "t2"]);
    expect(res.pages.length).toBe(2);
    expect(res.pages[0].length).toBe(2);
    expect(res.pages[1].length).toBe(2);
    expect(res.slides.length).toBe(3); // 2 regular grid slides + 1 highlight slide
    expect(res.slides[0].kind).toBe("grid");
    expect(res.slides[2].kind).toBe("highlight");
    expect(res.highlightSlideIdx).toBe(2);

    const g1Only = partitionTargetsForTv(targets, cells, {
      groups: ["g1"],
      cardsPerPage: 4,
    });
    expect(g1Only.totalFiltered).toBe(3);
    expect(g1Only.pinnedAlerts.map((a) => a.target.id)).toEqual(["t3", "t2"]);
  });

  it("includes VIP pinned targets on the highlight slide even when healthy", () => {
    const targets = [
      makeTarget("t1", "VIP Google DNS", "g1", true),
      makeTarget("t2", "Regular Host", "g1", false),
    ];
    const cells = [
      makeCell("t1", "healthy", 0, 8),
      makeCell("t2", "healthy", 0, 12),
    ];
    const res = partitionTargetsForTv(targets, cells, {
      groups: [],
      cardsPerPage: 6,
    });
    expect(res.pinnedAlerts.length).toBe(0);
    expect(res.highlightItems.map((h) => h.target.id)).toEqual(["t1"]);
    expect(res.slides[0].kind).toBe("grid");
    expect(res.slides[1].kind).toBe("highlight");
    expect(res.highlightSlideIdx).toBe(1);
  });

  it("supports ungrouped targets, protocol focus filtering, and separate protocol slides", () => {
    const targets = [
      makeTarget("t-ungrouped", "Custom Cloudflare", null, false, "icmp", "1.1.1.1"),
      makeTarget("t-icmp6", "Google DNSv6", "g-v6", false, "icmp6", "2001:4860:4860::8888"),
      makeTarget("t-dns1", "CF Query", "g-dns", false, "dns", "1.1.1.1"),
      makeTarget("t-dns2", "Google Query", "g-dns", false, "dns", "8.8.8.8"),
      makeTarget("t-http", "Cloudflare Edge", "g-apps", false, "http", "https://1.1.1.1/cdn-cgi/trace"),
    ];
    const cells = targets.map((t) => makeCell(t.id, "healthy", 0, 10));

    // Selecting "ungrouped" includes targets where group_id === null
    const ungroupedOnly = partitionTargetsForTv(targets, cells, {
      groups: [UNGROUPED_GROUP_TOKEN],
      cardsPerPage: 4,
    });
    expect(ungroupedOnly.totalFiltered).toBe(1);
    expect(ungroupedOnly.slides[0].items.map((it) => it.target.id)).toEqual(["t-ungrouped"]);

    // Filtering by protocol family ("dns") + IPv4 keeps only DNS v4 queries
    const dnsOnly = partitionTargetsForTv(targets, cells, {
      groups: [],
      protocols: ["dns"],
      ipVersion: "ipv4",
      cardsPerPage: 4,
    });
    expect(dnsOnly.totalFiltered).toBe(2);
    expect(dnsOnly.slides[0].items.map((it) => it.target.id)).toEqual(["t-dns1", "t-dns2"]);

    // Splitting slides by protocol separates ICMP, DNS Query, and HTTP onto distinct slides
    const splitRes = partitionTargetsForTv(targets, cells, {
      groups: [],
      splitByProtocol: true,
      cardsPerPage: 1,
    });
    expect(splitRes.slides.map((s) => s.label)).toEqual([
      "ICMP 1/2",
      "ICMP 2/2",
      "DNS QUERY 1/2",
      "DNS QUERY 2/2",
      "HTTP 1/1",
    ]);
  });
});
